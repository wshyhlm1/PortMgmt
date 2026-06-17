import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PATHS,
  compactWhitespace,
  ensureDir,
  hashId,
  nowIso,
  pathExists,
  readJson,
  relativeToRoot,
  shortText,
  todayInZone,
  writeJson,
} from './shared.mjs';

const FILES = [
  ['structured', 'portmgmt_structured_data.json'],
  ['ai_models', 'ai_models.json'],
  ['us_tech_capex', 'us_tech_capex.json'],
  ['china_tech_capex', 'china_tech_capex.json'],
  ['semi_capex', 'semi_capex.json'],
  ['telecom_infra', 'telecom_infra.json'],
  ['consolidated_info_gaps', 'consolidated_info_gaps.json'],
];

async function main() {
  const env = await loadLocalEnv();
  const config = await readJson(PATHS.config, {});
  const importedAt = nowIso();
  const reportDate = todayInZone(config.report_timezone || process.env.REPORT_TZ || 'Asia/Shanghai');
  const companiesData = await readJson(path.join(PATHS.data, 'companies.json'), { companies: [] });
  const valuationVerifiedData = await readJson(path.join(PATHS.data, 'valuation_verified.json'), { rows: [] });
  const tracked = companiesData.companies || [];
  const valuationByTicker = groupBy(valuationVerifiedData.rows || valuationVerifiedData.verified || [], (row) => valuationTickerKey(row.ticker));
  const trackedByTicker = new Map(tracked.flatMap((company) => [
    [tickerKey(company.ticker), company],
    [tickerKey(company.display_ticker), company],
    [tickerKey(company.yfinance_ticker), company],
  ].filter(([key]) => key)));

  const inputs = [];
  const missingInputs = [];
  let hasStructuredInput = false;
  for (const [kind, fileName] of FILES) {
    const repoOnly = hasStructuredInput && kind !== 'structured';
    const file = await findInput(fileName, env, { repoOnly });
    if (!file) {
      missingInputs.push(fileName);
      continue;
    }
    const payload = await readJson(file, []);
    const rows = rowsFromPayload(payload, kind);
    inputs.push({ kind, file, rows });
    if (kind === 'structured' && rows.length) hasStructuredInput = true;
  }
  const missingSupplementalInputs = hasStructuredInput
    ? missingInputs.filter((file) => file === 'portmgmt_structured_data.json')
    : missingInputs;

  const facts = dedupeBy(
    inputs
      .filter((input) => input.kind !== 'ai_models')
      .flatMap((input) => input.rows.map((row) => normalizeFact(row, input))),
    (item) => `${item.ticker}|${item.field}|${item.value}|${item.period}|${item.source_url}`,
  );

  const existingModels = await readJson(path.join(PATHS.data, 'ai_models.json'), { ai_models: [] });
  const supplementalModels = inputs
    .filter((input) => input.kind === 'ai_models')
    .flatMap((input) => input.rows.map((row) => normalizeModel(row, input)));
  const aiModels = dedupeBy([...supplementalModels, ...(existingModels.ai_models || [])], (item) => `${item.provider}|${item.model_name}|${item.release_date}`);

  const existingCapex = await readJson(path.join(PATHS.data, 'ai_capex.json'), { ai_capex: [] });
  const supplementalCapex = facts
    .filter(isCapexRelevantFact)
    .map((fact) => normalizeCapexEntry(fact, trackedByTicker))
    .filter(Boolean);
  const aiCapex = dedupeBy([...supplementalCapex, ...(existingCapex.ai_capex || [])], (item) => `${item.category}|${item.ticker || item.company}|${item.field}|${item.value}|${item.period}`);

  const gaps = buildCompanyGaps(tracked, facts, valuationByTicker);
  const meta = {
    generated_at: importedAt,
    report_date: reportDate,
    source_note: '补充 JSON 导入；页面默认不展示 source_url/source_type/confidence。',
    inputs: inputs.map((input) => ({
      kind: input.kind,
      source_file: relativeOrAbsolute(input.file),
      rows: input.rows.length,
    })),
    missing_inputs: missingSupplementalInputs,
  };

  await ensureDir(PATHS.data);
  await writeJson(path.join(PATHS.data, 'supplemental_facts.json'), { meta, facts });
  await writeJson(path.join(PATHS.data, 'ai_models.json'), { meta, ai_models: aiModels });
  await writeJson(path.join(PATHS.data, 'ai_capex.json'), { meta, ai_capex: aiCapex });
  await writeJson(path.join(PATHS.data, 'company_gaps.json'), { meta, gaps });

  console.log(`Imported supplemental data: ${facts.length} facts, ${supplementalModels.length} model rows, ${supplementalCapex.length} capex rows.`);
  if (missingSupplementalInputs.length) console.warn(`Missing supplemental file(s): ${missingSupplementalInputs.join(', ')}`);
}

async function loadLocalEnv() {
  const envPath = path.join(PATHS.data, '..', '.env.local');
  try {
    const text = await fs.readFile(envPath, 'utf8');
    return Object.fromEntries(text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
      }));
  } catch {
    return {};
  }
}

async function findInput(fileName, env = {}, options = {}) {
  const supplementalDir = process.env.PORTMGMT_SUPPLEMENTAL_DIR || env.PORTMGMT_SUPPLEMENTAL_DIR || '';
  const candidates = [
    path.join(PATHS.data, 'supplemental', fileName),
    options.repoOnly ? null : (supplementalDir ? path.join(supplementalDir, fileName) : null),
    options.repoOnly ? null : path.join(PATHS.data, fileName),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function rowsFromPayload(payload, kind) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (kind === 'ai_models' && Array.isArray(payload?.ai_models)) return [];
  if (Array.isArray(payload?.ai_capex)) return [];
  return [];
}

function normalizeFact(row, input) {
  const rawTicker = row.ticker || row.company || '';
  const ticker = canonicalTicker(rawTicker, row.company);
  const field = compactWhitespace(row.field || row.status || 'supplemental_fact');
  const period = compactWhitespace(row['period/date'] || row.period_date || row.period || row.date || row.release_date || '');
  const value = compactWhitespace(row.value || row.model_name || row.key_capabilities || '');
  const notes = compactWhitespace(row.notes || row.commentary || row.summary || '');
  const sourceUrl = row.original_url || row.source_url || row.sourceUrl || null;
  return {
    id: `fact_${hashId(input.kind, ticker, field, value, period, sourceUrl)}`,
    ticker,
    display_ticker: displayTicker(ticker),
    company: compactWhitespace(row.company || companyFromTicker(ticker) || rawTicker),
    field,
    value: cleanDash(value),
    period: cleanDash(period),
    notes: cleanDash(notes),
    source_url: sourceUrl,
    original_url: sourceUrl,
    source_type: row.source_type || row.sourceType || input.kind,
    confidence: row.confidence || row.confidence_level || 'unknown',
    source_file: relativeOrAbsolute(input.file),
    source_dataset: input.kind,
  };
}

function normalizeModel(row, input) {
  const provider = normalizeProvider(row.provider || row.company);
  const sourceUrl = row.original_url || row.source_url || null;
  return {
    id: `model_${hashId(provider, row.model_name, row.release_date, sourceUrl)}`,
    provider,
    provider_group: modelProviderGroup(provider),
    model_name: compactWhitespace(row.model_name),
    release_date: cleanDash(row.release_date),
    status: row.status || 'unknown',
    key_capabilities: shortText(row.key_capabilities, 180),
    context_window: inferContextWindow(row.key_capabilities),
    multimodal: inferMultimodal(row.key_capabilities),
    api_pricing: cleanDash(row.api_pricing || row.pricing),
    next_generation: cleanDash(row.next_generation || row.follow_up || row.notes),
    compute_supply_chain_impact: shortText(row.compute_impact || row.compute_supply_chain_impact, 160),
    impacted_holdings: [],
    source: sourceUrl || relativeOrAbsolute(input.file),
    source_url: sourceUrl,
    original_url: sourceUrl,
    source_type: row.source_type || input.kind,
    confidence_level: row.confidence || row.confidence_level || 'unknown',
    validation_status: row.confidence ? 'supplemental' : 'needs_source',
    source_file: relativeOrAbsolute(input.file),
  };
}

function normalizeCapexEntry(fact, trackedByTicker) {
  const category = capexCategory(fact, trackedByTicker);
  if (!category) return null;
  const tracked = trackedByTicker.get(tickerKey(fact.ticker));
  return {
    id: `capex_${hashId(category, fact.ticker, fact.field, fact.value, fact.period)}`,
    category,
    ticker: fact.ticker,
    display_ticker: tracked?.display_ticker || fact.display_ticker,
    company: fact.company,
    field: fact.field,
    value: fact.value,
    period: fact.period,
    notes: fact.notes,
    original_url: fact.original_url,
    source_url: fact.source_url,
    source_type: fact.source_type,
    confidence: fact.confidence,
    source_file: fact.source_file,
    latest_quarter_capex: /quarterly|actual/i.test(fact.field) ? fact.value : null,
    capex_guidance: /guidance|plans|outlook/i.test(fact.field) ? fact.value : null,
    revision_direction: /revision|adjust/i.test(fact.field) ? inferRevision(fact) : 'unknown',
    ai_related_notes: shortText([fact.value, fact.notes].filter(Boolean).join('；'), 180),
    supply_chain_mapping: relatedHoldingsForCapex(fact),
    validation_status: 'supplemental',
  };
}

function buildCompanyGaps(companies, facts, valuationByTicker = {}) {
  const byTicker = groupBy(facts, (fact) => tickerKey(fact.ticker));
  return companies.map((company) => {
    const ticker = company.ticker;
    const companyFacts = byTicker[tickerKey(ticker)] || [];
    const valuationRows = valuationByTicker[valuationTickerKey(ticker)] || [];
    const valuationFields = new Set(valuationRows.map((row) => row.field || row.metric).filter(Boolean));
    const missing = [];
    for (const field of ['Forward PE', 'EV/EBITDA', 'FCF Yield']) {
      if (!valuationFields.has(field)) missing.push(field);
    }
    if (!valuationRows.length && !companyFacts.some((fact) => /valuation|PE|EV\/?EBITDA|FCF Yield/i.test(fact.field))) missing.push('可靠公开估值数据');
    if (!companyFacts.some((fact) => /quarter|latest|Q[1-4]|CAPEX|capital_expenditure/i.test(`${fact.field} ${fact.period}`))) missing.push('最近季度分项数据');
    if (!companyFacts.some((fact) => /guidance|outlook|指引/i.test(fact.field))) missing.push('管理层最新指引');
    const clean = [...new Set(missing)].slice(0, 5);
    const impact = gapImpact(clean);
    return {
      ticker,
      company: company.company_name || company.chinese_name || ticker,
      summary: clean.length
        ? `${ticker}：缺${clean.join('、')}；因此暂时无法判断${impact}。`
        : `${ticker}：本次补充资料未发现关键结构化缺口；仍需随财报更新估值与季度口径。`,
      fields: clean,
      source: 'consolidated_info_gaps + structured parser',
    };
  });
}

function gapImpact(fields = []) {
  const text = fields.join('、');
  const impacts = [];
  if (/Forward PE|PS|估值/.test(text)) impacts.push('短期估值是否已充分反映最新指引');
  if (/季度|分项/.test(text)) impacts.push('收入和利润率趋势是否延续');
  if (/指引/.test(text)) impacts.push('管理层对未来需求的确认程度');
  if (/CAPEX|capital_expenditure/.test(text)) impacts.push('AI投入对现金流的压力');
  return impacts.length ? impacts.join('、') : '核心基本面和估值结论';
}

function isCapexRelevantFact(fact) {
  return /(CAPEX|CapEx|capital_expenditure|capital expenditure|capacity|infrastructure|AI_|Management Guidance|Guidance Revision|Latest Quarterly|supply_chain|云|资本开支|产能)/i.test(`${fact.field} ${fact.value} ${fact.notes}`);
}

function capexCategory(fact, trackedByTicker) {
  if (isOverseasCsp(fact)) return 'hyperscaler';
  if (isChinaChain(fact)) return 'china';
  if (trackedByTicker.has(tickerKey(fact.ticker))) return 'holding_capex';
  if (/supply_chain|AI_supply_chain|capacity/i.test(fact.field)) return 'supply_chain_mapping';
  return null;
}

function isOverseasCsp(fact) {
  return /GOOGL|MSFT|AMZN|META|ORCL|NVDA/.test(fact.ticker) || /Alphabet|Google|Microsoft|Amazon|Meta|Oracle|NVIDIA/i.test(fact.company);
}

function isChinaChain(fact) {
  return /BABA|BIDU|0700|PRIVATE|ByteDance/.test(fact.ticker) || /Alibaba|Tencent|Baidu|ByteDance|字节|阿里|腾讯|百度/i.test(fact.company);
}

function relatedHoldingsForCapex(fact) {
  const text = `${fact.company} ${fact.value} ${fact.notes}`;
  const out = [];
  if (/Google|Microsoft|Amazon|Meta|Oracle|Alibaba|Tencent|Baidu|ByteDance|云|AI/i.test(text)) out.push('ASML', 'TSM', 'AVGO', 'Samsung', 'ASX', 'CIEN', 'NOK', 'NBIS', 'IFX');
  if (/optical|光|network|网络|DCI|Infinera/i.test(text)) out.push('CIEN', 'NOK', 'AVGO');
  if (/HBM|memory|DRAM|EUV|CoWoS|foundry|semiconductor/i.test(text)) out.push('ASML', 'TSM', 'Samsung', 'ASX', 'IFX');
  return [...new Set(out)].slice(0, 9);
}

function canonicalTicker(raw = '', company = '') {
  const text = String(raw || company || '').trim();
  const upper = text.toUpperCase();
  const direct = {
    'BABA.US': 'BABA.N',
    'BABA': 'BABA.N',
    'ALIBABA': 'BABA.N',
    'GOOGL': 'GOOGL.O',
    'GOOGL.O': 'GOOGL.O',
    'GOOGLE': 'GOOGL.O',
    'ALPHABET': 'GOOGL.O',
    'META': 'META.O',
    'META.O': 'META.O',
    'MSFT': 'MSFT.O',
    'MSFT.O': 'MSFT.O',
    'AMZN': 'AMZN.O',
    'AMZN.O': 'AMZN.O',
    'ORCL': 'ORCL.N',
    'ORCL.N': 'ORCL.N',
    'NVDA': 'NVDA.O',
    'NVDA.O': 'NVDA.O',
    '005930.KS': 'Samsung',
    'SAMSUNG': 'Samsung',
    '000660.KS': '000660.KS',
    '0700.HK': '0700.HK',
    'BIDU.US': 'BIDU.US',
  };
  if (direct[upper]) return direct[upper];
  if (/ALIBABA/i.test(`${raw} ${company}`)) return 'BABA.N';
  if (/ALPHABET|GOOGLE/i.test(`${raw} ${company}`)) return 'GOOGL.O';
  if (/SAMSUNG/i.test(`${raw} ${company}`)) return 'Samsung';
  return text;
}

function displayTicker(ticker = '') {
  if (ticker === 'Samsung') return 'Samsung';
  return String(ticker).replace(/\.(O|N|US|DF)$/i, '');
}

function companyFromTicker(ticker) {
  const names = {
    'GOOGL.O': 'Alphabet Inc.',
    'MSFT.O': 'Microsoft Corporation',
    'AMZN.O': 'Amazon.com, Inc.',
    'META.O': 'Meta Platforms',
    'ORCL.N': 'Oracle Corporation',
    'BABA.N': 'Alibaba Group',
    'Samsung': 'Samsung Electronics',
  };
  return names[ticker] || null;
}

function normalizeProvider(provider = '') {
  const text = compactWhitespace(provider);
  if (/Alibaba|Qwen|通义/i.test(text)) return 'Alibaba/通义千问';
  if (/Google|Gemini/i.test(text)) return 'Google';
  if (/Moonshot|Kimi|月之暗面/i.test(text)) return 'Moonshot';
  return text;
}

function modelProviderGroup(provider = '') {
  if (/Alibaba|Qwen|通义/i.test(provider)) return 'Qwen / Alibaba';
  if (/Google|Gemini/i.test(provider)) return 'Gemini / Google';
  if (/Moonshot|Kimi/i.test(provider)) return 'Kimi / Moonshot';
  return provider || '其他';
}

function inferContextWindow(text = '') {
  const match = String(text).match(/\b\d+(?:\.\d+)?\s*(?:K|M)\s*(?:token|tokens|上下文|context)?/i);
  return match ? match[0].replace(/\s+/g, '') : null;
}

function inferMultimodal(text = '') {
  if (/multimodal|image|video|audio|vision|图像|视频|多模态/i.test(text)) return '是';
  return '—';
}

function inferRevision(fact) {
  const text = `${fact.value} ${fact.notes}`;
  if (/raised|increase|up|上调|提升|增加/i.test(text)) return 'raised';
  if (/lowered|decrease|down|下调|削减/i.test(text)) return 'lowered';
  return 'unknown';
}

function cleanDash(value) {
  const clean = compactWhitespace(value || '');
  if (!clean || /^[-—–]+$/.test(clean) || /^null$/i.test(clean) || /^undefined$/i.test(clean)) return null;
  return clean;
}

function tickerKey(value = '') {
  return String(value || '').toUpperCase().replace(/\.(O|N|US|DF)$/i, '').replace(/[^A-Z0-9]/g, '');
}

function valuationTickerKey(value = '') {
  const key = tickerKey(value);
  if (key === '005930KS' || key === '005930') return 'SAMSUNG';
  return key;
}

function relativeOrAbsolute(file) {
  const relative = relativeToRoot(file);
  if (relative.startsWith('..')) return `external/${path.basename(file)}`;
  return relative;
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function groupBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    acc[key] = acc[key] || [];
    acc[key].push(item);
    return acc;
  }, {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
