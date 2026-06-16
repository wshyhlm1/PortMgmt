import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PATHS,
  compactWhitespace,
  dateText,
  detectImpactDirection,
  ensureDir,
  eventTagsFromText,
  excerpt,
  extractModule,
  extractSection,
  hashId,
  inferGroup,
  keyValueFromTables,
  listFilesRecursive,
  normalizeExactDate,
  nowIso,
  parseBullets,
  parseMarkdownTables,
  pathExists,
  readJson,
  relativeToRoot,
  snapshotName,
  shortText,
  splitTags,
  stripMarkdown,
  todayInZone,
  verificationStatusForLevel,
  classifyEventLevel,
  writeJson,
} from './shared.mjs';

const SOURCE_NOTE = '本地 profile 导入，尚未补齐原始链接；不得自动升为 L1。';

async function main() {
  const importedAt = nowIso();
  await Promise.all([
    ensureDir(PATHS.initial),
    ensureDir(PATHS.uploads),
    ensureDir(PATHS.data),
    ensureDir(PATHS.dataQuality),
    ensureDir(PATHS.market),
    ensureDir(PATHS.snapshots),
    ensureDir(PATHS.reports),
  ]);

  const initialFiles = await listFilesRecursive(PATHS.initial, ['.md', '.markdown']);
  const uploadFiles = await listFilesRecursive(PATHS.uploads);
  const files = [
    ...initialFiles.map((file) => ({ file, sourceType: 'initial_profile' })),
    ...uploadFiles.map((file) => ({ file, sourceType: sourceTypeForUpload(file) })),
  ];

  const parsed = [];
  const errors = [];
  const imports = [];

  for (const item of files) {
    try {
      if (item.sourceType === 'upload_csv') {
        const csvCompanies = await parseCsvUpload(item.file, importedAt);
        parsed.push(...csvCompanies.map((company) => ({ company, events: [], reminders: [], aiCapex: [], aiModels: [] })));
        imports.push(importRecord(item.file, item.sourceType, importedAt, 'imported'));
        continue;
      }
      if (item.sourceType === 'unsupported_upload') {
        imports.push(importRecord(item.file, item.sourceType, importedAt, 'skipped', 'adapter stub: XLSX/DOCX/PDF support is reserved for the next version'));
        continue;
      }
      const text = await fs.readFile(item.file, 'utf8');
      parsed.push(parseProfileMarkdown(text, item.file, item.sourceType, importedAt));
      imports.push(importRecord(item.file, item.sourceType, importedAt, 'imported'));
    } catch (error) {
      errors.push({
        source_file: relativeToRoot(item.file),
        source_type: item.sourceType,
        message: error.message,
      });
      imports.push(importRecord(item.file, item.sourceType, importedAt, 'failed', error.message));
    }
  }

  const companies = mergeCompanies(parsed.map((item) => item.company).filter(Boolean));
  const config = await loadOrCreateConfig(companies, importedAt);
  const configByTicker = new Map((config.tracked || []).map((item, index) => [tickerKey(item.ticker), { ...item, order: item.order ?? index + 1 }]));
  for (const company of companies) {
    const configEntry = configByTicker.get(tickerKey(company.ticker)) || configByTicker.get(tickerKey(company.display_ticker));
    company.status = configEntry?.status || company.status || 'holding';
    company.group = configEntry?.group || company.group || inferGroup(company);
    company.weight = configEntry?.weight ?? null;
    company.order = configEntry?.order ?? company.order ?? 9999;
    company.yfinance_ticker = configEntry?.yfinance_ticker || configEntry?.yfinanceTicker || company.yfinance_ticker || company.display_ticker || company.ticker;
  }

  const events = parsed.flatMap((item) => item.events || []).map((event) => applyEventRules(event));
  const reminders = parsed.flatMap((item) => item.reminders || []);
  const aiCapex = withSupplyChainMappings(parsed.flatMap((item) => item.aiCapex || []), companies);
  const aiModels = addModelPlaceholders(parsed.flatMap((item) => item.aiModels || []));

  const cleanCompanies = companies
    .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.ticker.localeCompare(b.ticker))
    .map((company) => {
      const copy = { ...company };
      delete copy._merge_key;
      return copy;
    });

  const meta = {
    generated_at: importedAt,
    report_date: todayInZone(config.report_timezone || process.env.REPORT_TZ || 'Asia/Shanghai'),
    source_note: SOURCE_NOTE,
  };

  await writeJson(path.join(PATHS.data, 'companies.json'), { meta, companies: cleanCompanies, imports, errors });
  await writeJson(path.join(PATHS.data, 'events.json'), { meta, events });
  await writeJson(path.join(PATHS.data, 'reminders.json'), { meta, reminders });
  await writeJson(path.join(PATHS.data, 'ai_capex.json'), { meta, ai_capex: aiCapex });
  await writeJson(path.join(PATHS.data, 'ai_models.json'), { meta, ai_models: aiModels });

  const snapshot = {
    meta,
    config,
    counts: {
      companies: cleanCompanies.length,
      events: events.length,
      reminders: reminders.length,
      ai_capex: aiCapex.length,
      ai_models: aiModels.length,
      imports: imports.length,
      errors: errors.length,
    },
    inputs: imports,
    errors,
  };
  await writeJson(path.join(PATHS.snapshots, snapshotName(new Date(importedAt))), snapshot);

  console.log(`Imported ${cleanCompanies.length} companies, ${events.length} events, ${reminders.length} reminders.`);
  if (errors.length) {
    console.warn(`Completed with ${errors.length} import error(s). See data/companies.json and latest snapshot.`);
  }
}

function sourceTypeForUpload(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'upload_markdown';
  if (ext === '.csv') return 'upload_csv';
  if (['.xlsx', '.xls', '.docx', '.doc', '.pdf'].includes(ext)) return 'unsupported_upload';
  return 'unsupported_upload';
}

function importRecord(file, sourceType, importedAt, status, message = null) {
  return {
    source_file: relativeToRoot(file),
    source_type: sourceType,
    imported_at: importedAt,
    status,
    message,
  };
}

function parseProfileMarkdown(markdown, file, sourceType, importedAt) {
  const sourceFile = relativeToRoot(file);
  const titleLine = markdown.split(/\r?\n/).find((line) => /^#\s+/.test(line)) || '';
  const title = compactWhitespace(titleLine.replace(/^#\s+/, ''));
  const basicSection = extractSection(markdown, [/基本信息/]);
  const basic = { ...keyValueFromTables(basicSection), ...keyValueFromBullets(basicSection) };
  const titleParts = parseTitle(title, file);
  const displayTicker = path.basename(file).replace(/_profile\.md$/i, '').replace(/\.md$/i, '');
  const ticker = cleanTicker(basic['股票代码'] || titleParts.ticker, displayTicker);
  const companyName = basic['公司名称'] || basic['公司全称'] || titleParts.companyName || null;
  const chineseName = basic['中文名称'] || titleParts.chineseName || extractChineseName(companyName) || null;
  const tagsSection = extractSection(markdown, [/公司标签/]);
  const coreSection = extractSection(markdown, [/核心业务卡位/]);
  const revenueSection = extractSection(markdown, [/收入拆分/]);
  const financialSection = extractSection(markdown, [/财务指标|估值与盈利能力|财务与估值/]);
  const guidanceSection = extractSection(markdown, [/业绩指引/]);
  const capexSection = extractSection(markdown, [/资本开支与产能|资本开支\/产能|CAPEX/]);
  const financingSection = extractSection(markdown, [/融资与资本结构|资本结构/]);
  const risks = extractRisks(markdown, sourceFile);

  const company = {
    ticker,
    display_ticker: displayTicker,
    company_name: companyName,
    chinese_name: chineseName,
    exchange: basic['交易所'] || null,
    sub_industry: basic['子行业'] || basic['所属子行业'] || null,
    tags: splitTags(tagsSection),
    status: 'holding',
    group: null,
    core_positioning: shortText(coreSection, 260),
    revenue_breakdown: parseRevenueBreakdown(revenueSection, sourceFile),
    financials: parseFinancials(financialSection, sourceFile),
    guidance: parseGuidance(guidanceSection, sourceFile),
    capex_capacity: parseCapex(capexSection, financingSection, sourceFile),
    capital_structure: parseCapitalStructure(financingSection, sourceFile),
    price_performance: {
      one_day: null,
      five_day: null,
      twenty_day: null,
      ytd: null,
      relative_qqq: null,
      relative_spy: null,
      status: '未接入/待补充',
    },
    risks,
    sources: [sourceFile],
    source_files: [sourceFile],
    source_type: sourceType,
    imported_at: importedAt,
    updated_at: importedAt,
    extraction_warnings: profileExtractionWarnings(markdown, sourceFile),
    missing_info_prompt: companyMissingPrompts({ ticker, sourceFile, financialSection, guidanceSection, capexSection }),
  };
  company.group = inferGroup(company);

  return {
    company,
    events: parseEvents(markdown, company, sourceFile, importedAt),
    reminders: parseReminders(markdown, company, sourceFile, importedAt),
    aiCapex: parseAiCapex(markdown, company, sourceFile, importedAt),
    aiModels: parseAiModels(markdown, company, sourceFile, importedAt),
  };
}

function parseTitle(title, file) {
  const fallbackTicker = path.basename(file).replace(/_profile\.md$/i, '').replace(/\.md$/i, '');
  const paren = title.match(/^(.+?)[（(]([^）)]+)[）)]/);
  if (paren) {
    const left = compactWhitespace(paren[1]);
    const inside = compactWhitespace(paren[2]);
    const slash = inside.split('/').map((part) => compactWhitespace(part)).filter(Boolean);
    const ticker = (left.match(/\b[A-Z0-9]{1,8}(?:\.[A-Z])?\b/) || [fallbackTicker])[0];
    const chineseName = slash.find((part) => /[\u3400-\u9fff]/.test(part)) || null;
    const companyName = slash.find((part) => /[A-Za-z]/.test(part)) || left.replace(ticker, '').trim() || null;
    return { ticker, chineseName, companyName };
  }
  const tickerInParen = title.match(/\(([A-Z0-9]{1,8}(?:\.[A-Z])?)\)/);
  const ticker = tickerInParen ? tickerInParen[1] : (title.match(/\b[A-Z0-9]{1,8}(?:\.[A-Z])?\b/) || [fallbackTicker])[0];
  const companyName = compactWhitespace(title.replace(/\([^)]*\)/g, '').replace(/基本资料.*$/, '').replace(ticker, '')) || null;
  return { ticker, chineseName: null, companyName };
}

function keyValueFromBullets(markdown = '') {
  const out = {};
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.trim().match(/^[-*]\s+\*\*([^*]+)\*\*\s*[：:]\s*(.+)$/);
    if (!match) continue;
    out[compactWhitespace(match[1])] = compactWhitespace(match[2]);
  }
  return out;
}

function extractChineseName(text) {
  const match = String(text || '').match(/[（(]([^）)]*[\u3400-\u9fff][^）)]*)[）)]/);
  return match ? compactWhitespace(match[1]) : null;
}

function cleanTicker(raw, fallback) {
  const text = compactWhitespace(raw || '');
  const match = text.match(/\b[A-Z0-9]{1,8}(?:\.[A-Z]{1,3})?\b/);
  return match ? match[0] : fallback;
}

function parseRevenueBreakdown(section, sourceFile) {
  const fromTables = parseMarkdownTables(section).flatMap((table) => {
    const header = table.header.map((cell) => compactWhitespace(cell));
    const segmentIndex = header.findIndex((cell) => /(业务|板块|segment|类别)/i.test(cell));
    const revenueIndex = header.findIndex((cell) => /(收入|revenue)/i.test(cell));
    const shareIndex = header.findIndex((cell) => /(占比|share|percentage)/i.test(cell));
    const yoyIndex = header.findIndex((cell) => /(同比|YoY|增速)/i.test(cell));
    const noteIndex = header.findIndex((cell) => /(备注|说明|卡位|note)/i.test(cell));
    if (segmentIndex === -1) return [];
    return table.rows.map((row) => ({
      segment: compactWhitespace(row[segmentIndex] || '') || null,
      revenue: revenueIndex >= 0 ? compactWhitespace(row[revenueIndex] || '') || null : null,
      share: shareIndex >= 0 ? compactWhitespace(row[shareIndex] || '') || null : null,
      yoy: yoyIndex >= 0 ? compactWhitespace(row[yoyIndex] || '') || null : null,
      note: shortText(noteIndex >= 0 ? row[noteIndex] : row.join(' / '), 140),
      source: sourceFile,
      confidence: 'profile',
    }));
  });
  if (fromTables.length) return fromTables;
  return parseBullets(section).map((line) => {
    const segment = (line.match(/^([^：:（(]+)[（(：:]/) || [null, null])[1];
    const share = (line.match(/~?\d+(?:\.\d+)?\s*%/) || [null])[0];
    return {
      segment: segment ? compactWhitespace(segment) : null,
      revenue: null,
      share,
      yoy: (line.match(/(?:同比|YoY)\s*[+＋-]?\s*\d+(?:\.\d+)?%/i) || [null])[0],
      note: shortText(line, 150),
      source: sourceFile,
      confidence: 'profile',
    };
  });
}

function parseFinancials(section, sourceFile) {
  const annualByPeriod = new Map();
  const latest = [];
  const valuation = [];
  const extractionWarnings = [];
  for (const table of parseMarkdownTables(section)) {
    const header = table.header.map((cell) => compactWhitespace(cell));
    const metricIndex = header.findIndex((cell) => /(指标|项目|metric|字段)/i.test(cell));
    if (metricIndex === -1) {
      extractionWarnings.push(`无法识别财务表指标列：${sourceFile}`);
      continue;
    }
    for (const row of table.rows) {
      const label = compactWhitespace(row[metricIndex] || '');
      const metric = normalizeFinancialMetric(label);
      if (!metric) {
        extractionWarnings.push(`未归一化财务指标：${label}`);
        continue;
      }
      for (let index = 0; index < header.length; index += 1) {
        if (index === metricIndex) continue;
        const period = compactWhitespace(header[index] || '');
        const value = compactWhitespace(row[index] || '');
        if (!value || isNoteHeader(period)) continue;
        if (/PE|PS|PB|EV\/?EBITDA|估值|市盈|市销/i.test(label)) {
          valuation.push(metricFact({ metric, label, value, period, sourceFile }));
          continue;
        }
        if (isAnnualPeriod(period)) {
          const record = annualByPeriod.get(period) || {
            fiscal_year: period,
            revenue: null,
            revenue_yoy: null,
            gross_margin: null,
            operating_margin: null,
            net_income: null,
            net_margin: null,
            fcf: null,
            debt: null,
            net_debt: null,
            capex: null,
            source: sourceFile,
            confidence: 'profile',
          };
          record[metric] = value;
          annualByPeriod.set(period, record);
        } else {
          latest.push(metricFact({ metric, label, value, period, sourceFile }));
        }
      }
    }
  }
  const bullets = parseBullets(section);
  for (const line of bullets) {
    const metric = normalizeFinancialMetric(line);
    if (!metric) continue;
    const value = extractMetricValue(line);
    const fact = metricFact({ metric, label: line.split(/[：:]/)[0], value: value || shortText(line, 120), period: normalizeExactDate(line) || 'profile_note', sourceFile });
    if (['pe', 'ps', 'pb', 'ev_ebitda'].includes(metric)) valuation.push(fact);
    else latest.push(fact);
  }
  return {
    annual: [...annualByPeriod.values()],
    latest,
    valuation: dedupeBy(valuation, (item) => `${item.metric}|${item.period}|${item.value}`),
    extraction_warnings: extractionWarnings,
    missing_info_prompt: [
      promptItem('financials.annual.source_url', '补充年度财务表的公司公告/年报/财报原始链接', sourceFile),
      promptItem('financials.valuation.latest', '确认最新估值口径 PE/PS/PB/EV-EBITDA 及日期；可自动行情字段无需补', sourceFile),
    ],
  };
}

function parseGuidance(section, sourceFile) {
  return parseBullets(section).map((line) => ({
    date: normalizeExactDate(line),
    period: inferGuidancePeriod(line),
    metric: inferGuidanceMetric(line),
    value: extractGuidanceValue(line),
    direction: /上调|提高|提升|增加/.test(line) ? 'up' : (/下调|削减|下降/.test(line) ? 'down' : (/维持|重申/.test(line) ? 'maintained' : 'unknown')),
    summary: shortText(line, 150),
    source: sourceFile,
    confidence: 'profile',
    validation_status: 'needs_source',
    missing_info_prompt: promptItem('guidance.original_source', '补充管理层指引原文链接、发布日期、上调/下调口径', sourceFile),
  }));
}

function parseCapex(capexSection, financingSection, sourceFile) {
  const capexBullets = parseBullets(capexSection);
  const tableRows = parseMarkdownTables(capexSection).flatMap((table) => tableToCapexRows(table, sourceFile));
  const bulletRows = capexBullets
    .filter((line) => /(CAPEX|capex|资本开支|产能|扩产|投产|工厂|产线|High-NA|CoWoS|HBM)/i.test(line))
    .map((line) => ({
      period: inferPeriod(line),
      capex: extractMoney(line),
      yoy: extractYoy(line),
      capacity: /(产能|投产|扩产|爬坡|工厂|产线|出货)/.test(line) ? shortText(line, 150) : null,
      project: inferProject(line),
      timepoint: capexTimepoint(line),
      source: sourceFile,
      confidence: 'profile',
      validation_status: 'needs_source',
      missing_info_prompt: promptItem('capex_capacity.original_source', '补充 CAPEX/产能项目的原始公告或财报电话会链接', sourceFile),
    }));
  return dedupeBy([...tableRows, ...bulletRows], (item) => `${item.period}|${item.capex}|${item.capacity}|${item.project}`).slice(0, 12);
}

function parseCapitalStructure(section, sourceFile) {
  const bullets = parseBullets(section);
  const find = (pattern) => bullets.find((line) => pattern.test(line));
  return {
    cash: extractMoney(find(/现金|cash/i) || ''),
    debt: extractMoney(find(/债务|负债|debt/i) || ''),
    net_debt: extractMoney(find(/净负债|净现金|net debt|net cash/i) || ''),
    dividend: shortText(find(/分红|股息|dividend/i) || '', 120),
    buyback: shortText(find(/回购|buyback/i) || '', 120),
    financing_events: bullets
      .filter((line) => /(融资|发债|信贷|债务|回购|分红|并购)/.test(line))
      .map((line) => ({
        title: shortText(line, 120),
        source: sourceFile,
        confidence: 'profile',
        validation_status: 'needs_source',
      })),
    source: sourceFile,
    confidence: 'profile',
  };
}

function normalizeFinancialMetric(label = '') {
  const text = compactWhitespace(label);
  if (/收入增速|营收增速|收入同比|YoY/i.test(text)) return 'revenue_yoy';
  if (/营业收入|收入（|收入\(|营收|Revenue/i.test(text)) return 'revenue';
  if (/毛利率|Gross Margin/i.test(text)) return 'gross_margin';
  if (/运营利润率|营业利润率|Operating Margin/i.test(text)) return 'operating_margin';
  if (/净利率|Net Margin/i.test(text)) return 'net_margin';
  if (/净利润|Net Income/i.test(text)) return 'net_income';
  if (/自由现金流|FCF|Free Cash Flow/i.test(text)) return 'fcf';
  if (/资本支出|CAPEX|Capex/i.test(text)) return 'capex';
  if (/净负债|净现金|Net Debt|Net Cash/i.test(text)) return 'net_debt';
  if (/总债务|债务|负债|Debt/i.test(text)) return 'debt';
  if (/\bPE\b|市盈率/i.test(text)) return 'pe';
  if (/\bPS\b|市销率/i.test(text)) return 'ps';
  if (/\bPB\b|市净率/i.test(text)) return 'pb';
  if (/EV\/?EBITDA/i.test(text)) return 'ev_ebitda';
  return null;
}

function isAnnualPeriod(period = '') {
  return /\bFY?\s?20\d{2}\b/i.test(period) || /\b20\d{2}\b/.test(period);
}

function isNoteHeader(header = '') {
  return /(备注|说明|note|comment|口径)/i.test(header) || header === '—' || header === '-';
}

function metricFact({ metric, label, value, period, sourceFile }) {
  return {
    metric,
    label: compactWhitespace(label),
    value: compactWhitespace(value),
    period: compactWhitespace(period) || null,
    source: sourceFile,
    confidence: 'profile',
    validation_status: 'needs_source',
  };
}

function extractMetricValue(text = '') {
  return (String(text).match(/(?:约|~)?[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:万亿|千亿|百亿|亿美元|亿欧元|亿韩元|亿新台币|亿美元|美元|欧元|%|x|倍)?/i) || [null])[0];
}

function inferGuidancePeriod(text = '') {
  const quarter = String(text).match(/\b(20\d{2})?\s*Q([1-4])\b/i);
  if (quarter) return `${quarter[1] || ''}Q${quarter[2]}`.trim();
  const fy = String(text).match(/\b(?:FY)?(20\d{2})\b/i);
  if (fy) return `FY${fy[1]}`;
  const h = String(text).match(/\b(20\d{2})H([12])\b/i);
  if (h) return `${h[1]}H${h[2]}`;
  return null;
}

function inferGuidanceMetric(text = '') {
  if (/收入|营收|sales|revenue/i.test(text)) return 'revenue';
  if (/毛利率|gross margin/i.test(text)) return 'gross_margin';
  if (/EBITDA/i.test(text)) return 'adjusted_ebitda';
  if (/EPS/i.test(text)) return 'eps';
  if (/CAPEX|资本开支/i.test(text)) return 'capex';
  return 'management_guidance';
}

function extractGuidanceValue(text = '') {
  const range = String(text).match(/(?:约)?[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*[–—-]\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:亿欧元|亿美元|%|x|倍)?/);
  if (range) return compactWhitespace(range[0]);
  return extractMetricValue(text);
}

function tableToCapexRows(table, sourceFile) {
  const header = table.header.map((cell) => compactWhitespace(cell));
  const periodIndex = header.findIndex((cell) => /(期间|时间|年份|年度|period|date)/i.test(cell));
  const capexIndex = header.findIndex((cell) => /(CAPEX|Capex|资本开支|指引)/i.test(cell) && !/(主体|公司|客户|云厂商)/i.test(cell));
  const yoyIndex = header.findIndex((cell) => /(同比|YoY|增速)/i.test(cell));
  const projectIndex = header.findIndex((cell) => /(项目|产能|工厂|客户|云厂商|公司|driver|影响)/i.test(cell));
  const noteIndex = header.findIndex((cell) => /(备注|说明|影响|note|关键)/i.test(cell));
  if (capexIndex === -1 && projectIndex === -1) return [];
  return table.rows.map((row) => ({
    period: periodIndex >= 0 ? compactWhitespace(row[periodIndex] || '') || null : inferPeriod(row.join(' ')),
    capex: capexIndex >= 0 ? compactWhitespace(row[capexIndex] || '') || null : extractMoney(row.join(' ')),
    yoy: yoyIndex >= 0 ? compactWhitespace(row[yoyIndex] || '') || null : extractYoy(row.join(' ')),
    capacity: noteIndex >= 0 ? shortText(row[noteIndex], 140) : null,
    project: projectIndex >= 0 ? compactWhitespace(row[projectIndex] || '') || null : inferProject(row.join(' ')),
    timepoint: capexTimepoint(row.join(' ')),
    source: sourceFile,
    confidence: 'profile',
    validation_status: 'needs_source',
    missing_info_prompt: promptItem('capex_capacity.original_source', '补充 CAPEX/产能表格行的原始来源链接和口径', sourceFile),
  }));
}

function inferPeriod(text = '') {
  return inferGuidancePeriod(text) || normalizeExactDate(text);
}

function capexTimepoint(text = '') {
  return normalizeExactDate(text) || inferGuidancePeriod(text);
}

function extractMoney(text = '') {
  return (String(text).match(/(?:约|~)?[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:万亿|千亿|百亿|亿美元|亿欧元|亿韩元|亿新台币|亿美元|美元|欧元|EUR|USD|KRW|TWD|CNY)/i) || [null])[0];
}

function extractYoy(text = '') {
  return (String(text).match(/(?:同比|YoY)?\s*[+＋-]\s*\d+(?:\.\d+)?%/i) || [null])[0];
}

function inferProject(text = '') {
  const clean = compactWhitespace(text);
  const match = clean.match(/(High-NA EUV|Low-NA EUV|CoWoS|HBM\d?[Ee]?|M15X|FOPLP|LEAP|Dragonfly|TPU|MTIA|数据中心|新厂|工厂|产线|扩产)/i);
  return match ? match[0] : null;
}

function promptItem(field, question, sourceFile, expected = 'ticker, field, value, date/period, original_url, confidence') {
  return {
    field,
    question,
    expected_answer_format: expected,
    preferred_source: 'company_ir/sec/earnings_call/reuters/bloomberg/obsidian_with_original_url',
    date_range: '2024-01-01 至今',
    confidence_level: 'needs_source',
    source_file: sourceFile,
  };
}

function profileExtractionWarnings(markdown, sourceFile) {
  const warnings = [];
  const tableCount = parseMarkdownTables(markdown).length;
  if (!tableCount) warnings.push(`未发现 Markdown 表格：${sourceFile}`);
  if (/未获取|未披露|待补充|—/.test(markdown)) warnings.push(`存在未披露/待补字段：${sourceFile}`);
  return warnings;
}

function companyMissingPrompts({ ticker, sourceFile, financialSection, guidanceSection, capexSection }) {
  const prompts = [];
  if (!financialSection) prompts.push(promptItem('financials.annual', `请补充 ${ticker} 最近三年年度财务表及原始来源`, sourceFile));
  if (!guidanceSection) prompts.push(promptItem('guidance', `请补充 ${ticker} 最近一次管理层指引及原始来源`, sourceFile));
  if (!capexSection) prompts.push(promptItem('capex_capacity', `请补充 ${ticker} CAPEX/产能项目及原始来源`, sourceFile));
  prompts.push(promptItem('source_url', `请为 ${ticker} profile 中的高风险财务/指引/CAPEX口径补原始链接`, sourceFile));
  return prompts;
}

function extractRisks(markdown, sourceFile) {
  const riskSections = [
    extractSection(markdown, [/竞争风险/]),
    extractSection(markdown, [/地缘政治与监管/]),
    extractSection(markdown, [/出口管制/]),
    extractSection(markdown, [/监管环境/]),
  ].filter(Boolean);
  const bullets = riskSections.flatMap((section) => parseBullets(section));
  const riskLines = bullets.filter((line) => /(风险|管制|禁令|调查|诉讼|关税|限制|下滑|替代|承压|脱钩|监管)/.test(line));
  return [...new Set(riskLines)].slice(0, 12).map((line) => ({
    title: shortText(line.split(/[：:。；;]/)[0], 42) || '风险',
    summary: shortText(line, 150),
    severity: /(禁令|诉讼|调查|制裁|下滑|脱钩|重大|核心)/.test(line) ? 'high' : 'medium',
    source: sourceFile,
    confidence: 'profile',
  }));
}

function parseEvents(markdown, company, sourceFile, importedAt) {
  const module = extractModule(markdown, 5);
  const events = [];
  for (const table of parseMarkdownTables(module)) {
    const header = table.header.map((cell) => compactWhitespace(cell));
    const timeIndex = header.findIndex((cell) => /(时间|日期|Date)/i.test(cell));
    const eventIndex = header.findIndex((cell) => /(事件|动态|内容|公司新闻|公告)/.test(cell));
    const impactIndex = header.findIndex((cell) => /(影响|方向|备注)/.test(cell));
    if (timeIndex === -1 || eventIndex === -1) continue;
    for (const row of table.rows) {
      const timeRaw = row[timeIndex] || '';
      const summary = compactWhitespace(row[eventIndex] || '');
      if (!summary) continue;
      const impactText = compactWhitespace(row[impactIndex] || summary);
      events.push(makeEvent({
        company,
        dateRaw: timeRaw,
        title: summary,
        summary: impactText && impactText !== summary ? `${summary}；${impactText}` : summary,
        sourceFile,
        importedAt,
      }));
    }
  }
  const bulletEvents = parseBullets(module)
    .filter((line) => /(发布|公告|财报|上调|下调|订单|收购|监管|法案|诉讼|投资者日|业绩会|评级|目标价|CAPEX|产能)/.test(line))
    .slice(0, 12);
  for (const line of bulletEvents) {
    events.push(makeEvent({
      company,
      dateRaw: line,
      title: line.split(/[：:。]/)[0].slice(0, 80),
      summary: line,
      sourceFile,
      importedAt,
    }));
  }
  return dedupeBy(events, (event) => `${event.ticker}|${event.date_text}|${event.summary}`);
}

function makeEvent({ company, dateRaw, title, summary, sourceFile, importedAt }) {
  const level = classifyEventLevel({ text: summary, sourceFile });
  const validationStatus = level === 'L1' ? 'confirmed' : (level === 'L3' ? 'rumor' : 'needs_source');
  return {
    id: `evt_${hashId(company.ticker, sourceFile, dateRaw, summary)}`,
    date: normalizeExactDate(dateRaw),
    date_text: dateText(dateRaw),
    ticker: company.ticker,
    level,
    title: shortText(title, 90) || '待补充',
    summary: shortText(summary, 150) || '待补充',
    why_it_matters: shortText(summary, 120),
    impact_direction: detectImpactDirection(summary),
    impact: detectImpactDirection(summary),
    tags: eventTagsFromText(summary),
    source_type: 'profile',
    sourceType: 'profile',
    source: sourceFile,
    original_url: null,
    originalUrl: null,
    source_url: null,
    source_file: sourceFile,
    obsidian_path: null,
    bosidian_path: null,
    validation_status: validationStatus,
    validationStatus,
    verification_status: verificationStatusForLevel(level),
    next_check: '补原始链接或 Obsidian 存档后再进入页面事实区',
    nextCheck: '补原始链接或 Obsidian 存档后再进入页面事实区',
    missing_info_prompt: promptItem('events.original_source', `请补充 ${company.ticker} 事件“${shortText(title, 50)}”的原始来源链接、日期和验证状态`, sourceFile),
    created_at: importedAt,
    updated_at: importedAt,
  };
}

function applyEventRules(event) {
  const level = classifyEventLevel({
    text: `${event.title} ${event.summary}`,
    sourceUrl: event.source_url,
    sourceFile: event.source_file,
  });
  return {
    ...event,
    level,
    validation_status: level === 'L1' ? 'confirmed' : (level === 'L3' ? 'rumor' : event.validation_status || 'needs_source'),
    validationStatus: level === 'L1' ? 'confirmed' : (level === 'L3' ? 'rumor' : event.validationStatus || 'needs_source'),
    verification_status: verificationStatusForLevel(level),
  };
}

function parseReminders(markdown, company, sourceFile, importedAt) {
  const module = extractModule(markdown, 6);
  return parseBullets(module).map((line) => ({
    id: `rem_${hashId(company.ticker, sourceFile, line)}`,
    date: normalizeExactDate(line),
    date_text: dateText(line),
    ticker: company.ticker,
    type: inferReminderType(line),
    title: line,
    priority: /(关键|重点|必须|监控|关注|财报|监管|法案|订单|CAPEX|产能)/i.test(line) ? 'high' : 'normal',
    source: sourceFile,
    source_file: sourceFile,
    status: 'open',
    created_at: importedAt,
    updated_at: importedAt,
  }));
}

function inferReminderType(text) {
  if (/财报|业绩|earnings/i.test(text)) return 'earnings';
  if (/发布|产品|模型|launch/i.test(text)) return 'product_launch';
  if (/投资者日|会议|conference/i.test(text)) return 'conference';
  if (/监管|法案|听证|出口管制|诉讼/i.test(text)) return 'regulation';
  if (/CAPEX|产能|订单|扩产|关停|capacity/i.test(text)) return 'capacity_update';
  return 'other';
}

function parseAiCapex(markdown, company, sourceFile, importedAt) {
  const module = extractModule(markdown, 7);
  if (!module) return [];
  const entries = [];
  for (const table of parseMarkdownTables(module)) {
    entries.push(...parseAiCapexTable(table, company, sourceFile, importedAt));
  }
  for (const line of parseBullets(module)) {
    const clean = compactWhitespace(line);
    if (!/(CAPEX|capex|资本开支|数据中心|GPU|TPU|ASIC|HBM|云厂商|字节|阿里|腾讯|百度|Google|Microsoft|Amazon|Meta|Oracle|OpenAI)/i.test(clean)) continue;
    const namedCompany = inferCapexCompany(clean);
    if (namedCompany) {
      entries.push(makeAiCapexEntry({
        category: isChinaCapexCompany(namedCompany) ? 'china' : 'hyperscaler',
        companyName: namedCompany,
        capex2025: extractCapexForYear(clean, '2025'),
        capex2026: extractCapexForYear(clean, '2026') || extractMoney(clean),
        yoy: extractYoy(clean),
        aiRelatedNotes: clean,
        sourceFile,
        importedAt,
      }));
      continue;
    }
    entries.push(makeSupplyChainMappingEntry({
      demandDriver: company.display_ticker || company.ticker,
      impactedHoldings: [company.display_ticker || company.ticker],
      mechanism: clean,
      strength: /(直接|核心|最大|强劲|高度)/.test(clean) ? 'high' : 'medium',
      evidence: sourceFile,
      sourceFile,
      importedAt,
    }));
  }
  return dedupeBy(entries, (entry) => `${entry.category}|${entry.company || entry.demand_driver}|${entry.capex_2026 || entry.mechanism}`);
}

function inferRegion(company) {
  const text = [company.exchange, company.company_name, company.chinese_name].filter(Boolean).join(' ');
  if (/NASDAQ|NYSE|New York|US|United States|美国/i.test(text)) return 'US';
  if (/中国|上海|深圳|香港|Alibaba|BABA/i.test(text)) return 'China';
  return 'Other';
}

function parseAiCapexTable(table, company, sourceFile, importedAt) {
  const header = table.header.map((cell) => compactWhitespace(cell));
  const companyIndex = header.findIndex((cell) => /(云厂商|公司|客户|Company|厂商|Demand driver)/i.test(cell));
  const capex2025Index = header.findIndex((cell) => /2025.*(CAPEX|Capex|资本开支)|2025年Capex/i.test(cell));
  const capex2026Index = header.findIndex((cell) => /2026.*(CAPEX|Capex|资本开支|指引)|2026E/i.test(cell));
  const capexIndex = header.findIndex((cell) => /(CAPEX|Capex|资本开支|指引)/i.test(cell));
  const yoyIndex = header.findIndex((cell) => /(同比|YoY|增速)/i.test(cell));
  const noteIndex = header.findIndex((cell) => /(说明|备注|焦点|影响|关键|AI|notes?)/i.test(cell));
  const entries = [];
  for (const row of table.rows) {
    const rowText = compactWhitespace(row.join(' '));
    const namedCompany = companyIndex >= 0 ? compactWhitespace(row[companyIndex] || '') : inferCapexCompany(rowText);
    const capex2025Value = capex2025Index >= 0 ? compactWhitespace(row[capex2025Index] || '') || null : extractCapexForYear(rowText, '2025');
    const capex2026Value = capex2026Index >= 0 ? compactWhitespace(row[capex2026Index] || '') || null : (capexIndex >= 0 ? compactWhitespace(row[capexIndex] || '') || null : extractCapexForYear(rowText, '2026'));
    const hasCapexGuidance = Boolean(cleanDash(capex2025Value) || cleanDash(capex2026Value) || /未明确|未披露|未获取/.test(rowText));
    if (namedCompany && (isHyperscaler(namedCompany) || isChinaCapexCompany(namedCompany)) && hasCapexGuidance) {
      entries.push(makeAiCapexEntry({
        category: isChinaCapexCompany(namedCompany) ? 'china' : 'hyperscaler',
        companyName: normalizeCapexCompany(namedCompany),
        capex2025: capex2025Value,
        capex2026: capex2026Value,
        yoy: yoyIndex >= 0 ? compactWhitespace(row[yoyIndex] || '') || null : extractYoy(rowText),
        aiRelatedNotes: noteIndex >= 0 ? row[noteIndex] : rowText,
        sourceFile,
        importedAt,
      }));
      continue;
    }
    if (/(影响|映射|拉动|受益|供应链|TPU|GPU|CPU|ASIC|HBM|CoWoS|EUV|光网络|电源|封装|训练|推理)/i.test(rowText)) {
      entries.push(makeSupplyChainMappingEntry({
        demandDriver: namedCompany || company.display_ticker || company.ticker,
        impactedHoldings: [company.display_ticker || company.ticker],
        mechanism: rowText,
        strength: /(核心|直接|最大|高度|显著)/.test(rowText) ? 'high' : 'medium',
        evidence: sourceFile,
        sourceFile,
        importedAt,
      }));
    }
  }
  return entries;
}

function makeAiCapexEntry({ category, companyName, capex2025 = null, capex2026 = null, yoy = null, aiRelatedNotes = null, sourceFile, importedAt }) {
  const normalizedCompany = normalizeCapexCompany(companyName);
  const needsSource = !capex2026 || /未明确|未披露|未获取|估算|预计|—|-/.test(String(capex2026));
  return {
    id: `capex_${hashId(category, normalizedCompany, capex2025, capex2026, sourceFile)}`,
    category,
    company: normalizedCompany,
    region: category === 'china' ? 'China' : 'US',
    capex_2025: cleanDash(capex2025),
    capex_2026: cleanDash(capex2026),
    capex_guidance: cleanDash(capex2026),
    yoy_growth: cleanDash(yoy),
    ai_related_notes: shortText(aiRelatedNotes, 150),
    last_update_date: normalizeExactDate(aiRelatedNotes || '') || null,
    revision_direction: /上调|提升|增加/.test(String(aiRelatedNotes)) ? 'up' : (/下调|削减|下降/.test(String(aiRelatedNotes)) ? 'down' : 'unknown'),
    source: sourceFile,
    confidence_level: needsSource ? 'unknown' : 'profile',
    validation_status: needsSource ? 'needs_source' : 'profile',
    missing_info_prompt: needsSource ? promptItem('ai_capex.original_source', `请补充 ${normalizedCompany} 最新 CAPEX 指引、AI相关口径、上次调整日期和原始来源链接`, sourceFile) : null,
    created_at: importedAt,
    updated_at: importedAt,
  };
}

function makeSupplyChainMappingEntry({ demandDriver, impactedHoldings, mechanism, strength, evidence, sourceFile, importedAt }) {
  return {
    id: `capex_map_${hashId(demandDriver, impactedHoldings.join(','), mechanism, sourceFile)}`,
    category: 'supply_chain_mapping',
    demand_driver: compactWhitespace(demandDriver),
    impacted_holdings: [...new Set(impactedHoldings.filter(Boolean))],
    mechanism: shortText(mechanism, 150),
    strength,
    evidence: shortText(evidence, 120),
    source: sourceFile,
    confidence_level: 'profile',
    validation_status: 'needs_source',
    missing_info_prompt: promptItem('ai_capex.supply_chain_evidence', `请补充 ${compactWhitespace(demandDriver)} 对 ${impactedHoldings.join('/')} 的供应链映射证据`, sourceFile),
    created_at: importedAt,
    updated_at: importedAt,
  };
}

function withSupplyChainMappings(entries, companies) {
  return entries.map((entry) => {
    if (entry.category === 'supply_chain_mapping') return entry;
    const text = [entry.company, entry.ai_related_notes].filter(Boolean).join(' ');
    const mapping = companies
      .filter((company) => {
        const probes = [company.display_ticker, company.ticker, company.company_name, company.chinese_name].filter(Boolean);
        return probes.some((probe) => text.includes(probe.replace(/\..+$/, '')) || text.includes(probe));
      })
      .map((company) => company.display_ticker || company.ticker);
    return { ...entry, supply_chain_mapping: [...new Set(mapping)] };
  });
}

function inferCapexCompany(text = '') {
  const rules = [
    ['NVIDIA', /NVIDIA|英伟达|NVDA/i],
    ['AMD', /\bAMD\b|Advanced Micro Devices/i],
    ['Microsoft', /Microsoft|MSFT|Azure/i],
    ['Google', /Google|Alphabet|GOOGL|Gemini|TPU/i],
    ['Amazon', /Amazon|AMZN|AWS|Trainium/i],
    ['Meta', /Meta|META|Facebook|MTIA/i],
    ['Oracle', /Oracle|ORCL|OCI/i],
    ['OpenAI', /OpenAI|Stargate/i],
    ['ByteDance', /字节|ByteDance|TikTok/i],
    ['Alibaba', /阿里|Alibaba|BABA|阿里巴巴/i],
    ['Tencent', /腾讯|Tencent/i],
    ['Baidu', /百度|Baidu/i],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function normalizeCapexCompany(text = '') {
  const inferred = inferCapexCompany(text);
  return inferred || compactWhitespace(text).replace(/[()（）].*$/, '').trim();
}

function isHyperscaler(text = '') {
  return /Microsoft|Google|Alphabet|Amazon|Meta|Oracle|OpenAI|MSFT|GOOGL|AMZN|META|ORCL|Azure|AWS|OCI|Stargate/i.test(text);
}

function isChinaCapexCompany(text = '') {
  return /ByteDance|字节|Alibaba|阿里|Tencent|腾讯|Baidu|百度/i.test(text);
}

function extractCapexForYear(text = '', year) {
  const pattern = new RegExp(`${year}[^。；;|]{0,24}(?:CAPEX|Capex|资本开支)?[^。；;|]{0,36}?((?:约|~)?[-+]?\\d+(?:,\\d{3})*(?:\\.\\d+)?\\s*(?:万亿|千亿|百亿|亿美元|亿欧元|亿韩元|亿新台币|亿美元|美元|欧元|EUR|USD|KRW|TWD|CNY))`, 'i');
  return (String(text).match(pattern) || [null, null])[1];
}

function cleanDash(value) {
  const clean = compactWhitespace(value || '');
  if (!clean || /^[-—–]+$/.test(clean)) return null;
  if (/未明确|未披露|未获取|暂无|不详/.test(clean)) return null;
  if (!/\d/.test(clean)) return null;
  return clean;
}

function parseAiModels(markdown, company, sourceFile, importedAt) {
  const module = extractModule(markdown, 8);
  if (!module) return [];
  const entries = [];
  for (const table of parseMarkdownTables(module)) {
    entries.push(...parseAiModelTable(table, company, sourceFile, importedAt));
  }
  for (const line of parseBullets(module)) {
    const provider = inferModelProvider(line);
    const modelName = inferModelName(line);
    if (!provider || !modelName) continue;
    entries.push(makeAiModelEntry({
      provider,
      modelName,
      releaseDate: normalizeExactDate(line) || dateText(line),
      status: inferModelStatus(line),
      keyCapability: line,
      computeImpact: /(算力|GPU|TPU|ASIC|HBM|网络|光互联|封装|推理|训练|数据中心|token|上下文)/i.test(line) ? line : null,
      impactedHoldings: impactedHoldingsFromText(line, [company]),
      sourceFile,
      importedAt,
    }));
  }
  return dedupeBy(entries, (entry) => `${entry.provider}|${entry.model_name}|${entry.release_date}|${entry.source}`);
}

function parseAiModelTable(table, company, sourceFile, importedAt) {
  const header = table.header.map((cell) => compactWhitespace(cell));
  const providerIndex = header.findIndex((cell) => /(厂商|Provider|公司)/i.test(cell));
  const modelIndex = header.findIndex((cell) => /(模型|Model)/i.test(cell));
  const dateIndex = header.findIndex((cell) => /(发布时间|发布日期|Release|Date)/i.test(cell));
  const statusIndex = header.findIndex((cell) => /(状态|Status)/i.test(cell));
  const capabilityIndex = header.findIndex((cell) => /(能力|特性|关键|Capability|上下文|多模态)/i.test(cell));
  const impactIndex = header.findIndex((cell) => /(算力|影响|Compute|供应链)/i.test(cell));
  if (providerIndex === -1 && modelIndex === -1) return [];
  return table.rows.map((row) => {
    const rowText = compactWhitespace(row.join(' '));
    const provider = inferModelProvider(providerIndex >= 0 ? row[providerIndex] : rowText);
    const modelName = modelIndex >= 0 ? compactWhitespace(row[modelIndex] || '') : inferModelName(rowText);
    if (!provider || !modelName) return null;
    return makeAiModelEntry({
      provider,
      modelName,
      releaseDate: dateIndex >= 0 ? compactWhitespace(row[dateIndex] || '') || null : (normalizeExactDate(rowText) || dateText(rowText)),
      status: statusIndex >= 0 ? normalizeModelStatus(row[statusIndex]) : inferModelStatus(rowText),
      keyCapability: capabilityIndex >= 0 ? row[capabilityIndex] : rowText,
      computeImpact: impactIndex >= 0 ? row[impactIndex] : (/(算力|GPU|TPU|ASIC|HBM|网络|光互联|封装|推理|训练|数据中心)/i.test(rowText) ? rowText : null),
      impactedHoldings: impactedHoldingsFromText(rowText, [company]),
      sourceFile,
      importedAt,
    });
  }).filter(Boolean);
}

function makeAiModelEntry({ provider, modelName, releaseDate, status, keyCapability, computeImpact, impactedHoldings, sourceFile, importedAt }) {
  return {
    id: `model_${hashId(provider, modelName, releaseDate, sourceFile)}`,
    provider,
    model_name: compactWhitespace(modelName),
    release_date: cleanModelCell(releaseDate),
    status,
    key_capabilities: cleanModelCell(shortText(keyCapability, 140)),
    compute_supply_chain_impact: cleanModelCell(shortText(computeImpact, 140)),
    impacted_holdings: impactedHoldings,
    source: sourceFile,
    confidence_level: 'profile',
    validation_status: 'needs_source',
    missing_info_prompt: promptItem('ai_models.original_source', `请确认 ${provider} ${compactWhitespace(modelName)} 的发布日期、状态、关键能力、算力影响和原始来源链接`, sourceFile),
    created_at: importedAt,
    updated_at: importedAt,
  };
}

function inferModelProvider(text) {
  const rules = [
    ['OpenAI', /OpenAI|GPT/i],
    ['Anthropic', /Anthropic|Claude/i],
    ['Google', /Google|Gemini/i],
    ['xAI', /xAI|Grok/i],
    ['Meta', /Meta|Llama/i],
    ['DeepSeek', /DeepSeek/i],
    ['Alibaba/通义千问', /Alibaba|阿里|通义|Qwen/i],
    ['Tencent', /Tencent|腾讯|混元|Hunyuan/i],
    ['Baidu', /Baidu|百度|文心|ERNIE/i],
    ['Mistral', /Mistral/i],
    ['Microsoft', /Microsoft|Phi|Copilot/i],
    ['Amazon', /Amazon|Nova|Titan/i],
    ['Moonshot', /Moonshot|Kimi|月之暗面/i],
    ['IBM', /IBM|Granite|watsonx/i],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function inferModelName(text) {
  const match = String(text).match(/\b(GPT[-\s]?\d[\w. -]*|o\d(?:[-\s][\w.]+)?|Claude\s+[A-Za-z0-9.\s-]+|Gemini\s+[A-Za-z0-9.\s-]+|Grok\s+\d[\w. -]*|DeepSeek[-\s]?[A-Za-z0-9.]+|Qwen\s?[\w.-]+|Llama\s?[\w.-]+|Granite\s?[\w.-]+|ERNIE\s?[\w.-]+|Hunyuan\s?[\w.-]+|Mistral\s?[\w.-]+|Phi\s?[\w.-]+|Nova\s?[\w.-]+|Kimi\s?[\w.-]+)\b/i);
  return match ? compactWhitespace(match[1]) : null;
}

function normalizeModelStatus(text = '') {
  if (/released|已发布|发布|GA|上线/i.test(text)) return 'released';
  if (/announced|宣布|预告/i.test(text)) return 'announced';
  if (/rumor|传闻|流传|预计|预期/i.test(text)) return 'rumored';
  if (/expected|计划|待发布|H[12]|Q[1-4]/i.test(text)) return 'expected';
  return 'unknown';
}

function cleanModelCell(value) {
  const clean = compactWhitespace(value || '');
  if (!clean || /^[-—–]+$/.test(clean) || /^null$/i.test(clean) || /^undefined$/i.test(clean)) return null;
  return clean;
}

function inferModelStatus(text = '') {
  return normalizeModelStatus(text);
}

function impactedHoldingsFromText(text = '', companies = []) {
  const clean = compactWhitespace(text);
  const out = [];
  for (const company of companies) {
    const probes = [company.display_ticker, company.ticker, company.company_name, company.chinese_name, company.group].filter(Boolean);
    if (probes.some((probe) => clean.includes(String(probe).replace(/\..+$/, '')))) {
      out.push(company.display_ticker || company.ticker);
    }
  }
  if (/TPU|ASIC|定制/i.test(clean)) out.push('AVGO', 'TSM', 'ASML', 'ASX');
  if (/GPU|训练|推理|数据中心/i.test(clean)) out.push('TSM', 'ASML', 'Samsung', 'IFX');
  if (/光互联|网络|DCI/i.test(clean)) out.push('CIEN', 'NOK', 'AVGO');
  return [...new Set(out)];
}

function addModelPlaceholders(entries) {
  return entries;
}

async function parseCsvUpload(file, importedAt) {
  const sourceFile = relativeToRoot(file);
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line, index) => {
    const cells = splitCsvLine(line);
    const row = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex] || null]));
    const ticker = row.ticker || row['股票代码'];
    if (!ticker) throw new Error(`CSV row ${index + 2} is missing ticker`);
    return {
      ticker,
      display_ticker: ticker.replace(/\..+$/, ''),
      company_name: row.company_name || row['公司名称'] || null,
      chinese_name: row.chinese_name || row['中文名'] || null,
      exchange: row.exchange || row['交易所'] || null,
      sub_industry: row.sub_industry || row['子行业'] || null,
      tags: splitTags(row.tags || row['标签'] || ''),
      status: row.status || 'watchlist',
      group: row.group || null,
      core_positioning: row.core_positioning || row['核心业务卡位'] || null,
      revenue_breakdown: [],
      financials: emptyFinancials(sourceFile),
      guidance: [],
      capex_capacity: [],
      capital_structure: { cash: null, debt: null, net_debt: null, dividend: null, buyback: null, financing_events: [], source: sourceFile, confidence: 'upload_csv' },
      price_performance: { one_day: null, five_day: null, twenty_day: null, ytd: null, relative_qqq: null, relative_spy: null, status: '未接入/待补充' },
      risks: [],
      sources: [sourceFile],
      source_files: [sourceFile],
      source_type: 'upload_csv',
      imported_at: importedAt,
      updated_at: importedAt,
      extraction_warnings: [],
      missing_info_prompt: [
        promptItem('financials.annual', `请补充 ${ticker} 财务与估值结构化字段`, sourceFile),
        promptItem('guidance', `请补充 ${ticker} 管理层指引结构化字段`, sourceFile),
        promptItem('capex_capacity', `请补充 ${ticker} CAPEX/产能结构化字段`, sourceFile),
      ],
    };
  });
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function emptyFinancials(sourceFile = null) {
  return {
    annual: [],
    latest: [],
    valuation: [],
    extraction_warnings: [],
    missing_info_prompt: sourceFile ? [promptItem('financials.annual', 'CSV 未提供财务表；请补充结构化财务与来源', sourceFile)] : [],
  };
}

async function loadOrCreateConfig(companies, importedAt) {
  const existing = await readJson(PATHS.config, null);
  if (existing) return existing;
  const tracked = companies.map((company, index) => ({
    ticker: company.ticker,
    display_ticker: company.display_ticker,
    company_name: company.company_name,
    chinese_name: company.chinese_name,
    status: company.status || 'holding',
    group: company.group || inferGroup(company),
    weight: null,
    order: index + 1,
    yfinance_ticker: company.display_ticker || company.ticker,
    source_file: company.source_files?.[0] || null,
  }));
  const config = {
    portfolio_name: '美股科技持仓组合',
    report_timezone: process.env.REPORT_TZ || 'Asia/Shanghai',
    web_mode: false,
    privacy: {
      publish_raw_uploads: false,
      redact_private_fields: true,
    },
    tracked,
    manual_reminders: [],
    adapters: {
      price: { provider: null, status: 'stub' },
      news: { provider: null, status: 'stub' },
    },
    generated_from_initial_at: importedAt,
  };
  await writeJson(PATHS.config, config);
  return config;
}

function mergeCompanies(companies) {
  const byKey = new Map();
  for (const company of companies) {
    const key = tickerKey(company.ticker || company.display_ticker);
    if (!byKey.has(key)) {
      byKey.set(key, { ...company, _merge_key: key });
      continue;
    }
    const current = byKey.get(key);
    current.source_files = [...new Set([...(current.source_files || []), ...(company.source_files || [])])];
    current.tags = [...new Set([...(current.tags || []), ...(company.tags || [])])];
    current.extraction_warnings = [...new Set([...(current.extraction_warnings || []), ...(company.extraction_warnings || [])])];
    current.missing_info_prompt = [...(current.missing_info_prompt || []), ...(company.missing_info_prompt || [])];
  }
  return [...byKey.values()];
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

function tickerKey(ticker = '') {
  return stripMarkdown(ticker).toUpperCase().replace(/\.(O|N|US|HK|KS)$/i, '');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
