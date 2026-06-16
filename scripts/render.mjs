import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PATHS,
  asArray,
  compactWhitespace,
  ensureDir,
  escapeHtml,
  listFilesRecursive,
  missingLabel,
  pathExists,
  readJson,
  shortText,
  todayInZone,
  writeJson,
} from './shared.mjs';
import { collectFinancialSanityIssues } from './financials/sanity.mjs';

const MODEL_MAIN_GROUPS = ['Anthropic', 'OpenAI', 'Gemini / Google', 'xAI', 'Qwen / Alibaba', 'DeepSeek', 'Kimi / Moonshot'];
const MODEL_GROUPS = [...MODEL_MAIN_GROUPS, '其他'];
const GUIDANCE_METRICS = new Set(['收入', '毛利率', '营业利润率', 'EPS', 'CAPEX', '产能', '出货量', 'AI收入', '云收入', 'FCF', '订单', '订单积压', '用户数', '其他资本开支']);
const RISK_CATEGORIES = new Set(['需求周期下行', '出口管制升级', '客户集中度', '技术路线替代', '产能扩张不及预期', '资本开支压力', '再融资压力', '监管/反垄断', '地缘政治', '竞争加剧', '毛利率下行', '订单兑现不及预期', '模型/API价格战', '安全/数据泄露', '其他，经人工确认']);

async function main() {
  const config = await readJson(PATHS.config, {
    portfolio_name: '美股科技持仓组合',
    report_timezone: process.env.REPORT_TZ || 'Asia/Shanghai',
    tracked: [],
  });
  const reportDate = process.argv[2] || todayInZone(config.report_timezone || process.env.REPORT_TZ || 'Asia/Shanghai');
  const data = await loadData(reportDate);
  const snapshots = await loadSnapshotContext();
  const report = buildReport({
    config,
    reportDate,
    data,
    snapshots,
    webMode: process.env.WEB_MODE === 'true' || config.web_mode === true,
  });

  const outDir = path.join(PATHS.reports, reportDate);
  await ensureDir(outDir);
  await writeJson(path.join(outDir, `${reportDate}.json`), report);
  await fs.writeFile(path.join(outDir, `${reportDate}.md`), renderMarkdown(report), 'utf8');
  await fs.writeFile(path.join(outDir, `${reportDate}.html`), renderHtml(report), 'utf8');
  await writeQualityArtifacts({ report, data, reportDate });
  console.log(`Rendered portfolio_reports/${reportDate}/${reportDate}.html`);
}

async function writeQualityArtifacts({ report, data, reportDate }) {
  const guidanceDir = path.join(PATHS.data, 'guidance');
  const valuationDir = path.join(PATHS.data, 'valuation_tasks');
  await writeJson(path.join(guidanceDir, 'guidance_verified.json'), {
    report_date: reportDate,
    rows: report.companies.flatMap((company) => (company.guidance || []).map((row) => ({ ticker: company.ticker, company: company.company_name, ...row }))),
  });
  await writeJson(path.join(guidanceDir, 'guidance_rejected.json'), {
    report_date: reportDate,
    rows: report.companies.flatMap((company) => company.guidance_rejected || []),
  });
  await writeJson(path.join(PATHS.data, 'obsidian_hits_raw.json'), {
    report_date: reportDate,
    meta: data.obsidianHits.meta || {},
    hits: data.obsidianHits.hits || [],
  });
  await writeJson(path.join(PATHS.data, 'obsidian_hits_verified.json'), {
    report_date: reportDate,
    rows: report.obsidian_hits || [],
  });
  await writeJson(path.join(valuationDir, `${reportDate}.json`), {
    report_date: reportDate,
    tasks: report.valuation_tasks || [],
  });
  await fs.writeFile(path.join(valuationDir, `valuation_fill_prompt_${reportDate}.md`), renderValuationPrompt(report), 'utf8');
}

async function loadData(reportDate) {
  const companiesData = await readJson(path.join(PATHS.data, 'companies.json'), { companies: [], imports: [], errors: [] });
  const eventsData = await readJson(path.join(PATHS.data, 'event_summary.json'), { events: [], company_news: [], company_announcements: [] });
  const remindersData = await readJson(path.join(PATHS.data, 'reminders.json'), { reminders: [] });
  const aiCapexData = await readJson(path.join(PATHS.data, 'ai_capex.json'), { ai_capex: [] });
  const aiModelsData = await readJson(path.join(PATHS.data, 'ai_models.json'), { ai_models: [] });
  const verifiedModelsData = await readJson(path.join(PATHS.data, 'enrichment', 'verified', 'models.json'), { rows: [] });
  const modelTimelineData = await readJson(path.join(PATHS.data, 'enrichment', 'verified', 'model_release_timeline.json'), { rows: [] });
  const financialHistoryData = await readJson(path.join(PATHS.data, 'financials', 'financial_history_verified.json'), { rows: [], coverage: [] });
  const financialCoverageData = await readJson(path.join(PATHS.data, 'financials', 'financial_coverage_summary.json'), { rows: [] });
  const marketPath = path.join(PATHS.marketCache, `${reportDate}.json`);
  const legacyMarketPath = path.join(PATHS.market, `${reportDate}.json`);
  const marketData = await readJson(await pathExists(marketPath) ? marketPath : legacyMarketPath, { asOf: reportDate, tickers: {}, warnings: ['market adapter has not produced data yet'] });
  const obsidianHits = await readJson(path.join(PATHS.data, 'obsidian_hits.json'), { meta: { status: 'not_configured' }, hits: [], warnings: ['Obsidian 未配置'] });
  const valuationVerified = await readJson(path.join(PATHS.data, 'valuation_verified.json'), { rows: [] });
  const valuationCandidates = await loadValuationCandidates();
  const aliases = await readJson(path.join(PATHS.data, 'company_aliases.json'), {});
  const adapters = await readJson(path.join(PATHS.data, 'adapters.json'), {});
  const supplementalFacts = await readJson(path.join(PATHS.data, 'supplemental_facts.json'), { facts: [] });
  const companyGaps = await readJson(path.join(PATHS.data, 'company_gaps.json'), { gaps: [] });
  return {
    companies: companiesData.companies || [],
    imports: companiesData.imports || [],
    importErrors: companiesData.errors || [],
    eventSummary: eventsData,
    reminders: remindersData.reminders || [],
    aiCapex: aiCapexData.ai_capex || [],
    aiModels: aiModelsData.ai_models || [],
    verifiedModels: verifiedModelsData.rows || [],
    modelReleaseTimeline: modelTimelineData.rows || [],
    financialHistory: financialHistoryData.rows || [],
    financialHistoryCoverage: financialHistoryData.coverage || [],
    financialCoverageSummary: financialCoverageData.rows || [],
    market: marketData,
    obsidianHits,
    valuationVerified: valuationVerified.rows || valuationVerified.verified || [],
    valuationCandidates,
    aliases,
    adapters,
    supplementalFacts: supplementalFacts.facts || [],
    companyGaps: companyGaps.gaps || [],
  };
}

async function loadSnapshotContext() {
  const files = await listFilesRecursive(PATHS.snapshots, ['.json']);
  const sorted = files.sort();
  return {
    latest_file: sorted.at(-1) ? path.relative(PATHS.data, sorted.at(-1)).split(path.sep).join('/') : null,
    latest: sorted.at(-1) ? await readJson(sorted.at(-1), null) : null,
    previous: sorted.length > 1 ? await readJson(sorted.at(-2), null) : null,
  };
}

async function loadValuationCandidates() {
  const dirs = [
    path.join(PATHS.data, 'llm_candidates', 'valuation'),
    path.join(PATHS.data, 'enrichment', 'candidates', 'valuation'),
  ];
  const rows = [];
  for (const dir of dirs) {
    const files = await listFilesRecursive(dir, ['.json']);
    for (const file of files) {
      const payload = await readJson(file, null);
      const candidates = Array.isArray(payload) ? payload : payload?.rows || payload?.candidates || [];
      for (const row of candidates) {
        if (row && typeof row === 'object') {
          rows.push({ ...row, candidate_file: path.relative(PATHS.data, file).split(path.sep).join('/') });
        }
      }
    }
  }
  return rows;
}

function buildReport({ config, reportDate, data, snapshots, webMode }) {
  const factsByTicker = groupBy(data.supplementalFacts, (fact) => tickerKey(fact.ticker));
  const gapsByTicker = new Map((data.companyGaps || []).map((gap) => [tickerKey(gap.ticker), gap]));
  const valuationByTicker = groupBy(data.valuationVerified || [], (row) => tickerKey(row.ticker));
  const valuationCandidatesByTicker = groupBy(data.valuationCandidates || [], (row) => tickerKey(row.ticker));
  const financialHistoryByTicker = groupBy(data.financialHistory || [], (row) => tickerKey(row.ticker));
  const financialCoverageByTicker = new Map((data.financialCoverageSummary || []).map((row) => [tickerKey(row.ticker), row]));
  const enrichedCompanies = data.companies
    .filter((company) => company.status !== 'archived')
    .map((company) => cleanCompanyForReport({
      ...company,
      short_cn: shortCnForCompany(company, data.aliases),
      display_name: displayNameForCompany(company, data.aliases),
      market_data: marketForCompany(company, data.market),
      supplemental_facts: factsByTicker[tickerKey(company.ticker)] || [],
      valuation_verified: valuationByTicker[tickerKey(company.ticker)] || [],
      valuation_candidates: valuationCandidatesByTicker[tickerKey(company.ticker)] || [],
      financial_history_verified: financialHistoryByTicker[tickerKey(company.ticker)] || [],
      financial_coverage: financialCoverageByTicker.get(tickerKey(company.ticker)) || null,
      gap_summary: gapsByTicker.get(tickerKey(company.ticker))?.summary || null,
    }))
    .sort((a, b) => tickerSortKey(a).localeCompare(tickerSortKey(b)));

  const holdingCompanies = enrichedCompanies.filter((company) => company.status === 'holding');
  const eventSummary = normalizeEventSummary(data.eventSummary);
  const overviewRows = buildOverviewRows(enrichedCompanies, eventSummary.events, reportDate);
  const relativeRows = buildRelativeRows(enrichedCompanies, data.market);
  const aiCapexSummary = aggregateAiCapex(data.aiCapex, enrichedCompanies);
  const renderableModels = aggregateModels((data.verifiedModels || []).length ? data.verifiedModels : data.aiModels);
  const obsidianVerified = buildVerifiedObsidianHits(data.obsidianHits.hits || [], enrichedCompanies);
  const valuationTasks = buildValuationTasks(enrichedCompanies, reportDate);
  const valuationTaskByTicker = new Map(valuationTasks.map((task) => [tickerKey(task.ticker), task]));
  enrichedCompanies.forEach((company) => {
    company.valuation_task = valuationTaskByTicker.get(tickerKey(company.ticker)) || null;
    company.gap_summary = naturalGapSummary(company);
  });
  const missingInfo = buildMissingInfoPrompts({ companies: enrichedCompanies, aiCapex: data.aiCapex, aiModels: data.aiModels, eventSummary });
  const dataHealth = buildDataHealth({ companies: enrichedCompanies, renderableModels, market: data.market });
  return {
    meta: {
      title: 'PortMgmt / 美股科技持仓组合',
      portfolio_name: config.portfolio_name || '美股科技持仓组合',
      report_date: reportDate,
      updated_at: new Date().toISOString(),
      timezone: config.report_timezone || process.env.REPORT_TZ || 'Asia/Shanghai',
      web_mode: webMode,
    },
    summary: {
      holding_count: holdingCompanies.length,
      watchlist_count: enrichedCompanies.filter((company) => company.status === 'watchlist').length,
      company_count: enrichedCompanies.length,
      portfolio_return_1d: averageReturn(enrichedCompanies, 'return1d'),
      portfolio_return_5d: averageReturn(enrichedCompanies, 'return5d'),
      overview_rows: overviewRows,
      relative_rows: relativeRows,
      missing_info_prompts: missingInfo.length,
    },
    adapters: data.adapters,
    market: data.market,
    market_live_config: normalizeMarketConfig(config),
    companies: enrichedCompanies,
    event_summary: eventSummary,
    events: eventSummary.events,
    reminders: data.reminders,
    ai_capex: data.aiCapex,
    ai_capex_summary: aiCapexSummary,
    ai_models: data.aiModels,
    renderable_models: renderableModels,
    model_release_timeline: normalizeModelTimeline(data.modelReleaseTimeline || []),
    obsidian_hits: obsidianVerified,
    obsidian_hits_raw_count: (data.obsidianHits.hits || []).length,
    valuation_tasks: valuationTasks,
    library: {
      imports: data.imports,
      errors: data.importErrors,
      obsidian_verified_count: obsidianVerified.length,
      coverage_notes: buildCoverageNotes(data, enrichedCompanies),
    },
    data_quality: buildDataQuality({ data, companies: enrichedCompanies, eventSummary, renderableModels, missingInfo, reportDate }),
    data_health: dataHealth,
    missing_info_prompt: missingInfo,
    watchlist: normalizeWatchlist(config.watchlist || []),
    snapshots,
  };
}

function normalizeMarketConfig(config = {}) {
  const market = config.market || {};
  return {
    live_refresh_enabled: market.live_refresh_enabled !== false,
    live_endpoint: market.live_endpoint || '/market_live.json',
    fallback_endpoint: market.fallback_endpoint || 'data/market_live/latest.json',
    refresh_timeout_ms: market.refresh_timeout_ms || 10000,
    benchmarks: market.benchmarks || config.benchmark_tickers || ['QQQ'],
    mag7: market.mag7 || config.mag7_tickers || ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA'],
  };
}

function normalizeWatchlist(items = []) {
  return asArray(items)
    .filter((item) => item && item.ticker)
    .map((item) => ({
      ticker: item.ticker,
      company_name: item.company_name || item.ticker,
      status: ['watching', 'holding', 'archived'].includes(item.status) ? item.status : 'watching',
      is_holding: item.is_holding === true,
      priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
      sector_tags: asArray(item.sector_tags),
      init_status: ['pending', 'candidate_ready', 'verified', 'rejected'].includes(item.init_status) ? item.init_status : 'pending',
      added_at: item.added_at || null,
      updated_at: item.updated_at || item.added_at || null,
      notes: item.notes || null,
      exchange: item.exchange || null,
      website: item.website || null,
      ir_url: item.ir_url || item.ir_page || null,
      core_positioning: item.core_positioning || null,
      profile_candidate_path: item.profile_candidate_path || null,
    }))
    .sort((a, b) => (a.status === 'archived') - (b.status === 'archived') || priorityRank(a.priority) - priorityRank(b.priority) || a.ticker.localeCompare(b.ticker));
}

function priorityRank(priority = '') {
  return priority === 'high' ? 0 : priority === 'medium' ? 1 : 2;
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function cleanCompanyForReport(company) {
  const guidanceAudit = auditGuidanceForCompany(company);
  return {
    ...company,
    revenue_breakdown: normalizeRevenueBreakdown(company.revenue_breakdown || [], company),
    financials: cleanFinancialsForReport(company.financials || {}),
    guidance: guidanceAudit.verified,
    guidance_rejected: guidanceAudit.rejected,
    capital_structure: {
      ...(company.capital_structure || {}),
      ...normalizedCapitalStructure(company),
    },
    risks: normalizeCompanyRisks(company),
  };
}

function normalizeRevenueBreakdown(rows = [], company = {}) {
  return asArray(rows).map((item) => {
    const amountDisplay = businessAmountDisplay(item.display || item.revenue_value_display || item.revenue || '', company);
    const shareDisplay = businessShareDisplay(item.share_display || item.share || (!amountDisplay ? item.revenue : ''));
    return {
      ticker: company.ticker,
      segment: cleanVisibleText(item.segment || item.business_segment || item.name || ''),
      period: normalizeBusinessPeriod(item.period || item.fiscal_year || item.date || ''),
      revenue_value: revenueAmountValue(item.revenue_value ?? item.revenue, company),
      currency: item.currency || companyCurrency(company),
      display: amountDisplay || null,
      share_display: shareDisplay || null,
      yoy_display: optionalVisibleText(item.yoy_display || item.yoy || item.growth),
      note: optionalVisibleText(item.note || item.business_split),
      source_title: item.source_title || (item.source ? `Profile business split ${item.source}` : null),
      source_url: item.source_url || item.original_url || item.source || null,
      confidence: normalizeEvidenceConfidence(item.confidence),
    };
  }).filter((item) => item.segment && (item.display || item.share_display || item.note || item.business_split));
}

function normalizeBusinessPeriod(value = '') {
  const clean = cleanVisibleText(value);
  if (!clean || clean === '—' || clean === '-') return null;
  const fyq = clean.match(/\bFY(20\d{2})Q([1-4])\b/i);
  if (fyq) return `FY${fyq[1]}Q${fyq[2]}`;
  const fy = clean.match(/\bFY?20\d{2}\b/i);
  return fy ? fy[0].replace(/^F(?!Y)/i, 'FY') : clean;
}

function optionalVisibleText(value = '') {
  const clean = cleanVisibleText(value);
  return clean && clean !== '—' && clean !== '-' ? clean : null;
}

function normalizeEvidenceConfidence(value = '') {
  const text = String(value || '').toLowerCase();
  if (['high', 'medium', 'low'].includes(text)) return text;
  if (text === 'profile') return 'medium';
  return 'medium';
}

function revenueAmountValue(value = '', company = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100000000);
  const clean = cleanVisibleText(value);
  if (!clean || clean === '—' || clean === '-' || /%/.test(clean)) return null;
  const number = Number(clean.replace(/,/g, '').replace(/^约|^~/, '').replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(number)) return null;
  if (/万亿/.test(clean)) return Math.round(number * 1000000000000);
  if (/\b(?:B|billion)\b/i.test(clean)) return Math.round(number * 1000000000);
  if (/\b(?:M|million)\b/i.test(clean)) return Math.round(number * 1000000);
  return Math.round(number * 100000000);
}

function cleanFinancialsForReport(financials = {}) {
  const cleanAnnual = asArray(financials.annual)
    .filter((record) => /^(?:FY)?20\d{2}$/.test(String(record.fiscal_year || '')))
    .map((record) => {
      const out = { ...record };
      for (const key of ['revenue', 'net_income', 'fcf', 'debt', 'net_debt']) {
        if (financialValueMismatch(key === 'net_debt' ? 'debt' : key, out[key])) out[key] = null;
      }
      return out;
    });
  const cleanLatest = asArray(financials.latest)
    .map((row) => {
      if (['revenue', 'net_income', 'fcf', 'debt'].includes(row.metric) && financialValueMismatch(row.metric, row.value)) {
        return { ...row, value: null };
      }
      return row;
    })
    .filter((row) => row.value !== null);
  return {
    ...financials,
    annual: cleanAnnual,
    latest: cleanLatest,
  };
}

function normalizeCompanyGuidance(company) {
  return auditGuidanceForCompany(company).verified;
}

function auditGuidanceForCompany(company) {
  const candidates = guidanceCandidatesForCompany(company);
  const rejected = [];
  const verified = [];
  for (const candidate of candidates) {
    const normalized = normalizeGuidanceRow(candidate);
    const reason = guidanceRejectReason(normalized);
    if (reason) {
      rejected.push({
        ticker: company.ticker,
        company: company.company_name || company.display_name,
        raw_text: cleanVisibleText([candidate.rawValue, candidate.note].filter(Boolean).join('；')),
        reason,
        suggested_action: guidanceSuggestedAction(normalized.metric),
      });
      continue;
    }
    verified.push({
      date: normalizeGuidanceDate(normalized.date, normalized.period),
      period: normalizeGuidancePeriod(normalized.period),
      metric: normalized.metric,
      guidance_value: normalized.value,
      previous_guidance: normalized.previous || null,
      actual_value: normalized.actual || null,
      beat_miss: normalized.beat || '待验证',
      comment: guidanceComment(normalized),
      value: normalized.value,
      summary: guidanceComment(normalized),
    });
  }
  return {
    verified: dedupeBy(verified, (item) => `${item.date}|${item.period}|${item.metric}|${item.guidance_value}`).slice(0, 10),
    rejected,
  };
}

function guidanceCandidatesForCompany(company) {
  const guidanceRows = asArray(company.guidance).map((item) => ({
    date: item.date || extractDateFromText(item.summary) || null,
    period: item.period || inferPeriodFromText(item.summary),
    metric: metricLabel(item.metric || item.summary),
    rawValue: item.guidance_value || item.value || item.summary,
    previous: item.previous_guidance || null,
    actual: item.actual_value || null,
    beat: item.beat_miss || '待验证',
    note: item.comment || item.summary || item.direction,
  }));
  const supplementalRows = asArray(company.supplemental_facts)
    .filter((fact) => /guidance|outlook|capacity|order|backlog|FCF|指引|产能|订单/i.test(`${fact.field} ${fact.value}`))
    .filter((fact) => !/actual|quarterly_CAPEX|annual_CAPEX|Latest Quarterly|capital_expenditure_actual|实际值/i.test(`${fact.field} ${fact.value}`))
    .slice(0, 10)
    .map((fact) => ({
      date: fact.period,
      period: fact.period,
      metric: metricLabel(fact.field),
      rawValue: fact.value,
      previous: /revision/i.test(fact.field) ? '见前次披露' : null,
      actual: /actual|quarterly/i.test(fact.field) ? fact.value : null,
      beat: /actual|quarterly/i.test(fact.field) ? '符合' : '待验证',
      note: fact.notes,
    }));
  return [...supplementalRows, ...guidanceRows];
}

function normalizeEventSummary(input = {}) {
  const events = (input.events || []).map((event) => ({
    ...event,
    date: event.date || mmdd(event.date_iso),
  })).sort((a, b) => (b.date_iso || '').localeCompare(a.date_iso || '') || String(a.ticker).localeCompare(String(b.ticker)));
  return {
    meta: input.meta || {},
    events,
    company_news: events.filter((event) => event.type === '公司新闻'),
    company_announcements: events.filter((event) => event.type === '公司公告'),
    industry_background: events.filter((event) => event.type === '行业背景'),
    market_factors: events.filter((event) => event.type === '市场/板块因素'),
  };
}

function marketForCompany(company, market) {
  const keys = [
    company.yfinance_ticker,
    company.yfinanceTicker,
    company.display_ticker,
    company.displayTicker,
    company.ticker,
    String(company.ticker || '').replace(/\.(O|N|US)$/i, ''),
  ].filter(Boolean);
  for (const key of keys) {
    if (market?.tickers?.[key]) return market.tickers[key];
  }
  return { dataQuality: 'missing', warnings: ['market data missing'] };
}

function shortCnForCompany(company, aliases = {}) {
  return company.chinese_name || aliases[company.ticker]?.short_cn || aliases[company.display_ticker]?.short_cn || null;
}

function displayNameForCompany(company, aliases = {}) {
  if (tickerKey(company.ticker) === 'SAMSUNG') return '005930.KS · 三星电子';
  const alias = aliases[company.ticker] || aliases[company.display_ticker];
  if (alias?.display) return alias.display;
  const shortCn = shortCnForCompany(company, aliases);
  return shortCn ? `${company.ticker} · ${shortCn}` : `${company.ticker} · ${company.company_name || company.display_ticker || company.ticker}`;
}

function buildOverviewRows(companies, events, reportDate) {
  return companies.map((company) => {
    const market = company.market_data || {};
    const driver = driverInfoForCompany(company, events, reportDate);
    return {
      ticker: company.ticker,
      stock: company.display_name || company.ticker,
      price: market.price,
      marketCapDisplay: market.marketCapDisplay,
      return1d: market.return1d,
      return5d: market.return5d,
      return20d: market.return20d,
      returnYtd: market.returnYtd,
      driver_type: driver.driver_type,
      driver_label: driver.driver_label,
      driver_summary: driver.summary,
      driver_confidence: driver.confidence,
      source_title: driver.source_title,
      source_url: driver.source_url,
      driver: `[${driver.driver_label}] ${driver.summary}`,
    };
  });
}

function driversForCompany(company, events = [], reportDate = '') {
  return driverInfoForCompany(company, events, reportDate).summary;
}

function driverInfoForCompany(company, events = [], reportDate = '') {
  const ticker = company.ticker;
  const rows = events
    .filter((event) => tickerKey(event.ticker) === tickerKey(ticker))
    .filter(isDriverEvent)
    .sort((a, b) => (b.date_iso || '').localeCompare(a.date_iso || ''))
    .slice(0, 2)
    .map((event) => driverFromEvent(event))
    .filter((item) => item && !looksLikeResearchTitle(item.summary));
  if (rows.length) {
    const primary = rows[0];
    return {
      ...primary,
      summary: rows.map((item) => item.summary).join('；'),
      confidence: rows.some((item) => item.confidence === 'high') ? 'high' : 'medium',
    };
  }
  const date = reportDate ? mmdd(reportDate) : '今日';
  const return1d = company.market_data?.return1d;
  if (typeof return1d === 'number' && return1d <= -3) {
    return {
      ticker,
      date: reportDate || null,
      driver_type: 'market_background',
      driver_label: '市场背景',
      summary: `${date} 随纳指和AI链回调，暂无可确认公司级负面事件。`,
      confidence: 'medium',
      source_title: 'market cache',
      source_url: null,
    };
  }
  return {
    ticker,
    date: reportDate || null,
    driver_type: 'none',
    driver_label: '暂无高置信驱动',
    summary: '暂无可确认公司级驱动；可能受板块回调影响。',
    confidence: 'medium',
    source_title: 'event summary',
    source_url: null,
  };
}

function driverFromEvent(event = {}) {
  const text = `${event.event || ''} ${event.type || ''}`;
  let driverType = 'company_event';
  let driverLabel = '公司事件';
  if (/财报|业绩|指引|EPS|收入|毛利率|利润/i.test(text)) {
    driverType = 'earnings_guidance';
    driverLabel = '财报/指引';
  } else if (/AI基建|产能|资本开支|Capex|数据中心|订单|供应链/i.test(text)) {
    driverType = 'industry_chain';
    driverLabel = '行业链';
  } else if (/收购|合作|分红|回购|任命|诉讼|监管/i.test(text)) {
    driverType = 'company_event';
    driverLabel = '公司事件';
  }
  return {
    ticker: event.ticker,
    date: event.date_iso || null,
    driver_type: driverType,
    driver_label: driverLabel,
    summary: `${event.date || mmdd(event.date_iso)} ${compactDriverText(event.event)}`,
    confidence: event.importance === '高' ? 'high' : 'medium',
    source_title: event.source_title || event.origin || event.type || 'event summary',
    source_url: event.source_url || event.original_url || null,
  };
}

function isDriverEvent(event) {
  const text = `${event.type || ''} ${event.event || ''} ${event.importance || ''} ${event.origin || ''} ${event.source_kind || ''}`;
  if (/obsidian|研究|纪要|外资观点|前瞻|策略|深度|行业/i.test(text)) return false;
  if (/模型发布|Qwen|Claude|Gemini|GPT|Date approximate|released/i.test(text)) return false;
  return event.type === '公司公告' || /财报|指引|公告|订单|收购|合作|上调|下调|产能|资本开支|收入|利润|股息|回购/i.test(text);
}

function buildRelativeRows(companies, market) {
  const portfolio1d = averageReturn(companies, 'return1d');
  const portfolio5d = averageReturn(companies, 'return5d');
  const qqq = market?.tickers?.QQQ || {};
  const mag7 = market?.benchmarks?.mag7_average || {};
  return [
    ['组合平均', portfolio1d, portfolio5d, 'percent'],
    ['QQQ', qqq.return1d, qqq.return5d, 'percent'],
    ['MAG7平均', mag7.return1d, mag7.return5d, 'percent'],
    ['组合 - QQQ', diff(portfolio1d, qqq.return1d), diff(portfolio5d, qqq.return5d), 'points'],
    ['组合 - MAG7', diff(portfolio1d, mag7.return1d), diff(portfolio5d, mag7.return5d), 'points'],
  ];
}

function renderMarkdown(report) {
  const lines = [
    `# ${report.meta.title}`,
    '',
    `- 报告日期：${report.meta.report_date}`,
    `- 更新时间：${report.meta.updated_at}`,
    '',
    '## 组合总览',
    ...report.summary.overview_rows.map((item) => `- ${item.stock}：1D ${formatPercent(item.return1d)} / 5D ${formatPercent(item.return5d)}；${item.driver}`),
    '',
    '## 事件汇总',
    ...report.event_summary.events.slice(0, 80).map((event) => `- ${event.date} ${event.ticker} ${event.type} ${event.event}`),
  ];
  return `${lines.join('\n')}\n`;
}

function renderHtml(report) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(report.meta.title)} - ${escapeHtml(report.meta.report_date)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f5f7f8;
      --bg-elevated: #ffffff;
      --bg-soft: #edf2f4;
      --text: #17202a;
      --muted: #667085;
      --border: #d9e0e6;
      --accent: #0f766e;
      --accent-soft: #d9f0ed;
      --positive: #11835c;
      --negative: #b42318;
      --warning: #b54708;
      --shadow: 0 10px 24px rgba(16, 24, 40, 0.07);
      --radius: 8px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #101317;
        --bg-elevated: #171b21;
        --bg-soft: #20262d;
        --text: #e6edf3;
        --muted: #a6b0bd;
        --border: #2d3742;
        --accent: #3fb7a7;
        --accent-soft: #143c38;
        --positive: #48c78e;
        --negative: #ff7b72;
        --warning: #f7b955;
        --shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.55; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .shell { max-width: 1360px; margin: 0 auto; padding: 24px 18px 48px; }
    .header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: end; margin-bottom: 16px; }
    h1, h2, h3 { margin: 0; line-height: 1.18; letter-spacing: 0; }
    h1 { font-size: clamp(26px, 4vw, 40px); }
    h2 { font-size: 20px; margin-bottom: 12px; }
    h3 { font-size: 15px; margin-bottom: 10px; }
    .eyebrow { color: var(--muted); font-size: 13px; margin-bottom: 6px; }
    .muted { color: var(--muted); }
    .header-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .pill, .badge { display: inline-flex; align-items: center; gap: 5px; min-height: 24px; padding: 3px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-elevated); color: var(--muted); font-size: 12px; white-space: nowrap; }
    .pill.strong { color: var(--text); border-color: var(--accent); background: var(--accent-soft); }
    .tabs { position: sticky; top: 0; z-index: 20; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; padding: 8px; margin: 0 0 16px; background: color-mix(in srgb, var(--bg), transparent 8%); border: 1px solid var(--border); border-radius: var(--radius); backdrop-filter: blur(14px); }
    button { font: inherit; }
    .tab, .ticker-tab { min-height: 36px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--muted); cursor: pointer; padding: 6px 10px; }
    .tab:hover, .ticker-tab:hover { border-color: var(--border); color: var(--text); background: var(--bg-elevated); }
    .tab.active, .ticker-tab.active { color: var(--text); border-color: var(--accent); background: var(--accent-soft); }
    .panel { display: none; }
    .panel.active { display: block; }
    .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 12px; }
    .card { grid-column: span 4; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px; min-width: 0; }
    .card.wide { grid-column: span 8; }
    .card.full { grid-column: 1 / -1; }
    .section-line { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }
    .company-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .company-panel { display: none; }
    .company-panel.active { display: block; }
    .company-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .market-line { margin-top: 5px; color: var(--muted); font-size: 12px; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .section-head h2 { margin-bottom: 0; }
    .refresh-tools { display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
    .market-refresh { min-height: 30px; padding: 5px 10px; border: 1px solid var(--accent); border-radius: 7px; background: var(--accent-soft); color: var(--text); cursor: pointer; }
    .market-refresh[disabled] { opacity: 0.65; cursor: wait; }
    .refresh-status { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .refresh-missing { color: var(--warning); font-size: 12px; }
    .refresh-missing summary { cursor: pointer; }
    .refresh-missing-list { max-width: 360px; margin-top: 4px; white-space: normal; color: var(--muted); }
    .stale-marker { margin-left: 4px; color: var(--warning); font-size: 11px; }
    .tag-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .data-health-card .table-wrap { margin-top: 4px; }
    .health-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 42px; min-height: 22px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; }
    .health-ok { color: var(--positive); background: color-mix(in srgb, var(--positive), transparent 88%); border-color: color-mix(in srgb, var(--positive), transparent 55%); }
    .health-warning { color: var(--warning); background: color-mix(in srgb, var(--warning), transparent 88%); border-color: color-mix(in srgb, var(--warning), transparent 55%); }
    .health-error { color: var(--negative); background: color-mix(in srgb, var(--negative), transparent 88%); border-color: color-mix(in srgb, var(--negative), transparent 55%); }
    .table-wrap { width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
    .table-note { margin: 6px 0 0; color: var(--muted); font-size: 12px; }
    .financial-low-warning { color: var(--warning); }
    .financial-details, .model-observation { margin-top: 8px; border: 1px dashed var(--border); border-radius: 6px; padding: 8px 10px; background: var(--bg-soft); }
    .financial-details summary, .model-observation summary { cursor: pointer; color: var(--accent); }
    .financial-details .table-wrap, .model-observation .table-wrap { margin-top: 8px; }
    .data-table { width: 100%; border-collapse: collapse; background: var(--bg-elevated); }
    .wide-table { min-width: 980px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 650; background: var(--bg-soft); }
    tr:last-child td { border-bottom: 0; }
    .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .nowrap { white-space: nowrap; }
    .text-col { max-width: 420px; }
    .empty { color: var(--muted); }
    .company-sections { display: grid; gap: 14px; margin-top: 12px; }
    .company-section { border-top: 1px solid var(--border); padding-top: 12px; min-width: 0; }
    .gap-card { border: 1px dashed var(--border); border-radius: 6px; background: var(--bg-soft); padding: 10px; }
    .valuation-task { margin-top: 8px; border: 1px dashed var(--border); border-radius: 6px; padding: 8px 10px; background: var(--bg-soft); }
    .valuation-task summary { cursor: pointer; color: var(--accent); }
    .valuation-task pre { margin: 8px 0 0; white-space: pre-wrap; font-family: var(--mono); font-size: 12px; color: var(--muted); }
    .direction-positive { color: var(--positive); }
    .direction-negative { color: var(--negative); }
    .direction-neutral { color: var(--muted); }
    .small-list { margin: 0; padding-left: 18px; }
    .small-list li { margin: 3px 0; }
    .library-table td { font-family: var(--mono); font-size: 12px; }
    .letter-a, .letter-f, .letter-k, .letter-p, .letter-u, .letter-z { color: #0f766e; font-weight: 750; }
    .letter-b, .letter-g, .letter-l, .letter-q, .letter-v { color: #7c3aed; font-weight: 750; }
    .letter-c, .letter-h, .letter-m, .letter-r, .letter-w { color: #b54708; font-weight: 750; }
    .letter-d, .letter-i, .letter-n, .letter-s, .letter-x { color: #2563eb; font-weight: 750; }
    .letter-e, .letter-j, .letter-o, .letter-t, .letter-y { color: #b42318; font-weight: 750; }
    @media (max-width: 980px) {
      .header { grid-template-columns: 1fr; }
      .header-actions { justify-content: flex-start; }
      .tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .card, .card.wide { grid-column: 1 / -1; }
      .section-head { align-items: flex-start; flex-direction: column; }
      .refresh-tools { justify-content: flex-start; }
    }
    @media (max-width: 680px) {
      .shell { padding: 16px 10px 36px; }
      .tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .table-wrap { border-radius: 6px; }
      table, thead, tbody, tr, th, td { display: block; }
      thead { display: none; }
      tr { border-bottom: 1px solid var(--border); padding: 8px 0; }
      td { border: 0; display: grid; grid-template-columns: 118px minmax(0, 1fr); gap: 8px; padding: 6px 10px; }
      td::before { content: attr(data-label); color: var(--muted); font-size: 12px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    ${renderHeader(report)}
    ${renderTabs()}
    <section id="overview" class="panel active">${renderOverview(report)}</section>
    <section id="companies" class="panel">${renderCompanies(report)}</section>
    <section id="events" class="panel">${renderEvents(report)}</section>
    <section id="capex" class="panel">${renderCapex(report)}</section>
    <section id="models" class="panel">${renderModels(report)}</section>
    <section id="library" class="panel">${renderLibrary(report)}</section>
  </main>
  <script>
    document.querySelectorAll('.tab[data-panel]').forEach(function (button) {
      button.addEventListener('click', function () {
        document.querySelectorAll('.tab[data-panel]').forEach(function (item) { item.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (item) { item.classList.remove('active'); });
        button.classList.add('active');
        document.getElementById(button.dataset.panel).classList.add('active');
      });
    });
    document.querySelectorAll('.ticker-tab[data-company]').forEach(function (button) {
      button.addEventListener('click', function () {
        document.querySelectorAll('.ticker-tab[data-company]').forEach(function (item) { item.classList.remove('active'); });
        document.querySelectorAll('.company-panel').forEach(function (item) { item.classList.remove('active'); });
        button.classList.add('active');
        document.getElementById(button.dataset.company).classList.add('active');
      });
    });
    var MARKET_LIVE_CONFIG = ${scriptJson(report.market_live_config || {})};
    var marketRefreshButton = document.querySelector('[data-market-refresh]');
    if (marketRefreshButton) {
      marketRefreshButton.addEventListener('click', refreshMarket);
    }
    function refreshMarket() {
      if (!MARKET_LIVE_CONFIG.live_refresh_enabled) {
        setRefreshStatus('当前部署模式不支持实时刷新，请运行 npm run market:live 生成最新行情。');
        return;
      }
      if (marketRefreshButton) marketRefreshButton.disabled = true;
      setRefreshStatus('刷新中...');
      fetchMarketPayload()
        .then(function (payload) {
          var result = applyMarketData(payload);
          var marketTime = timeFromPayload(payload);
          var refreshedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
          var stale = marketPayloadIsStale(payload);
          var suffix = stale ? '；行情可能滞后' : '';
          setRefreshStatus('上次刷新：' + refreshedAt + '；行情时间：' + marketTime + suffix, result.details);
        })
        .catch(function (error) {
          var reason = error && error.message ? error.message : '未知错误';
          setRefreshStatus('刷新失败：' + shortReason(reason), []);
        })
        .finally(function () {
          if (marketRefreshButton) marketRefreshButton.disabled = false;
        });
    }
    function fetchMarketPayload() {
      var endpoints = [
        window.MARKET_LIVE_ENDPOINT,
        MARKET_LIVE_CONFIG.live_endpoint,
        MARKET_LIVE_CONFIG.fallback_endpoint,
        '../market_live.json',
        'market_live.json',
        '../../data/market_live/latest.json'
      ].filter(Boolean);
      var unique = endpoints.filter(function (endpoint, index, arr) { return arr.indexOf(endpoint) === index; });
      var lastError = null;
      return unique.reduce(function (chain, endpoint) {
        return chain.catch(function () {
          return fetchWithTimeout(endpoint, MARKET_LIVE_CONFIG.refresh_timeout_ms || 10000)
            .then(function (response) {
              if (!response.ok) throw new Error(endpoint + ' HTTP ' + response.status);
              return response.json();
            });
        }).catch(function (error) {
          lastError = error;
          throw error;
        });
      }, Promise.reject(new Error('start'))).catch(function () {
        if (lastError && /404|Failed to fetch|Load failed|Not allowed|CORS/i.test(lastError.message || '')) {
          throw new Error('当前部署模式不支持实时刷新，请运行 npm run market:live 生成最新行情。');
        }
        throw lastError || new Error('当前部署模式不支持实时刷新，请运行 npm run market:live 生成最新行情。');
      });
    }
    function fetchWithTimeout(url, timeoutMs) {
      var controller = window.AbortController ? new AbortController() : null;
      var timer = controller ? window.setTimeout(function () { controller.abort(); }, timeoutMs) : null;
      return fetch(url, controller ? { cache: 'no-store', signal: controller.signal } : { cache: 'no-store' })
        .finally(function () { if (timer) window.clearTimeout(timer); });
    }
    function applyMarketData(payload) {
      var quoteMap = new Map();
      (payload.quotes || []).forEach(function (quote) {
        [quote.ticker, quote.display_ticker, quote.symbol].filter(Boolean).forEach(function (key) {
          quoteMap.set(tickerKey(key), quote);
        });
      });
      if (payload.tickers) {
        Object.keys(payload.tickers).forEach(function (key) {
          var quote = payload.tickers[key] || {};
          quoteMap.set(tickerKey(key), legacyQuoteToLive(key, quote));
        });
      }
      var missing = 0;
      var details = [];
      document.querySelectorAll('[data-ticker][data-market-field]').forEach(function (node) {
        var quote = quoteMap.get(tickerKey(node.dataset.ticker));
        if (!quote) {
          missing += 1;
          details.push(missingLabelForNode(node, '缺 quote'));
          return;
        }
        var value = quoteValue(quote, node.dataset.marketField);
        if (value === null || value === undefined || value === '') {
          missing += 1;
          details.push(missingLabelForNode(node, node.dataset.marketField));
          if (node.dataset.marketField === 'market_cap') markStaleMarketCap(node);
          return;
        }
        setMarketNode(node, value, node.dataset.marketField);
      });
      var portfolio = payload.portfolio || {};
      document.querySelectorAll('[data-portfolio-field]').forEach(function (node) {
        var field = node.dataset.portfolioField;
        var value = portfolio[field];
        if (value === null || value === undefined || value === '') {
          missing += 1;
          details.push('组合.' + field);
          return;
        }
        setPortfolioNode(node, value, field);
      });
      if (payload.errors && payload.errors.length) {
        console.warn('market refresh warnings', payload.errors);
      }
      return { missing: missing, details: details };
    }
    function legacyQuoteToLive(key, quote) {
      return {
        ticker: quote.portfolioTicker || key,
        display_ticker: quote.displayTicker || key,
        symbol: quote.symbol || key,
        price: quote.price,
        market_cap: quote.marketCapDisplay || quote.marketCap,
        return_1d: quote.return1d,
        return_5d: quote.return5d,
        return_20d: quote.return20d,
        return_ytd: quote.returnYtd,
        vs_qqq_1d: quote.relativeToQQQ1d,
        updated_at: quote.updatedAt
      };
    }
    function quoteValue(quote, field) {
      var map = {
        price: quote.price,
        market_cap: quote.market_cap || quote.marketCapDisplay || quote.marketCap,
        return_1d: quote.return_1d,
        return_5d: quote.return_5d,
        return_20d: quote.return_20d,
        return_ytd: quote.return_ytd,
        vs_qqq_1d: quote.vs_qqq_1d
      };
      return map[field];
    }
    function setMarketNode(node, value, field) {
      var text = field === 'market_cap' ? formatMarketCap(value) : (/return_|vs_qqq/.test(field) ? formatPercent(value) : displayNumber(value));
      node.textContent = text;
      setDirectionClass(node, /return_|vs_qqq/.test(field) ? value : null);
    }
    function markStaleMarketCap(node) {
      var text = node.textContent.trim();
      if (!text || text === '—') return;
      if (!/旧$/.test(text)) node.innerHTML = escapeHtmlJs(text) + '<span class="stale-marker">旧</span>';
    }
    function setPortfolioNode(node, value, field) {
      var isRelative = /^relative_/.test(field);
      node.textContent = isRelative ? formatPoints(value) : formatPercent(value);
      setDirectionClass(node, value);
    }
    function setDirectionClass(node, value) {
      node.classList.remove('direction-positive', 'direction-negative', 'direction-neutral', 'empty');
      var number = Number(value);
      if (!Number.isFinite(number)) {
        node.classList.add('empty');
      } else if (number > 0) {
        node.classList.add('direction-positive');
      } else if (number < 0) {
        node.classList.add('direction-negative');
      } else {
        node.classList.add('direction-neutral');
      }
    }
    function formatPercent(value) {
      var number = Number(value);
      if (!Number.isFinite(number)) return '—';
      return (number > 0 ? '+' : '') + number.toFixed(2).replace(/\\.00$/, '') + '%';
    }
    function formatPoints(value) {
      var number = Number(value);
      if (!Number.isFinite(number)) return '—';
      return (number > 0 ? '+' : '') + number.toFixed(2).replace(/\\.00$/, '') + ' pct';
    }
    function formatMarketCap(value) {
      if (typeof value === 'string') return value || '—';
      var number = Number(value);
      if (!Number.isFinite(number)) return '—';
      var abs = Math.abs(number);
      if (abs >= 1e12) return (number / 1e12).toFixed(2) + 'T';
      if (abs >= 1e9) return (number / 1e9).toFixed(2) + 'B';
      if (abs >= 1e6) return (number / 1e6).toFixed(2) + 'M';
      return String(Math.round(number));
    }
    function displayNumber(value) {
      var number = Number(value);
      if (!Number.isFinite(number)) return value || '—';
      return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    function setRefreshStatus(text, details) {
      var node = document.querySelector('[data-refresh-status]');
      if (node) node.textContent = text;
      var detailsBox = document.querySelector('[data-refresh-missing]');
      var summary = document.querySelector('[data-refresh-missing-summary]');
      var list = document.querySelector('[data-refresh-missing-list]');
      var items = (details || []).filter(Boolean);
      if (!detailsBox || !summary || !list) return;
      if (!items.length) {
        detailsBox.hidden = true;
        detailsBox.removeAttribute('title');
        list.textContent = '';
        return;
      }
      var unique = items.filter(function (item, index, arr) { return arr.indexOf(item) === index; });
      detailsBox.hidden = false;
      detailsBox.title = unique.join('；');
      summary.textContent = '缺失：' + unique.length + '项';
      list.textContent = unique.join('；');
    }
    function timeFromPayload(payload) {
      var raw = payload.as_of || payload.updated_at || new Date().toISOString();
      var date = new Date(raw);
      if (Number.isNaN(date.getTime())) return new Date().toLocaleTimeString('zh-CN', { hour12: false });
      return date.toLocaleTimeString('zh-CN', { hour12: false });
    }
    function shortReason(text) {
      return String(text || '').replace(/\\s+/g, ' ').slice(0, 80);
    }
    function missingLabelForNode(node, reason) {
      return (node.dataset.ticker || 'unknown') + '.' + (reason || node.dataset.marketField || 'field');
    }
    function marketPayloadIsStale(payload) {
      var raw = payload.as_of || payload.updated_at;
      var date = new Date(raw);
      if (Number.isNaN(date.getTime())) return false;
      return Date.now() - date.getTime() > 15 * 60 * 1000;
    }
    function escapeHtmlJs(text) {
      return String(text || '').replace(/[&<>"']/g, function (char) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
      });
    }
    function tickerKey(value) {
      return String(value || '').toUpperCase().replace(/\\.(O|N|US|DF)$/i, '').replace(/[^A-Z0-9]/g, '');
    }
  </script>
</body>
</html>`;
}

function renderHeader(report) {
  const archive = report.meta.web_mode ? '<a class="pill" href="../archive.html">Archive</a>' : '';
  return `<header class="header">
    <div>
      <div class="eyebrow">${escapeHtml(report.meta.portfolio_name)} · ${escapeHtml(report.meta.timezone)}</div>
      <h1>PortMgmt / 美股科技持仓组合</h1>
      <div class="muted">报告日期 ${escapeHtml(report.meta.report_date)} · 更新时间 ${escapeHtml(report.meta.updated_at)}</div>
    </div>
    <div class="header-actions">
      <span class="pill strong">持仓 ${escapeHtml(report.summary.holding_count)}</span>
      <span class="pill">组合1D ${portfolioField('return_1d_avg', report.summary.portfolio_return_1d, 'percent')}</span>
      <span class="pill">组合5D ${portfolioField('return_5d_avg', report.summary.portfolio_return_5d, 'percent')}</span>
      ${archive}
    </div>
  </header>`;
}

function renderTabs() {
  const tabs = [
    ['overview', '组合总览'],
    ['companies', '持仓追踪'],
    ['events', '事件汇总'],
    ['capex', 'AI Capex'],
    ['models', '模型发布'],
    ['library', '资料库'],
  ];
  return `<nav class="tabs">${tabs.map(([id, label], index) => `<button class="tab ${index === 0 ? 'active' : ''}" data-panel="${id}">${label}</button>`).join('')}</nav>`;
}

function renderOverview(report) {
  const rows = report.summary.overview_rows.map((item) => [
    value(item.stock),
    marketField(item.ticker, 'price', item.price),
    marketField(item.ticker, 'market_cap', item.marketCapDisplay),
    marketField(item.ticker, 'return_1d', item.return1d, 'percent'),
    marketField(item.ticker, 'return_5d', item.return5d, 'percent'),
    marketField(item.ticker, 'return_20d', item.return20d, 'percent'),
    marketField(item.ticker, 'return_ytd', item.returnYtd, 'percent'),
    value(item.driver),
  ]);
  const relFields = [
    ['return_1d_avg', 'return_5d_avg'],
    ['qqq_return_1d', 'qqq_return_5d'],
    ['mag7_return_1d_avg', 'mag7_return_5d_avg'],
    ['relative_qqq_1d', 'relative_qqq_5d'],
    ['relative_mag7_1d', 'relative_mag7_5d'],
  ];
  const relRows = report.summary.relative_rows.map(([label, one, five, type], index) => [
    value(label),
    portfolioField(relFields[index]?.[0] || `relative_${index}_1d`, one, type),
    portfolioField(relFields[index]?.[1] || `relative_${index}_5d`, five, type),
  ]);
  return `<div class="grid">
    ${dataHealthCard(report.data_health)}
    <article class="card full">
      <div class="section-head">
        <h2>总览表</h2>
        <div class="refresh-tools">
          <button class="market-refresh" type="button" data-market-refresh>刷新行情</button>
          <span class="refresh-status" data-refresh-status>上次刷新：${escapeHtml(timeDisplay(report.market?.updatedAt || report.meta.updated_at))}；行情时间：${escapeHtml(timeDisplay(report.market?.updatedAt || report.meta.updated_at))}</span>
          <details class="refresh-missing" data-refresh-missing hidden>
            <summary data-refresh-missing-summary>缺失：0项</summary>
            <div class="refresh-missing-list" data-refresh-missing-list></div>
          </details>
        </div>
      </div>
      ${table(['股票', 'Price', 'MCap', '1D', '5D', '20D', 'YTD', '驱动因素'], rows, true, { wide: true })}
    </article>
    <article class="card full">
      <h2>相对表现</h2>
      ${table(['口径', '1D', '5D'], relRows, true)}
    </article>
  </div>`;
}

function dataHealthCard(health = {}) {
  const lowFinancial = asArray(health.low_financial_coverage).map((item) => `${item.ticker} ${Math.round(Number(item.pct || 0) * 100)}%`);
  const marketGaps = asArray(health.market_gaps).map((item) => `${item.ticker}: ${asArray(item.fields).join('/')}`);
  const anomalies = asArray(health.high_risk_anomalies);
  const rows = [
    ['财务覆盖', healthStatus(health.financial_coverage_pct, lowFinancial.length), `${Math.round(Number(health.financial_coverage_pct || 0) * 100)}% 平均覆盖；低覆盖 ${lowFinancial.length ? lowFinancial.join('，') : '无'}`],
    ['估值覆盖', healthStatus(health.valuation_coverage_pct, 0), `${health.valuation_verified || 0}/${health.valuation_total || 0} 核心估值字段 verified`],
    ['模型价格覆盖', healthStatus(health.model_price_coverage_pct, 0), `${health.model_priced || 0}/${health.model_total || 0} 主表模型有官方 input/output per 1M 价格`],
    ['行情缺口', marketGaps.length ? 'warning' : 'ok', marketGaps.length ? marketGaps.slice(0, 8).join('；') : '无缺口'],
    ['高风险数据异常', anomalies.length ? 'error' : 'ok', anomalies.length ? anomalies.slice(0, 6).join('；') : '未发现'],
  ].map(([metric, status, detail]) => [value(metric), healthBadge(status), value(detail)]);
  return `<article class="card full data-health-card">
    <h2>数据健康度</h2>
    ${table(['维度', '状态', '说明'], rows, true, { wide: true })}
  </article>`;
}

function healthStatus(pct = 0, warningCount = 0) {
  if (warningCount || Number(pct) < 0.5) return 'warning';
  return 'ok';
}

function healthBadge(status = 'ok') {
  const label = status === 'error' ? '异常' : status === 'warning' ? '关注' : '正常';
  return `<span class="health-badge health-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function renderCompanies(report) {
  if (!report.companies.length) return emptyCard('暂无标的', '请先运行 npm run import。');
  const buttons = report.companies.map((company, index) => `<button class="ticker-tab ${index === 0 ? 'active' : ''}" data-company="company-${index}">${highlightFirstEnglish(company.display_name || company.ticker)}</button>`).join('');
  const panels = report.companies.map((company, index) => renderCompanyPanel(company, index)).join('');
  return `<div class="company-tabs">${buttons}</div>${panels}`;
}

function renderCompanyPanel(company, index) {
  const market = company.market_data || {};
  return `<article id="company-${index}" class="company-panel ${index === 0 ? 'active' : ''}">
    <div class="card full">
      <div class="company-head">
        <div>
          <h2>${highlightFirstEnglish(company.display_name || company.ticker)}</h2>
          <div class="market-line">${escapeHtml(company.display_name || company.ticker)} &nbsp; Price ${marketField(company.ticker, 'price', market.price)} · MCap ${marketField(company.ticker, 'market_cap', market.marketCapDisplay)} · 1D ${marketField(company.ticker, 'return_1d', market.return1d, 'percent')} · 20D ${marketField(company.ticker, 'return_20d', market.return20d, 'percent')} · YTD ${marketField(company.ticker, 'return_ytd', market.returnYtd, 'percent')} · vs QQQ ${marketField(company.ticker, 'vs_qqq_1d', market.relativeToQQQ1d, 'percent')}</div>
        </div>
        <div class="tag-row">
          <span class="pill strong">${escapeHtml(company.status || 'holding')}</span>
          <span class="pill">${escapeHtml(company.group || '未分组')}</span>
        </div>
      </div>
      <div class="tag-row">${tags(company.tags)}</div>
      <div class="section-line">
        <strong>核心卡位</strong>
        <div>${value(company.core_positioning)}</div>
      </div>
      <div class="company-sections">
        <section class="company-section">
          <h3>业务拆分</h3>
          ${revenueTable(company)}
        </section>
        <section class="company-section">
          <h3>财务指标</h3>
          ${financialCoverageNote(company)}
          ${financialHistoryTable(company)}
        </section>
        <section class="company-section">
          <h3>指引</h3>
          ${guidanceTable(company)}
        </section>
        <section class="company-section">
          <h3>估值</h3>
          ${valuationTable(company)}
        </section>
        <section class="company-section">
          <h3>财务状况</h3>
          ${financialPositionTable(company)}
        </section>
        <section class="company-section">
          <h3>风险要素</h3>
          ${riskTable(company.risks)}
        </section>
        <section class="company-section">
          <h3>缺口字段</h3>
          ${missingFieldsCard(company)}
        </section>
      </div>
    </div>
  </article>`;
}

function renderEvents(report) {
  const background = report.event_summary.industry_background || [];
  const market = report.event_summary.market_factors || [];
  return `<div class="grid">
    <article class="card full">
      <h2>公司新闻</h2>
      ${eventTable(report.event_summary.company_news, report.companies)}
    </article>
    <article class="card full">
      <h2>公司公告</h2>
      ${eventTable(report.event_summary.company_announcements, report.companies)}
    </article>
    <article class="card full">
      <h2>行业背景</h2>
      ${background.length ? eventTable(background, report.companies) : '<span class="empty">最近7日暂无高置信行业背景事件</span>'}
    </article>
    <article class="card full">
      <h2>市场/板块因素</h2>
      ${market.length ? eventTable(market, report.companies) : '<span class="empty">最近7日暂无高置信市场/板块事件</span>'}
    </article>
  </div>`;
}

function eventTable(events = [], companies = []) {
  if (!events.length) return '<span class="empty">—</span>';
  const rows = events.map((event) => [
    value(event.date),
    value(event.display_ticker || event.ticker),
    value(companyLabelForEvent(event, companies)),
    value(event.type),
    value(`${event.emoji ? `${event.emoji} ` : ''}${event.event}`),
    directionCell(event.direction),
    value(event.importance),
    value(event.type === '公司公告' ? event.commentary : ''),
  ]);
  return table(['日期', 'Ticker', '公司', '类型', '事件', '方向', '重要性', '点评'], rows, true, { wide: true });
}

function renderCapex(report) {
  const summary = report.ai_capex_summary || { overseas: [], china: [], holdings: [] };
  return `<div class="grid">
    <article class="card full">
      <h2>海外CSP</h2>
      ${table(['公司', '最近4季度Capex', '最新季度Capex', '最新全年指引', '上次指引', '调整幅度', '管理层/机构评价', '传导说明'], summary.overseas.map(capexCspRow), true, { wide: true })}
    </article>
    <article class="card full">
      <h2>国内链</h2>
      ${table(['公司', '最近4季度Capex', '最新季度Capex', '最新全年指引', '上次指引', '调整幅度', '管理层/机构评价', '传导说明'], summary.china.map(capexCspRow), true, { wide: true })}
    </article>
    <article class="card full">
      <h2>持仓公司Capex</h2>
      ${table(['Ticker', '公司', '最近4季度Capex', '最新季度Capex', 'YoY/QoQ', '最新指引', '投资重点', '资金压力', '传导说明'], summary.holdings.map(capexHoldingRow), true, { wide: true })}
    </article>
    <article class="card full">
      <h2>AI投资计划，不等同于会计Capex</h2>
      ${aiInvestmentPlanTable(summary.ai_investment_plans || [])}
    </article>
  </div>`;
}

function aiInvestmentPlanTable(rows = []) {
  const items = asArray(rows).slice(0, 8).map((row) => [
    value(row.company),
    value(row.period),
    value(planTypeLabel(row.plan_type)),
    value(row.plan),
    value(row.note),
  ]);
  return items.length ? table(['公司', '期间', '计划类型', '投资计划', '说明'], items, true, { wide: true }) : '<span class="empty">暂无可展示的 AI 投资计划候选。</span>';
}

function capexCspRow(entry) {
  return [
    value(entry.company),
    value(entry.last4Capex),
    value(entry.latestQuarterCapex),
    value(entry.latestGuidance),
    value(entry.previousGuidance),
    value(entry.adjustment),
    value(entry.commentary),
    value(entry.transmissionNote),
  ];
}

function capexHoldingRow(entry) {
  return [
    value(entry.ticker),
    value(entry.company),
    value(entry.last4Capex),
    value(entry.latestQuarterCapex),
    value(entry.yoyQoq),
    value(entry.latestGuidance),
    value(entry.investmentFocus),
    value(entry.fundingPressure),
    value(entry.transmissionNote),
  ];
}

function companyLabelForEvent(event, companies = []) {
  const company = companies.find((item) => tickerKey(item.ticker) === tickerKey(event.ticker));
  return company?.short_cn || company?.chinese_name || event.company || event.ticker;
}

function renderModels(report) {
  const grouped = groupBy(report.renderable_models || [], (model) => model.provider_group || modelProviderGroup(model.provider));
  const providerCards = MODEL_MAIN_GROUPS.map((group) => {
    const items = (grouped[group] || []).slice(0, 5);
    if (!items.length) return '';
    const rows = items.map((entry) => [
      value(entry.provider_label || entry.provider || group),
      value(entry.model_name),
      value(modelReleaseDate(entry.release_date)),
      value(entry.key_capabilities_cn || modelCapability(entry.key_capabilities, entry)),
      value(entry.context_window_display || modelContextWindow(entry.context_window || entry.key_capabilities)),
      value(entry.modalities_display || modelModalities(entry.modalities || entry.multimodal)),
      value(entry.api_pricing_display || modelPricing(entry.api_pricing)),
      value(modelNextInfo(entry)),
    ]);
    return `<article class="card full">
      <h2>${escapeHtml(group)}</h2>
      ${table(['厂商', '模型', '发布日期', '关键能力', '上下文', '多模态', 'API定价', '下一代模型/后续信息'], rows, true, { wide: true })}
    </article>`;
  }).filter(Boolean).join('');
  const observation = renderModelObservation(grouped['其他'] || []);
  const fallback = '<article class="card full"><span class="empty">暂无高/中置信模型，候选数据待校验。</span></article>';
  return `<div class="grid">
    ${renderModelTimeline(report.model_release_timeline || [])}
    ${providerCards || fallback}
    ${observation}
    ${renderModelGapPrompt()}
  </div>`;
}

function renderModelObservation(items = []) {
  const rows = asArray(items).slice(0, 12).map((entry) => [
    value(entry.provider_label || entry.provider || '其他'),
    value(entry.model_name),
    value(modelReleaseDate(entry.release_date)),
    value(entry.key_capabilities_cn || modelCapability(entry.key_capabilities, entry)),
    value(entry.context_window_display || modelContextWindow(entry.context_window || entry.key_capabilities)),
    value(entry.modalities_display || modelModalities(entry.modalities || entry.multimodal)),
    value(entry.api_pricing_display || modelPricing(entry.api_pricing)),
  ]);
  if (!rows.length) return '';
  return `<article class="card full">
    <details class="model-observation">
      <summary>折叠观察区：其他模型 ${rows.length} 条</summary>
      ${table(['厂商', '模型', '发布日期', '关键能力', '上下文', '多模态', 'API定价'], rows, true, { wide: true })}
    </details>
  </article>`;
}

function renderModelTimeline(rows = []) {
  const timelineRows = rows.slice(0, 12).map((row) => [
    value(row.date || row.date_label),
    value(row.provider),
    value(row.model),
    value(row.type),
    value(row.summary),
    value(modelPricing(row.api_pricing)),
    value(row.data_status),
  ]);
  return `<article class="card full">
    <h2>最近一年关键模型发布时间线</h2>
    ${timelineRows.length ? table(['日期', '厂商', '模型', '类型', '核心变化', 'API定价', '数据状态'], timelineRows, true, { wide: true }) : '<span class="empty">暂无高/中置信模型，候选数据待校验。</span>'}
  </article>`;
}

function renderModelGapPrompt() {
  return `<article class="card full">
    <h2>模型数据缺口</h2>
    <div class="gap-card">缺口文档：docs/model_release_data_gap.md；官方价格页未解析时统一显示“待解析官方价格”，LLM 只能生成 candidate 或 parsing hint。</div>
  </article>`;
}

function renderLibrary(report) {
  const profileRows = (report.library.imports || []).map((item) => [
    value(item.source_file),
    value(typeLabel(item.source_type)),
    value(statusLabel(item.status)),
    value(item.imported_at),
    value(item.message),
  ]);
  const obsidianRows = obsidianRowsForReport(report);
  return `<div class="grid">
    ${renderWatchlist(report.watchlist || [])}
    <article class="card wide">
      <h2>资料覆盖</h2>
      ${listOrMissing(report.library.coverage_notes)}
    </article>
    <article class="card">
      <h2>缺口汇总</h2>
      ${table(['字段', '数量'], [
        ['行情缺失标的', report.data_quality.market_data_missing_fields?.length || 0],
        ['缺口提示', report.missing_info_prompt?.length || 0],
        ['导入错误', report.library.errors?.length || 0],
      ], true)}
    </article>
    <article class="card full">
      <h2>Profile / 上传资料</h2>
      <div class="library-table">${profileRows.length ? table(['文件', '类型', '状态', '导入时间', '备注'], profileRows, true) : '<span class="empty">—</span>'}</div>
    </article>
    <article class="card full">
      <h2>Obsidian Verified</h2>
      ${obsidianRows.length ? table(['Ticker', '日期', '类型', '标题', '内容概要', '核心观点', '关联模块'], obsidianRows, true, { wide: true }) : '<span class="empty">暂无 verified 命中</span>'}
    </article>
  </div>`;
}

function renderWatchlist(items = []) {
  const rows = asArray(items).map((item) => [
    value(item.ticker),
    value(item.company_name),
    value(item.exchange),
    value(watchlistStatusLabel(item.status)),
    value(item.priority),
    value(item.init_status),
    value(item.core_positioning || item.notes),
    value(item.updated_at || item.added_at),
    value(watchlistActionLabel(item)),
  ]);
  return `<article class="card full">
    <h2>关注列表</h2>
    ${rows.length ? table(['Ticker', '公司', '交易所', '状态', '优先级', '初始化状态', '观察理由', '最近更新', '资料入口'], rows, true, { wide: true }) : '<span class="empty">暂无关注标的</span>'}
  </article>`;
}

function watchlistStatusLabel(status = '') {
  if (status === 'holding') return '已纳入持仓';
  if (status === 'archived') return '已归档';
  return '观察中';
}

function watchlistActionLabel(item = {}) {
  if (item.profile_candidate_path) return `候选档案：${item.profile_candidate_path}`;
  if (item.ir_url || item.website) return `IR/官网：${item.ir_url || item.website}`;
  if (item.init_status === 'verified') return '查看缺口任务';
  return `复制初始化 Prompt：data/watchlist_tasks/${item.ticker}_research_prompt.md`;
}

function table(headers, rows, allowHtml = false, options = {}) {
  const wide = options.wide ?? headers.length >= 5;
  const tableClass = `data-table${wide ? ' wide-table' : ''}`;
  return `<div class="table-wrap"><table class="${tableClass}">
    <thead><tr>${headers.map((header) => `<th class="${headerClass(header)}">${escapeHtml(header)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${row.map((cell, index) => `<td class="${cellClass(headers[index])}" data-label="${escapeHtml(headers[index])}">${allowHtml ? cell : escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function headerClass(header) {
  return cellClass(header);
}

function cellClass(header = '') {
  const label = String(header);
  const classes = [];
  if (/(Price|MCap|1D|5D|20D|YTD|PE|PS|YoY|QoQ|数量|Capex|CAPEX|收入|利润|现金|债务|指引值|实际值|前次)/i.test(label)) classes.push('num');
  if (/(Ticker|日期|厂商|模型|方向|严重度|重要性|类型)/i.test(label)) classes.push('nowrap');
  if (/(说明|备注|影响|风险|事件|概要|观点|点评|驱动因素|业务拆分|管理层|投资重点|资金压力|缺口)/i.test(label)) classes.push('text-col');
  return classes.join(' ');
}

function value(input) {
  const output = displayValue(input);
  if (output === '—') return '<span class="empty">—</span>';
  return escapeHtml(output);
}

function displayValue(input) {
  if (input === null || input === undefined) return '—';
  const output = missingLabel(input, '—');
  if (output === '待补充') return '—';
  if (typeof output === 'string' && output.trim() === '-') return '—';
  return cleanVisibleText(output);
}

function visibleShortText(input, max = 120) {
  const clean = cleanVisibleText(input);
  if (!clean || clean.length <= max) return clean || null;
  const clipped = clean.slice(0, max);
  const boundary = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('；'), clipped.lastIndexOf(';'));
  return (boundary > Math.min(48, max / 2) ? clipped.slice(0, boundary + 1) : clipped).trim();
}

function percentCell(input) {
  const text = formatPercent(input);
  const number = Number(input);
  const cls = Number.isFinite(number) ? (number > 0 ? 'direction-positive' : number < 0 ? 'direction-negative' : 'direction-neutral') : 'empty';
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function marketField(ticker, field, input, type = 'value') {
  const text = type === 'percent' ? formatPercent(input) : displayValue(input);
  const number = Number(input);
  const cls = type === 'percent'
    ? (Number.isFinite(number) ? (number > 0 ? 'direction-positive' : number < 0 ? 'direction-negative' : 'direction-neutral') : 'empty')
    : (text === '—' ? 'empty' : '');
  return `<span class="${cls}" data-ticker="${escapeHtml(ticker || '')}" data-market-field="${escapeHtml(field)}">${escapeHtml(text)}</span>`;
}

function portfolioField(field, input, type = 'percent') {
  const text = type === 'points' ? formatPoints(input) : formatPercent(input);
  const number = Number(input);
  const cls = Number.isFinite(number) ? (number > 0 ? 'direction-positive' : number < 0 ? 'direction-negative' : 'direction-neutral') : 'empty';
  return `<span class="${cls}" data-portfolio-field="${escapeHtml(field)}">${escapeHtml(text)}</span>`;
}

function directionCell(direction) {
  const cls = direction === '利好' ? 'direction-positive' : direction === '利空' ? 'direction-negative' : 'direction-neutral';
  return `<span class="${cls}">${escapeHtml(direction || '待验证')}</span>`;
}

function tags(items) {
  const list = asArray(items).filter(Boolean);
  if (!list.length) return '<span class="empty">—</span>';
  return list.map((tag) => `<span class="badge">${escapeHtml(cleanVisibleText(tag))}</span>`).join('');
}

function revenueTable(company = {}) {
  const rows = asArray(company.revenue_breakdown).slice(0, 10).map((item) => [
    value(item.segment),
    value(revenueBreakdownDisplay(item, company)),
    value(item.yoy_display || item.yoy),
    value(item.note || item.business_split),
  ]);
  return rows.length ? table(['业务板块', '收入/占比', 'YoY', '业务拆分'], rows, true) : '<span class="empty">—</span>';
}

function revenueBreakdownDisplay(item = {}, company = {}) {
  const revenue = cleanVisibleText(item.display || item.revenue_value_display || item.revenue || '');
  const share = cleanVisibleText(item.share_display || item.share || '');
  const amount = businessAmountDisplay(revenue, company);
  const shareText = businessShareDisplay(share || (/^\s*~?\d+(?:\.\d+)?\s*(?:[-–—]\s*\d+(?:\.\d+)?)?\s*%/.test(revenue) ? revenue : ''));
  if (amount && shareText && amount !== shareText) return `${amount} / ${shareText}`;
  return amount || shareText || null;
}

function businessAmountDisplay(value = '', company = {}) {
  const clean = cleanVisibleText(value);
  if (!clean || clean === '—' || clean === '-') return null;
  if (/%/.test(clean)) return null;
  if (/(美元|欧元|人民币|新台币|韩元|亿|万亿|\$|€|¥|₩|B|M)/i.test(clean) && !/^[+-]?\d+(?:\.\d+)?$/.test(clean)) return clean;
  const number = Number(clean.replace(/,/g, '').replace(/^~/, ''));
  if (!Number.isFinite(number)) return null;
  const currency = companyCurrency(company);
  const unit = currency === 'EUR' ? '亿欧元' : currency === 'CNY' ? '亿元人民币' : currency === 'TWD' ? '亿新台币' : currency === 'KRW' ? '亿韩元' : '亿美元';
  return `${number.toFixed(number >= 10 ? 1 : 2).replace(/\.0$/, '')}${unit}`;
}

function businessShareDisplay(value = '') {
  const clean = cleanVisibleText(value);
  if (!clean || clean === '—' || clean === '-') return null;
  const normalized = clean
    .replace(/[–—-]/g, '至')
    .replace(/^~/, '约');
  if (/%/.test(normalized)) return /^约|^100%/.test(normalized) ? normalized : `约${normalized}`;
  return null;
}

function companyCurrency(company = {}) {
  const text = `${company.ticker || ''} ${company.display_ticker || ''} ${company.company_name || ''}`;
  if (/ASML|IFX|NOK/i.test(text)) return 'EUR';
  if (/BABA/i.test(text)) return 'CNY';
  if (/ASX|TSM/i.test(text)) return 'TWD';
  if (/Samsung|SKM|005930|SK Telecom/i.test(text)) return 'KRW';
  return 'USD';
}

function financialCoverageNote(company = {}) {
  const coverage = company.financial_coverage;
  if (!coverage) return '<p class="table-note financial-low-warning">财务覆盖：年度 0/3，季度 0/2，核心字段 0% verified；低覆盖 warning：财务覆盖不足，当前表格仅供初步参考</p>';
  const pct = Math.round((coverage.required_metrics_verified_pct || 0) * 100);
  const warning = pct < 50 ? '；低覆盖 warning：财务覆盖不足，当前表格仅供初步参考' : '';
  const klass = pct < 50 ? 'table-note financial-low-warning' : 'table-note';
  return `<p class="${klass}">财务覆盖：年度 ${escapeHtml(Math.min(coverage.annual_periods_verified || 0, 3))}/3，季度 ${escapeHtml(Math.min(coverage.quarter_periods_verified || 0, 2))}/2，核心字段 ${escapeHtml(pct)}% verified${warning}</p>`;
}

function financialHistoryTable(company = {}) {
  const rows = financialMetricRows(company);
  const html = table(['指标', 'FY2023', 'FY2024', 'FY2025', '最近季度-1', '最近季度', '最新同比'], rows, true, { wide: true });
  if (financialCoveragePct(company) < 50) {
    return `<details class="financial-details">
      <summary>展开低覆盖财务明细</summary>
      ${html}
    </details>`;
  }
  return html;
}

function financialCoveragePct(company = {}) {
  return Math.round(Number(company.financial_coverage?.required_metrics_verified_pct || 0) * 100);
}

function financialMetricRows(company = {}) {
  const periodColumns = financialPeriodColumns(company.financial_history_verified || []);
  const metrics = [
    ['收入', 'revenue'],
    ['毛利率', 'gross_margin'],
    ['营业利润', 'operating_income'],
    ['营业利润率', 'operating_margin'],
    ['净利润', 'net_income'],
    ['EPS diluted', 'diluted_eps'],
    ['OCF', 'operating_cash_flow'],
    ['Capex', 'capex'],
    ['FCF', 'free_cash_flow'],
    ['现金', 'cash'],
    ['债务', 'debt'],
    ['净现金/净债务', 'net_cash_or_debt'],
  ];
  return metrics.map(([label, key]) => [
    value(label),
    ...periodColumns.map((period) => value(financialDisplay(company, key, period))),
    value(financialLatestYoy(company, key)),
  ]);
}

function financialPeriodColumns(rows = []) {
  const quarters = [...new Set(rows
    .filter((row) => row.period_type === 'quarter')
    .map((row) => row.period_label)
    .filter(Boolean))]
    .sort()
    .slice(-2);
  return ['FY2023', 'FY2024', 'FY2025', quarters[0] || '最近季度-1', quarters[1] || '最近季度'];
}

function financialDisplay(company = {}, metric, periodLabel) {
  const row = (company.financial_history_verified || [])
    .find((item) => item.metric === metric && item.period_label === periodLabel && item.display && item.source_title && item.source_url);
  return row?.display || null;
}

function financialLatestYoy(company = {}, metric) {
  const rows = (company.financial_history_verified || [])
    .filter((row) => row.metric === `${metric}_yoy` && row.display && row.source_title && row.source_url)
    .sort((a, b) => String(b.period_label || '').localeCompare(String(a.period_label || '')));
  return rows[0]?.display || null;
}

function financialValueMismatch(key, value = '') {
  const text = cleanVisibleText(value);
  if (!text) return true;
  if ((key === 'net_income' || key === 'debt' || key === 'fcf' || key === 'revenue') && /%/.test(text)) return true;
  return false;
}

function guidanceTable(company) {
  const rows = asArray(company.guidance).map((item) => [
    value(dateDisplay(item.date) || item.date),
    value(item.period || '—'),
    value(item.metric),
    value(item.guidance_value || item.value),
    value(item.previous_guidance),
    value(item.actual_value),
    value(item.beat_miss),
    value(visibleShortText(item.comment, 100)),
  ]);
  return rows.length ? table(['日期', '期间', '指标', '指引值', '前次指引', '实际值', 'Beat/Miss', '说明'], rows, true, { wide: true }) : '<span class="empty">—</span>';
}

function normalizeGuidanceRow(item) {
  const metric = metricLabel(item.metric);
  const text = cleanVisibleText([item.rawValue, item.note].filter(Boolean).join('；'));
  return {
    ...item,
    metric,
    value: guidanceValueForMetric(metric, text),
    note: cleanVisibleText(item.note),
    actual: item.actual && !guidanceMetricMismatch(metric, item.actual) ? item.actual : null,
  };
}

function guidanceValueForMetric(metric, text = '') {
  if (metric === '毛利率' || metric === '营业利润率') return extractPercentRange(text) || null;
  if (metric === '收入' || metric === 'CAPEX' || metric === 'AI收入' || metric === '云收入' || metric === 'FCF' || metric === '其他资本开支') return extractMoneyRange(text) || extractNumberWithUnit(text);
  if (metric === 'EPS') return extractNumberWithUnit(text);
  if (metric === '产能' || metric === '出货量' || metric === '订单' || metric === '订单积压' || metric === '用户数') return extractCapacityValue(text) || extractMoneyRange(text) || extractNumberWithUnit(text);
  return null;
}

function guidanceMetricMismatch(metric, value = '') {
  const text = cleanVisibleText(value);
  if (!text) return true;
  if (/^(?:20)?\d{2}$|^20\d{2}$/.test(text)) return true;
  if (text.length > 60) return true;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return true;
  if ((metric === '毛利率' || metric === '营业利润率') && !/%/.test(text)) return true;
  if ((metric === '收入' || metric === 'AI收入' || metric === '云收入' || metric === 'FCF') && !/(亿|billion|million|trillion|美元|欧元|韩元|新台币|\$|EUR|USD|KRW|TWD|RMB|收入)/i.test(text)) return true;
  if ((metric === 'CAPEX' || metric === '其他资本开支') && !/(亿|billion|million|trillion|美元|欧元|韩元|新台币|\$|EUR|USD|KRW|TWD|RMB|%|占收入)/i.test(text)) return true;
  if ((metric === '产能' || metric === '出货量' || metric === '订单' || metric === '订单积压') && !/(台|片|套|座|GW|MW|万|亿|美元|欧元|韩元|新台币|\$|EUR|USD|KRW|TWD|RMB|订单|系统|unit|units|wafers?)/i.test(text)) return true;
  return false;
}

function guidanceRejectReason(row) {
  const metric = row.metric;
  const valueText = cleanVisibleText(row.value);
  const comment = cleanVisibleText(row.note || row.rawValue || '');
  if (!GUIDANCE_METRICS.has(metric)) return 'metric_not_allowed';
  if (metric === '其他') return 'metric_other_not_allowed';
  if (!valueText) return 'guidance_value_missing';
  if (/^(?:20)?\d{2}$|^20\d{2}$/.test(valueText)) return 'guidance_value_is_year';
  if (/^[+-]?\d+(?:\.\d+)?$/.test(valueText)) return 'guidance_value_is_bare_number';
  if (valueText.length > 60) return 'guidance_value_too_long';
  if (/[。；;]/.test(valueText)) return 'guidance_value_is_sentence';
  if (/若\s*20\d{2}|若2027|Low-NA.*若|High-NA.*若/i.test(valueText)) return 'guidance_value_truncated';
  if ((metric === 'CAPEX' || metric === '其他资本开支') && /融资计划|债务融资|未完成订单|backlog/i.test(comment)) return 'capex_value_is_not_capex_guidance';
  if ((metric === 'CAPEX' || metric === '其他资本开支') && /^-\s*[\d,]+(?:\.\d+)?\s*(?:亿)?美元/.test(valueText) && !/自由现金流|现金流|支出|outflow/i.test(comment)) return 'negative_capex_without_cashflow_context';
  if (guidanceMetricMismatch(metric, valueText)) return 'metric_value_mismatch';
  if (/management_guidance|long_term_outlook|Date approximate|released|prioritize|margin/i.test(`${row.rawValue} ${row.note}`)) return 'raw_untranslated_or_forbidden';
  if (looksLikeLongEnglish(comment)) return 'comment_not_translated';
  if (!normalizeGuidanceDate(row.date, row.period)) return 'date_missing';
  return null;
}

function guidanceSuggestedAction(metric) {
  if (metric === 'CAPEX' || metric === '其他资本开支') return '人工确认后补充为结构化 CAPEX 指引';
  if (metric === '收入' || metric === 'AI收入' || metric === '云收入') return '人工确认后补充为结构化收入指引';
  return '人工确认来源、日期和口径后再进入 verified guidance';
}

function normalizeGuidanceDate(date, period) {
  const raw = cleanVisibleText(date);
  const exact = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (exact) return exact[1];
  const mmddMatch = raw.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (mmddMatch) return `${mmddMatch[1].padStart(2, '0')}/${mmddMatch[2].padStart(2, '0')}`;
  const fromPeriod = normalizeGuidancePeriod(period);
  return fromPeriod && fromPeriod !== '—' ? '—' : null;
}

function normalizeGuidancePeriod(period = '') {
  const clean = cleanVisibleText(period);
  if (!clean) return '—';
  const fyq = clean.match(/\bFY(20\d{2})[-\s]?Q([1-4])\b/i);
  if (fyq) return `FY${fyq[1]}Q${fyq[2]}`;
  const q = clean.match(/\b(20\d{2})[-\s]?Q([1-4])\b/i);
  if (q) return `${q[1]}Q${q[2]}`;
  const fy = clean.match(/\bFY?\s*(20\d{2})\b/i);
  if (fy) return `FY${fy[1]}`;
  return clean.length > 18 ? '—' : clean;
}

function guidanceComment(item) {
  const text = cleanVisibleText(item.note || item.rawValue || '');
  if (/上调|raised|increase|higher/i.test(text)) return `${item.metric}指引上修，短期增长和估值支撑增强。`;
  if (/下调|lowered|decrease|cut/i.test(text)) return `${item.metric}指引下修，需跟踪需求和利润率压力。`;
  if (/AI|云|Cloud|数据中心/i.test(text)) return `${item.metric}与AI需求相关，后续看订单和毛利兑现。`;
  if (/actual|实际|cash flow|20-F/i.test(text)) return `已披露${item.metric}实际值，作为后续指引验证基准。`;
  return text && /[\u3400-\u9fff]/.test(text) ? visibleShortText(text, 90) : `${item.metric}口径已结构化，仍需补充原始披露来源。`;
}

function extractMoneyRange(text = '') {
  const range = String(text).match(/(?:EUR|USD|KRW|TWD|\$)?\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*[–—-]\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:billion|million|亿欧元|亿美元|亿韩元|亿新台币|亿美元|美元|欧元)?/i);
  if (range && /(?:billion|million|亿|美元|欧元|韩元|新台币|\$|EUR|USD|KRW|TWD)/i.test(range[0])) return compactWhitespace(range[0]);
  const money = String(text).match(/(?:EUR|USD|KRW|TWD|\$)?\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:billion|million|亿欧元|亿美元|亿韩元|亿新台币|亿美元|美元|欧元)/i);
  return money ? compactWhitespace(money[0]) : null;
}

function extractPercentRange(text = '') {
  const range = String(text).match(/[-+]?\d+(?:\.\d+)?\s*%\s*[–—-]\s*[-+]?\d+(?:\.\d+)?\s*%/);
  if (range) return compactWhitespace(range[0]);
  const compactRange = String(text).match(/[-+]?\d+(?:\.\d+)?\s*[–—-]\s*[-+]?\d+(?:\.\d+)?\s*%/);
  if (compactRange) return compactWhitespace(compactRange[0]).replace(/\s*%$/, '%');
  const pct = String(text).match(/[-+]?\d+(?:\.\d+)?\s*%/);
  return pct ? compactWhitespace(pct[0]) : null;
}

function extractNumberWithUnit(text = '') {
  const match = String(text).match(/(?:[$€¥₩]\s*)?[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:x|倍|%|美元|欧元|韩元|新台币|亿元|亿美元|亿欧元|亿韩元|亿新台币|亿|billion|million|B|M|台|片|套|座|GW|MW|万片|万台|wafers?|units?)?/i);
  if (!match) return null;
  const clean = compactWhitespace(match[0]);
  if (/^[+-]?\d+(?:\.\d+)?$/.test(clean)) return null;
  if (!/(x|倍|%|美元|欧元|韩元|新台币|元|亿|billion|million|B|M|台|片|套|座|GW|MW|万|wafers?|units?|\$|€|¥|₩)/i.test(clean)) return null;
  return clean;
}

function extractCapacityValue(text = '') {
  const match = String(text).match(/(?:至少|约|超过)?\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:台|片|套|万片|万台|GW|MW|wafers?|units?)(?:[^。；;]{0,20})/i);
  return match ? compactWhitespace(match[0]) : null;
}

function extractDateFromText(text = '') {
  const match = String(text || '').match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function inferPeriodFromText(text = '') {
  const quarter = String(text || '').match(/\b(20\d{2})?\s*Q([1-4])\b/i);
  if (quarter) return `${quarter[1] || ''}Q${quarter[2]}`.trim();
  const fy = String(text || '').match(/\bFY?\s*(20\d{2})\b/i);
  if (fy) return `FY${fy[1]}`;
  return null;
}

function valuationTable(company) {
  const market = company.market_data || {};
  const valuationFacts = asArray(company.financials?.valuation);
  const verified = new Map(asArray(company.valuation_verified).map((row) => [cleanVisibleText(row.field || row.metric), row]));
  const findValuation = (pattern) => valuationFacts.find((item) => pattern.test(`${item.metric} ${item.label}`))?.value;
  const verifiedValue = (field) => verified.get(field)?.value || null;
  const rows = [
    ['PE', market.peTrailing || findValuation(/\bpe\b|市盈/i), null, null, null, null],
    ['Forward PE', verifiedValue('Forward PE'), null, null, verifiedValue('FY2026E PE'), verifiedValue('FY2027E PE')],
    ['PS', cleanDash(market.psTrailing || findValuation(/\bps\b|市销/i)), null, null, null, null],
    ['EV/EBITDA', verifiedValue('EV/EBITDA'), null, null, verifiedValue('FY2026E EV/EBITDA'), verifiedValue('FY2027E EV/EBITDA')],
    ['FCF Yield', verifiedValue('FCF Yield'), null, null, verifiedValue('FY2026E FCF Yield'), verifiedValue('FY2027E FCF Yield')],
    ['EPS一致预期', null, null, null, verifiedValue('FY2026E EPS'), verifiedValue('FY2027E EPS')],
  ].map((row) => row.map((cell) => value(cell)));
  return `${table(['指标', '当前', '6个月前', '分位/变化', '今年底预期', '明年底预期'], rows, true)}
    ${valuationFootnote(company.valuation_verified)}
    ${valuationTaskDetails(company)}`;
}

function valuationFootnote(rows = []) {
  const verified = asArray(rows).filter((row) => row.source_title || row.source_url);
  if (!verified.length) return '';
  const dates = [...new Set(verified.map((row) => row.as_of).filter(Boolean))].sort();
  const dateTextValue = dates.length === 1 ? dates[0] : `${dates[0]}至${dates.at(-1)}`;
  return `<p class="table-note">估值数据日期：${escapeHtml(dateTextValue)}；资料：Alpha派、MarketBeat、Yahoo Finance 等；详见 verified JSON</p>`;
}

function sourceHost(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function valuationTaskDetails(company) {
  const task = company.valuation_task;
  if (!task) return '';
  const prompt = valuationPromptForTask(task, { htmlSafe: true });
  return `<details class="valuation-task">
    <summary>查看缺口任务</summary>
    <pre>${escapeHtml(prompt)}</pre>
  </details>`;
}

function buildValuationTasks(companies = [], reportDate = '') {
  return companies.map((company) => {
    const market = company.market_data || {};
    const missingFields = valuationTaskMissingFields(company);
    return {
      ticker: company.ticker,
      company: company.company_name || company.display_name || company.ticker,
      display_name: company.display_name || company.ticker,
      missing_fields: missingFields,
      context: {
        price: displayValue(market.price),
        market_cap: displayValue(market.marketCapDisplay || market.marketCap),
        revenue_latest: latestFinancialDisplay(company, 'revenue'),
        net_income_latest: latestFinancialDisplay(company, 'net_income'),
        fcf_latest: latestFinancialDisplay(company, 'free_cash_flow'),
      },
      questions: [
        `请补充或核验 ${company.display_name || company.ticker} 的 ${missingFields.join('、')}，并注明口径和来源日期。`,
        `如字段只有候选但未验证，请优先补出处标题、出处链接、数据日期、期间和可信度；如无可靠来源请返回缺失。`,
      ],
      required_output_schema: {
        ticker: 'string',
        field: 'string',
        value: 'string',
        period: 'string',
        source_title: 'string',
        source_url: 'string',
        as_of: 'YYYY-MM-DD',
        confidence: 'high|medium|low',
      },
      report_date: reportDate,
    };
  }).filter((task) => task.missing_fields.length);
}

function valuationTaskMissingFields(company = {}) {
  const verified = verifiedValuationFieldSet(company);
  return ['Forward PE', 'EV/EBITDA', 'FCF Yield', 'FY2026E EPS', 'FY2027E EPS']
    .filter((field) => !verified.has(field));
}

function latestFinancialDisplay(company = {}, metric) {
  const rows = (company.financial_history_verified || [])
    .filter((row) => row.metric === metric && row.period_type === 'annual' && row.display)
    .sort((a, b) => String(b.period_label || '').localeCompare(String(a.period_label || '')));
  return rows[0]?.display || '—';
}

function cleanDash(value) {
  if (typeof value === 'string' && value.trim() === '-') return null;
  return value;
}

function valuationPromptForTask(task, options = {}) {
  const schemaLine = options.htmlSafe
    ? '输出必须为 JSON 数组；每个对象包含标的、字段、数值、期间、出处标题、出处链接、数据日期、可信度。'
    : '输出必须为 JSON 数组；每个对象包含 ticker、field、value、period、source_title、source_url、as_of、confidence。';
  const sourceWord = options.htmlSafe ? '出处' : '来源';
  const confidenceLine = options.htmlSafe ? '没有可靠出处时不要编造，返回低可信度并说明缺失。' : '没有可靠来源时不要编造，返回 confidence=low 且说明缺失。';
  return [
    `任务：补充 ${task.display_name || task.ticker} 的估值缺口。`,
    `缺失字段：${task.missing_fields.join('、')}`,
    `上下文：价格 ${task.context.price}；市值 ${task.context.market_cap}；最近收入 ${task.context.revenue_latest}；最近净利润 ${task.context.net_income_latest}；最近 FCF ${task.context.fcf_latest}。`,
    ...task.questions.map((question) => question.replace(/来源/g, sourceWord)),
    schemaLine,
    confidenceLine,
  ].join('\n');
}

function renderValuationPrompt(report) {
  const lines = [
    '# 估值补充任务',
    '',
    `报告日期：${report.meta.report_date}`,
    '',
    '请只使用可核验来源。LLM 或人工补充结果先保存到 data/llm_candidates/valuation/*.json，再运行 npm run llm:validate。',
    '',
  ];
  for (const task of report.valuation_tasks || []) {
    lines.push(`## ${task.display_name || task.ticker}`, '', valuationPromptForTask(task), '');
  }
  return `${lines.join('\n')}\n`;
}

function financialPositionTable(company) {
  const history = company.financial_history_verified || [];
  const periods = [...new Set(history
    .filter((row) => row.period_type === 'annual')
    .map((row) => row.period_label)
    .filter(Boolean))]
    .sort()
    .slice(-3);
  const rows = (periods.length ? periods : ['FY2023', 'FY2024', 'FY2025']).map((period) => [
    value(period),
    value(financialDisplay(company, 'free_cash_flow', period)),
    value(financialDisplay(company, 'cash', period)),
    value(financialDisplay(company, 'debt', period)),
    value(financialDisplay(company, 'net_cash_or_debt', period)),
    value(financingPressureFromHistory(company, period)),
    value(investmentPressureFromHistory(company, period)),
  ]);
  return table(['期间', 'FCF', '现金', '债务', '净现金/净债务', '再融资压力', '投资压力'], rows, true, { wide: true });
}

function financingPressureFromHistory(company = {}, period) {
  const net = financialDisplay(company, 'net_cash_or_debt', period);
  if (/净现金/.test(net || '')) return '低：净现金口径';
  if (/净债务/.test(net || '')) return '中：需跟踪债务与现金流';
  return '待补 verified 现金/债务';
}

function investmentPressureFromHistory(company = {}, period) {
  const fcf = financialDisplay(company, 'free_cash_flow', period);
  const capex = financialDisplay(company, 'capex', period);
  if (fcf && capex) return '中：以 FCF 覆盖投资支出';
  if (capex) return '中：需补 OCF/FCF 口径';
  return '待补 verified Capex/FCF';
}

function normalizedCapitalStructure(company) {
  const raw = company.capital_structure || {};
  let cash = raw.cash_and_equivalents || raw.cash || null;
  const shortTermInvestments = raw.short_term_investments || null;
  let debt = raw.total_debt || raw.debt || null;
  let net = raw.net_cash_or_debt || raw.net_debt || null;
  if (financialValueMismatch('debt', debt)) debt = null;
  if (financialValueMismatch('debt', net) && !/净现金|净债务|net cash|net debt/i.test(String(net || ''))) net = null;
  if (sameDisplayedValue(cash, debt)) debt = null;
  if (sameDisplayedValue(cash, net)) net = /净现金|net cash/i.test(`${raw.net_debt} ${raw.net_cash_or_debt}`) ? `净现金（金额待核验）` : null;
  if (sameDisplayedValue(debt, net)) net = null;
  return {
    cash_and_equivalents: cash,
    short_term_investments: shortTermInvestments,
    total_debt: debt,
    net_cash_or_debt: net,
    fcf: raw.fcf || null,
    capex: raw.capex || null,
    refinancing_pressure: raw.refinancing_pressure || null,
    investment_pressure: raw.investment_pressure || null,
  };
}

function sameDisplayedValue(a, b) {
  const left = cleanVisibleText(a).replace(/[^\d.-]/g, '');
  const right = cleanVisibleText(b).replace(/[^\d.-]/g, '');
  return Boolean(left && right && left === right);
}

function riskTable(items = []) {
  const rows = asArray(items)
    .map(normalizeRiskItem)
    .filter((item) => !riskRejectReason(item))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .filter((item, index, arr) => arr.findIndex((other) => other.title === item.title) === index)
    .slice(0, 5)
    .map((item) => [value(item.severity), value(item.title), value(item.trigger), value(item.impact)]);
  return rows.length ? table(['严重度', '风险要素', '触发条件', '潜在影响'], rows, true, { wide: true }) : '<span class="empty">暂无新增高置信公司特异性风险；保留常规行业风险监控。</span>';
}

function normalizeCompanyRisks(company) {
  return asArray(company.risks)
    .map(normalizeRiskItem)
    .filter((item) => item.title && RISK_CATEGORIES.has(item.title))
    .filter((item) => !riskRejectReason(item))
    .filter((item, index, arr) => arr.findIndex((other) => other.title === item.title) === index)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 5);
}

function normalizeRiskItem(item) {
  const source = typeof item === 'string' ? item : `${item.title || ''} ${item.summary || ''} ${item.trigger || ''} ${item.impact || ''}`;
  const summary = cleanVisibleText(typeof item === 'string' ? item : item.summary || source);
  const severity = severityLabel(`${typeof item === 'string' ? '' : item.severity} ${source}`);
  const title = normalizedRiskTitle(source);
  const trigger = cleanVisibleText(item.trigger || riskTrigger(title, source, summary));
  const impact = cleanVisibleText(item.impact || riskImpactFromSummary(title, summary) || riskImpact(title));
  return {
    severity,
    title,
    risk_category: title,
    source_text: cleanVisibleText(source),
    source_title: typeof item === 'object' ? item.source_title || item.source || null : null,
    source_url: typeof item === 'object' ? item.source_url || item.original_url || null : null,
    confidence: normalizeEvidenceConfidence(typeof item === 'object' ? item.confidence : 'medium'),
    trigger: visibleShortText(trigger, 90),
    impact: visibleShortText(impact === trigger ? riskImpact(title, source) : impact, 100),
  };
}

function riskRejectReason(item = {}) {
  const text = cleanVisibleText(`${item.source_text || ''} ${item.trigger || ''} ${item.impact || ''}`);
  if (!text) return 'empty';
  if (/无新增|未发现|风险较低|暂无|相对较低|直接影响有限|不在最先进制程出口管制范围内/.test(text)) return 'non_risk_wording';
  if (/核心受益者|供应商整合机会|具有一定缓冲/.test(text)) return 'positive_or_low_risk';
  if (/风险\s+风险|^风险[:：]/.test(text)) return 'raw_risk_noise';
  if (/专利诉讼\s*专利诉讼|原本\s*20\d{2}年|\.{3,}/.test(text)) return 'raw_or_truncated';
  if (item.title === '其他，经人工确认') return 'unmatched_category';
  if (!riskCategoryMatches(item.title, text)) return 'category_mismatch';
  return null;
}

function riskCategoryMatches(title, text = '') {
  const clean = cleanVisibleText(text);
  const rules = {
    资本开支压力: /capex|资本开支|扩产|建厂|设备投资|现金流|融资压力/i,
    再融资压力: /债务|融资|再融资|流动性|现金/i,
    '监管/反垄断': /调查|罚款|禁令|诉讼|监管|处罚|法案|业务限制|环保|用地|审批/,
    需求周期下行: /订单|库存|价格|下游需求|需求|采购|客户|收入|政府支出/,
    出口管制升级: /出口|制裁|许可证|服务限制|禁令|FDPR|MATCH|EUV|DUV|中国销售|限制清单/,
    客户集中度: /客户|单一|大客户|自研|议价/,
    技术路线替代: /技术|3D|chiplet|SoIC|替代|复用/i,
    产能扩张不及预期: /产能|扩产|爬坡|工厂|建厂/,
    订单兑现不及预期: /订单|积压|延后|转收入|兑现/,
    地缘政治: /关税|贸易|地缘|供应链|稀土|韩国|台湾|中国|跨境/,
    竞争加剧: /竞争|竞品|美光|海力士|价格|份额/,
    毛利率下行: /毛利|价格压力|产品组合/,
    '模型/API价格战': /模型|API|价格战/i,
    '安全/数据泄露': /安全|数据泄露|隐私/,
  };
  return rules[title] ? rules[title].test(clean) : false;
}

function normalizedRiskTitle(text = '') {
  const clean = cleanVisibleText(text);
  if (/无新增|未发现|风险较低|暂无/.test(clean)) return '其他，经人工确认';
  if (/政府业务|联邦支出|government/i.test(clean)) return '需求周期下行';
  if (/反垄断|监管|罚款|调查|处罚/i.test(clean)) return '监管/反垄断';
  if (/出口|管制|禁令|MATCH|FDPR|中国销售|许可证|限制清单/i.test(clean)) return '出口管制升级';
  if (/地缘|关税|贸易摩擦|韩国|台湾|中国资产|CHIPS/i.test(clean)) return '地缘政治';
  if (/技术替代|3D|chiplet|SoIC|替代路线/i.test(clean)) return '技术路线替代';
  if (/客户集中|单一客户|大客户|客户自研/i.test(clean)) return '客户集中度';
  if (/复用|采购频次|订单兑现|积压|延后/i.test(clean)) return '订单兑现不及预期';
  if (/债务|融资|再融资|流动性/i.test(clean)) return '再融资压力';
  if (/现金流|资本开支|CAPEX/i.test(clean)) return '资本开支压力';
  if (/毛利|价格压力/i.test(clean)) return '毛利率下行';
  if (/竞争|美光|海力士|竞品/i.test(clean)) return '竞争加剧';
  if (/安全|数据泄露|隐私/i.test(clean)) return '安全/数据泄露';
  if (/模型|API|价格战/i.test(clean)) return '模型/API价格战';
  if (/需求|订单|库存|周期/i.test(clean)) return '需求周期下行';
  return '其他，经人工确认';
}

function riskTrigger(title, text = '', summary = '') {
  const specific = companySpecificRiskSentence(summary || text, title);
  if (specific) return specific;
  if (title === '出口管制升级') return '若美国、荷兰或中国进一步收紧出口、服务或反制规则。';
  if (title === '技术路线替代') return '若先进封装、3D堆叠或替代工艺降低对现有路线依赖。';
  if (title === '客户集中度') return '若单一大客户订单、议价或自研替代发生不利变化。';
  if (title === '订单兑现不及预期') return '若订单积压转收入节奏慢于市场预期。';
  if (title === '再融资压力') return '若债务到期、融资成本或流动性指标恶化。';
  if (title === '资本开支压力') return '若资本开支继续上行且自由现金流转弱。';
  if (title === '监管/反垄断') return '若出现明确罚款、调查、禁令或业务限制。';
  if (title === '地缘政治') return '若关税、贸易规则或跨境供应链限制升级。';
  if (title === '竞争加剧') return '若竞品价格、份额或客户导入进度快于预期。';
  if (title === '毛利率下行') return '若价格压力或产品组合恶化压低毛利率。';
  if (title === '安全/数据泄露') return '若安全事故导致合规、客户或赔偿压力。';
  if (title === '模型/API价格战') return '若模型或API价格快速下探压缩利润空间。';
  if (title === '需求周期下行') return '若下游订单、价格或库存指标连续走弱。';
  return cleanVisibleText(text).split(/[。；;]/)[0] || '若关键经营假设未能兑现。';
}

function companySpecificRiskSentence(text = '', title = '') {
  const clean = cleanVisibleText(text);
  if (!clean || /无新增|未发现|暂无|风险较低|相对较低/.test(clean)) return null;
  const sentences = clean.split(/[。；;]/).map((item) => item.trim()).filter(Boolean);
  const match = sentences.find((sentence) => riskCategoryMatches(title, sentence) && sentence.length >= 10);
  return match ? `${match.replace(/^[^：:]{2,24}[：:]/, '')}。` : null;
}

function riskImpactFromSummary(title, summary = '') {
  const clean = cleanVisibleText(summary);
  if (!clean) return null;
  if (/收入|订单|销售|需求|市场/.test(clean)) return '收入、订单能见度和估值倍数可能承压。';
  if (/毛利|价格|成本/.test(clean)) return '毛利率和盈利弹性可能承压。';
  if (/现金流|债务|融资|资本开支|扩产/.test(clean)) return '自由现金流、融资成本和投资回报验证压力上升。';
  if (/诉讼|罚款|监管|法案|禁令|管制|限制/.test(clean)) return '合规成本、业务限制和估值折价风险上升。';
  if (/供应链|台湾|韩国|中国|跨境|地缘|关税/.test(clean)) return '供应链韧性、跨境收入和估值稳定性面临压力。';
  return riskImpact(title);
}

function riskImpact(title) {
  if (title === '出口管制升级') return '中国收入、售后服务和估值倍数承压，订单能见度下降。';
  if (title === '技术路线替代') return '收入增速和毛利率被稀释，长期估值中枢下移。';
  if (title === '客户集中度') return '收入波动放大，议价能力和估值稳定性下降。';
  if (title === '订单兑现不及预期') return '收入确认延后，订单积压质量和估值支撑转弱。';
  if (title === '再融资压力') return '利息成本、融资稀释或债务展期风险上升。';
  if (title === '资本开支压力') return '自由现金流承压，投资回报验证周期拉长。';
  if (title === '监管/反垄断') return '罚款、整改或业务限制可能压低利润和估值。';
  if (title === '地缘政治') return '跨境收入、供应链和估值倍数波动加大。';
  if (title === '竞争加剧') return '价格、份额和毛利率承压，增长确定性下降。';
  if (title === '毛利率下行') return '利润弹性收缩，盈利预测面临下修压力。';
  if (title === '安全/数据泄露') return '客户信任、合规成本和赔偿风险上升。';
  if (title === '模型/API价格战') return '单位收入和毛利率承压，规模优势要求提高。';
  if (title === '需求周期下行') return '收入和利润率下修，估值对短期波动更敏感。';
  return '可能影响收入、利润率、现金流或估值判断。';
}

function missingFieldsCard(company) {
  const summary = company.gap_summary || naturalGapSummary(company);
  return `<div class="gap-card">${escapeHtml(cleanVisibleText(summary))}</div>`;
}

function naturalGapSummary(company) {
  const market = company.market_data || {};
  const issues = valuationGapIssues(company);
  if (market.psTrailing == null || market.psTrailing === '-') issues.push('PS TTM缺失');
  if (!(company.financial_history_verified || []).some((row) => row.period_type === 'quarter')) issues.push('最近两个季度财务明细缺失');
  if (!(company.guidance || []).length && !company.supplemental_facts?.some((fact) => /guidance|指引/i.test(fact.field))) issues.push('管理层最新指引缺失');
  if (!issues.length) return `${company.ticker}：暂无核心结构化缺口；后续随财报继续刷新估值和季度数据。`;
  return `${company.ticker}：${issues.join('、')}；目前无法完整判断年底估值分位和季度趋势。`;
}

function valuationGapIssues(company = {}) {
  const verified = verifiedValuationFieldSet(company);
  const candidates = candidateValuationFieldSet(company);
  return ['Forward PE', 'EV/EBITDA', 'FCF Yield']
    .filter((field) => !verified.has(field))
    .map((field) => `${field}${candidates.has(field) ? '有候选但未验证' : '缺失'}`);
}

function verifiedValuationFieldSet(company = {}) {
  return new Set(asArray(company.valuation_verified).map((row) => cleanVisibleText(row.field || row.metric)).filter(Boolean));
}

function candidateValuationFieldSet(company = {}) {
  return new Set(asArray(company.valuation_candidates)
    .filter(isActionableValuationCandidate)
    .map((row) => cleanVisibleText(row.field || row.metric))
    .filter(Boolean));
}

function isActionableValuationCandidate(row = {}) {
  const field = cleanVisibleText(row.field || row.metric);
  const valueText = cleanVisibleText(row.value || '');
  if (!field || !valueText) return false;
  if (/缺失|无数据|N\/A|not available/i.test(valueText)) return false;
  if (!row.source_title && !row.source_url) return false;
  return true;
}

function aggregateAiCapex(entries = [], companies = []) {
  const byTicker = groupBy(entries, (entry) => tickerKey(entry.ticker || entry.company));
  const csp = [
    ['Microsoft / Azure', 'MSFT.O'],
    ['Alphabet / Google Cloud', 'GOOGL.O'],
    ['Amazon / AWS', 'AMZN.O'],
    ['Meta', 'META.O'],
    ['Oracle', 'ORCL.N'],
  ].map(([name, ticker]) => capexEntitySummary(name, ticker, byTicker[tickerKey(ticker)] || [], 'csp'));
  const china = [
    ['阿里巴巴', 'BABA.N'],
    ['腾讯', '0700.HK'],
    ['百度', 'BIDU.US'],
    ['字节跳动', 'PRIVATE'],
  ].map(([name, ticker]) => capexEntitySummary(name, ticker, byTicker[tickerKey(ticker)] || [], 'china'));
  const holdings = companies.map((company) => {
    const ticker = company.ticker;
    const rows = [...(byTicker[tickerKey(ticker)] || []), ...asArray(company.supplemental_facts).map((fact) => ({
      ticker,
      company: company.chinese_name || company.company_name,
      field: fact.field,
      value: fact.value,
      period: fact.period,
      notes: fact.notes,
      category: 'holding_capex',
    }))];
    return capexHoldingSummary(company, rows);
  });
  return { overseas: csp, china, holdings, ai_investment_plans: capexInvestmentPlans(entries) };
}

function capexEntitySummary(company, ticker, rows, category) {
  const actuals = rows.filter(isCapexActualRow).sort(sortByPeriodDesc);
  const guidance = rows.filter(isCapexGuidanceRow).filter(isAccountingCapexGuidance).sort(sortByPeriodDesc);
  const latest = actuals[0];
  const latestGuidance = guidance[0];
  const previousGuidance = guidance[1];
  return {
    company,
    ticker,
    last4Capex: visibleShortText(dedupeBy(actuals.slice(0, 6).map((row) => `${periodShort(row.period)} ${shortCapexValue(row.value)}`).filter((item) => !item.endsWith(' —')), (item) => item).slice(0, 4).join('；'), 120) || '—',
    latestQuarterCapex: latest ? `${periodShort(latest.period)} ${shortCapexValue(latest.value)}` : '—',
    latestGuidance: latestGuidance ? shortCapexValue(latestGuidance.value) : '—',
    previousGuidance: previousGuidance ? shortCapexValue(previousGuidance.value) : '—',
    adjustment: adjustmentText(latestGuidance, previousGuidance),
    commentary: capexCommentary(rows, category),
    transmissionNote: capexTransmissionNote(company, rows, category),
  };
}

function capexHoldingSummary(company, rows) {
  const actuals = rows.filter(isCapexActualRow).sort(sortByPeriodDesc);
  const guidance = rows.filter(isCapexGuidanceRow).filter(isAccountingCapexGuidance).sort(sortByPeriodDesc);
  const latest = actuals[0];
  const guidanceLatest = guidance[0];
  const lightAsset = /AVGO|QCOM|BB/.test(company.display_ticker || company.ticker);
  return {
    ticker: company.ticker,
    company: company.short_cn || company.chinese_name || company.company_name || company.ticker,
    last4Capex: visibleShortText(dedupeBy(actuals.slice(0, 6).map((row) => `${periodShort(row.period)} ${shortCapexValue(row.value)}`).filter((item) => !item.endsWith(' —')), (item) => item).slice(0, 4).join('；'), 120) || '—',
    latestQuarterCapex: latest ? `${periodShort(latest.period)} ${shortCapexValue(latest.value)}` : '—',
    yoyQoq: yoyFromRows(actuals),
    latestGuidance: guidanceLatest ? shortCapexValue(guidanceLatest.value) : '—',
    investmentFocus: investmentFocus(company, rows, lightAsset),
    fundingPressure: fundingPressure(company, rows, lightAsset),
    transmissionNote: capexTransmissionNote(company.display_ticker || company.ticker, rows, 'holding', company),
  };
}

function capexInvestmentPlans(entries = []) {
  return asArray(entries)
    .filter((row) => !isCapexActualRow(row))
    .filter(isRenderableCapexInvestmentPlan)
    .map((row) => {
      const plan = shortCapexPlanText(row.value || row.capex_guidance || row.notes);
      const planType = classifyInvestmentPlan(row, plan);
      return {
        company: row.company || row.ticker || '未标注公司',
        period: periodShort(row.period || row.as_of || ''),
        plan_type: planType,
        plan,
        note: planType === 'capex_guidance_range' ? 'Capex 指引区间，需与会计实际值分开' : 'AI投资计划，不等同于会计Capex',
      };
    })
    .filter((row) => row.plan && row.plan !== '—' && !/^(?:to\s+)?20\d{2}$|^[-: ]+|revenue|guidance|EPS|\d+(?:\.\d+)?M$/i.test(row.plan))
    .filter((row, index, arr) => arr.findIndex((other) => `${other.company}|${other.period}|${other.plan_type}|${normalizePlanText(other.plan)}` === `${row.company}|${row.period}|${row.plan_type}|${normalizePlanText(row.plan)}`) === index)
    .slice(0, 8);
}

function classifyInvestmentPlan(row = {}, plan = '') {
  const text = cleanVisibleText(`${row.field || ''} ${row.value || ''} ${row.capex_guidance || ''} ${row.notes || ''} ${plan || ''}`);
  if (/cash investment|equity investment|战略投资|现金投资|入股|stake|minority investment/i.test(text)) return 'cash_investment';
  if (/guidance|outlook|range|指引|区间|上调|下调|CAPEX_GUIDANCE|capital expenditure guidance|资本开支指引/i.test(text) && /capex|capital expenditure|资本开支|\$|美元|亿/i.test(text)) return 'capex_guidance_range';
  if (/capacity|GW|MW|cluster|产能|算力|数据中心|fab|晶圆厂|工厂|facility|campus|园区/i.test(text)) return 'capacity_plan';
  if (/project budget|budget|项目预算|总投资|项目|construction|buildout|建设/i.test(text)) return 'project_budget';
  return 'ambiguous';
}

function planTypeLabel(type = '') {
  return ({
    cash_investment: 'cash investment',
    capex_guidance_range: 'capex guidance range',
    capacity_plan: 'capacity plan',
    project_budget: 'project budget',
    ambiguous: 'ambiguous',
  })[type] || 'ambiguous';
}

function normalizePlanText(value = '') {
  return cleanVisibleText(value).toLowerCase().replace(/\s+/g, ' ');
}

function isRenderableCapexInvestmentPlan(row = {}) {
  const text = cleanVisibleText(`${row.company || ''} ${row.field || ''} ${row.value || ''} ${row.notes || ''}`);
  if (!hasNumber(text)) return false;
  if (/NVIDIA Corporation|AMD|Marvell|Broadcom custom AI chip|H20 buyer|Ascend chips|GPU purchaser/i.test(text)) return false;
  if (/revenue guidance|revenue:|data center revenue|EPS|earnings|gross margin|operating margin|净利润|收入指引/i.test(text)) return false;
  return /investment|invest|CAPEX|Capex|capital expenditure|budget|spending|data center|infrastructure|facilit(?:y|ies)|GW|MW|投资|资本开支|基建|数据中心|算力/i.test(text);
}

function aggregateModels(models = []) {
  const normalized = models
    .map(normalizeModelEntry)
    .filter(Boolean)
    .filter(isRenderableVerifiedModel);
  const merged = new Map();
  for (const model of normalized) {
    const key = `${model.provider_group}|${model.provider}|${model.model_name}`;
    const existing = merged.get(key);
    merged.set(key, existing ? mergeModelEntries(existing, model) : model);
  }
  return [...merged.values()]
    .sort((a, b) => modelGroupRank(a.provider_group) - modelGroupRank(b.provider_group) || String(b.release_date).localeCompare(String(a.release_date)));
}

function normalizeModelTimeline(rows = []) {
  return asArray(rows)
    .filter((row) => row && ['high', 'medium'].includes(row.confidence))
    .filter((row) => row.date || row.date_label)
    .map((row) => ({
      date: row.date || null,
      date_label: modelTimelineDateLabel(row.date_label || null),
      provider: providerLabel(row.provider || ''),
      model: cleanVisibleText(row.model),
      release_type: cleanVisibleText(row.release_type || row.type || '推理模型'),
      type: cleanVisibleText(row.release_type || row.type || '推理模型'),
      summary: visibleShortText(row.summary, 90),
      api_pricing: row.api_pricing || null,
      confidence: row.confidence,
      date_confidence: row.date_confidence || 'estimated',
      data_status: cleanVisibleText(row.data_status || `${row.confidence === 'high' ? '高置信' : '中置信'} / ${row.date_confidence || '待确认'}`),
    }))
    .filter((row) => row.provider && row.model && row.summary)
    .sort((a, b) => modelTimelineSortKey(b).localeCompare(modelTimelineSortKey(a)))
    .slice(0, 12);
}

function modelTimelineSortKey(row = {}) {
  if (row.date) return row.date;
  const month = String(row.date_label || '').match(/\b(20\d{2}-\d{2})\b/);
  return month ? `${month[1]}-01` : '';
}

function modelTimelineDateLabel(value = '') {
  const clean = cleanVisibleText(value);
  if (!clean) return null;
  const month = clean.match(/\b(20\d{2}-\d{2})\b/);
  if (month && !/^\s*约/.test(clean)) return `约 ${month[1]}`;
  return clean.replace(/\s*前后\s*$/, '').replace(/^(20\d{2}-\d{2})$/, '约 $1');
}

function normalizeModelEntry(model = {}) {
  const provider = cleanVisibleText(model.provider);
  const modelName = cleanVisibleText(model.model || model.model_name);
  const group = modelProviderGroup(`${provider} ${modelName}`);
  const modalities = asArray(model.modalities).length ? asArray(model.modalities) : modalitiesFromText(model.multimodal || model.key_capabilities);
  const pricing = normalizeModelPricing(model.api_pricing);
  const context = modelContextWindow(model.context_window || model.key_capabilities);
  const pricingStatus = pricing.status || (pricing.display === '—' ? 'missing_official_pricing' : 'official_pricing_url_available');
  if (!provider || !modelName) return null;
  return {
    ...model,
    provider,
    provider_label: providerLabel(provider),
    provider_group: group,
    model_name: modelName,
    release_date: cleanVisibleText(model.release_date),
    source_title: model.source_title || model.source_type || null,
    source_url: model.source_url || model.original_url || model.source || null,
    confidence: model.confidence || model.confidence_level || null,
    key_capabilities: cleanVisibleText(model.key_capabilities),
    key_capabilities_cn: modelCapability(model.key_capabilities, { provider, model_name: modelName }),
    context_window: model.context_window || null,
    context_window_display: context,
    modalities,
    modalities_display: modelModalities(modalities),
    api_pricing: model.api_pricing || null,
    api_pricing_display: pricing.display,
    pricing_status: pricingStatus,
    next_model_info: cleanModelNextText(model.next_model_info || model.next_generation || ''),
  };
}

function isRenderableVerifiedModel(model = {}) {
  if (!MODEL_GROUPS.includes(model.provider_group)) return false;
  if (!model.provider || !model.model_name || !model.release_date) return false;
  if (!isModelDateRenderable(model.release_date)) return false;
  if (!model.source_url && !model.source_title) return false;
  if (!['high', 'medium'].includes(model.confidence)) return false;
  if (model.status === 'deprecated') return false;
  if (!modelFieldCompleteness(model)) return false;
  return model.provider_group === modelProviderGroup(`${model.provider} ${model.model_name}`);
}

function modelFieldCompleteness(model = {}) {
  const usefulFields = [
    model.release_date,
    model.key_capabilities_cn
    || model.key_capabilities,
    model.context_window_display !== '—',
    model.modalities_display !== '文本',
    model.api_pricing_display && model.api_pricing_display !== '—',
    model.status,
    modelNextInfo(model),
    model.source_url || model.source_title,
  ].filter(Boolean).length;
  return usefulFields >= 5;
}

function mergeModelEntries(left, right) {
  const score = (item) => [
    item.key_capabilities_cn,
    item.context_window_display !== '—',
    item.modalities_display !== '文本',
    item.api_pricing_display !== '—',
    modelNextInfo(item),
    item.source_url,
  ].filter(Boolean).length;
  const base = score(right) > score(left) ? { ...left, ...right } : { ...right, ...left };
  return {
    ...base,
    key_capabilities_cn: left.key_capabilities_cn || right.key_capabilities_cn,
    context_window_display: left.context_window_display !== '—' ? left.context_window_display : right.context_window_display,
    modalities_display: richerModalities(left.modalities_display, right.modalities_display),
    api_pricing_display: left.api_pricing_display !== '—' ? left.api_pricing_display : right.api_pricing_display,
    pricing_status: left.pricing_status !== 'missing_official_pricing' ? left.pricing_status : right.pricing_status,
  };
}

function obsidianRowsForReport(report) {
  return (report.obsidian_hits || [])
    .sort((a, b) => tickerKey(a.ticker).localeCompare(tickerKey(b.ticker)) || String(b.date || '').localeCompare(String(a.date || '')))
    .map((hit) => [
      value(hit.ticker),
      value(dateDisplay(hit.date)),
      value(hit.type),
      value(hit.title_clean),
      value(hit.summary),
      value(hit.core_view),
      value(hit.related_module),
    ]);
}

function buildVerifiedObsidianHits(hits = [], companies = []) {
  const companyMap = new Map(companies.map((company) => [tickerKey(company.ticker), company]));
  const rows = [];
  for (const hit of hits) {
    const company = companyMap.get(tickerKey(hit.ticker));
    if (!company) continue;
    const cleanTitle = cleanObsidianTitle(hit.title) || localTitleFromPath(hit.file);
    const summary = obsidianSummary(hit);
    const coreView = obsidianViewpoint(hit);
    const reason = obsidianRejectReason({ hit, company, cleanTitle, summary, coreView });
    if (reason) continue;
    rows.push({
      ticker: company.display_name || hit.display_name || hit.ticker,
      ticker_key: company.ticker,
      date: hit.date,
      type: obsidianType(hit),
      title_clean: visibleShortText(cleanTitle, 70),
      summary,
      core_view: coreView,
      related_module: obsidianRelatedModule(hit, cleanTitle, summary),
      local_path: hit.file,
    });
  }
  const grouped = groupBy(rows, (row) => tickerKey(row.ticker_key));
  return Object.values(grouped)
    .flatMap((group) => group
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || obsidianRank(b) - obsidianRank(a))
      .slice(0, 8))
    .sort((a, b) => tickerKey(a.ticker_key).localeCompare(tickerKey(b.ticker_key)) || String(b.date || '').localeCompare(String(a.date || '')));
}

function obsidianRejectReason({ hit, company, cleanTitle, summary, coreView }) {
  const raw = `${hit.title || ''} ${hit.summary || ''} ${hit.why_it_matters || ''} ${hit.file || ''}`;
  const visible = `${cleanTitle || ''} ${summary || ''} ${coreView || ''}`;
  if (!hit.date || hit.date < '2025-01-01') return 'old_date';
  if (/https?:\/\/|weixin\.qq\.com|com\/s\/|资料：wechat|原始链接|[a-f0-9]{10,}_/i.test(visible)) return 'visible_source_noise';
  if (/一句话结论|一句话总结|资料\s*[:：]|资料页|VIP原创|AI速览|原文|研报集合/i.test(visible)) return 'raw_research_summary';
  if (looksLikeLongEnglish(cleanTitle) || looksLikeLongEnglish(summary) || looksLikeLongEnglish(coreView)) return 'untranslated_english';
  if (!isUsefulObsidianText(summary) || !isUsefulObsidianText(coreView)) return 'low_information';
  if (tickerKey(company.ticker) === 'SAMSUNG' && /Samsung Biologics|Samsung Life|Samsung Insurance|三星生物|三星生命|三星保险|三星电机/i.test(raw)) return 'non_target_samsung_entity';
  if ((hit.matched_by || hit.matchedBy) === 'alias' && !obsidianMentionsCompany(raw, company)) return 'alias_mismatch';
  return null;
}

function obsidianMentionsCompany(raw, company) {
  const text = cleanVisibleText(raw);
  const tokens = [company.ticker, company.display_ticker, company.short_cn, company.chinese_name]
    .filter(Boolean)
    .map((item) => cleanVisibleText(item).replace(/\.(O|N|US|DF)$/i, ''));
  return tokens.some((token) => token && text.includes(token));
}

function obsidianType(hit) {
  const text = `${hit.event_type || ''} ${hit.tags || ''} ${hit.title || ''}`;
  if (/earnings|财报|电话会/i.test(text)) return '财报/电话会';
  if (/guidance|指引|目标价|上调|下调/i.test(text)) return '预期/指引';
  if (/supply|供应链|订单|产能/i.test(text)) return '供应链';
  return '研究摘要';
}

function obsidianRelatedModule(hit, title = '', summary = '') {
  const text = `${hit.event_type || ''} ${title} ${summary}`;
  if (/Capex|资本开支|数据中心|产能/i.test(text)) return 'AI Capex';
  if (/模型|API|Qwen|Claude|GPT|Gemini/i.test(text)) return '模型发布';
  if (/指引|收入|毛利|订单|目标价/i.test(text)) return '持仓追踪';
  return '资料库';
}

function obsidianRank(row) {
  if (/财报|电话会/.test(row.type)) return 3;
  if (/预期|指引/.test(row.type)) return 2;
  if (/供应链/.test(row.type)) return 1;
  return 0;
}

function cleanObsidianTitle(title = '') {
  const clean = cleanVisibleText(title)
    .replace(/^\d{4}-\d{2}-\d{2}[_\s-]*/g, '')
    .replace(/^(industry|company)[_\s-]+/i, '')
    .replace(/_+/g, ' ')
    .trim();
  if (!clean || looksLikeLongEnglish(clean) || /TMT外资观点|研报集合|纪要集合/i.test(clean)) return null;
  return clean;
}

function localTitleFromPath(file = '') {
  const base = String(file || '').split('/').pop() || '';
  const clean = cleanVisibleText(base)
    .replace(/\.md$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}[_\s-]*/g, '')
    .replace(/^[A-Z0-9.]+[_\s-]+/i, '')
    .replace(/_+/g, ' ')
    .trim();
  if (!clean || looksLikeLongEnglish(clean)) return '标题缺失';
  return clean;
}

function obsidianSummary(hit) {
  const clean = cleanVisibleText(hit.summary || '');
  if (!isUsefulObsidianText(clean)) return '摘要待补充';
  return visibleShortText(clean, 100);
}

function obsidianViewpoint(hit) {
  const clean = cleanVisibleText(hit.why_it_matters || hit.summary || '');
  if (!isUsefulObsidianText(clean)) return '观点待补充';
  if (/目标价|上调|下调|订单|收入|毛利|供给|需求|估值|现金流|CAPEX|资本开支|指引/.test(clean)) return visibleShortText(clean, 100);
  return '观点待补充';
}

function isUsefulObsidianText(text = '') {
  const clean = cleanVisibleText(text);
  if (clean.length < 24) return false;
  if (/URL|http|weixin|com\/s\/|原始链接|资料：wechat|来源平台|hash|<span/i.test(clean)) return false;
  if (!/[\u3400-\u9fff]/.test(clean)) return false;
  return true;
}

function buildMissingInfoPrompts({ companies, aiCapex, aiModels, eventSummary }) {
  const prompts = [];
  for (const company of companies) {
    if (company.gap_summary) prompts.push({ module: '个股缺口', ticker: company.ticker, field: 'summary', question: company.gap_summary });
    if (company.market_data?.dataQuality === 'missing') prompts.push({ module: '行情缺口', ticker: company.ticker, field: 'market_data', question: `${company.ticker} 缺少可用公开行情缓存。` });
  }
  for (const entry of aiCapex) {
    if (!entry.value && !entry.capex_guidance) prompts.push({ module: 'AI Capex 专项缺口', company: entry.company, field: entry.field, question: '缺具体资本开支数字。' });
  }
  for (const model of aiModels) {
    if (!model.api_pricing) prompts.push({ module: '模型发布缺口', provider: model.provider, model: model.model_name, field: 'api_pricing', question: '缺 API 定价。' });
  }
  if (!(eventSummary.events || []).length) prompts.push({ module: '事件缺口', field: 'recent_events', question: '最近 7 日没有匹配股票池的结构化事件。' });
  return prompts;
}

function buildDataHealth({ companies = [], renderableModels = [], market = {} }) {
  const financialCoverage = companies.map((company) => Number(company.financial_coverage?.required_metrics_verified_pct || 0));
  const financialAverage = financialCoverage.length ? financialCoverage.reduce((sum, pct) => sum + pct, 0) / financialCoverage.length : 0;
  const lowFinancial = companies.filter((company) => Number(company.financial_coverage?.required_metrics_verified_pct || 0) < 0.5);
  const valuationFields = ['Forward PE', 'EV/EBITDA', 'FCF Yield'];
  const valuationTotal = companies.length * valuationFields.length;
  const valuationVerified = companies.reduce((sum, company) => {
    const fields = new Set((company.valuation_verified || []).map((row) => row.field || row.metric));
    return sum + valuationFields.filter((field) => fields.has(field)).length;
  }, 0);
  const mainModels = renderableModels.filter((model) => MODEL_MAIN_GROUPS.includes(model.provider_group || modelProviderGroup(model.provider)));
  const pricedModels = mainModels.filter((model) => model.api_pricing?.input_per_1m !== null && model.api_pricing?.input_per_1m !== undefined && model.api_pricing?.output_per_1m !== null && model.api_pricing?.output_per_1m !== undefined);
  const marketGaps = companies.map((company) => ({
    ticker: company.ticker,
    fields: ['price', 'marketCap', 'return1d', 'return5d', 'return20d', 'returnYtd'].filter((field) => company.market_data?.[field] === null || company.market_data?.[field] === undefined),
  })).filter((item) => item.fields.length);
  const sanity = collectFinancialSanityIssues(
    companies.flatMap((company) => company.financial_history_verified || []),
    companies.map((company) => company.financial_coverage).filter(Boolean),
  );
  const valuationPct = valuationTotal ? valuationVerified / valuationTotal : 0;
  const modelPricePct = mainModels.length ? pricedModels.length / mainModels.length : 0;
  return {
    generated_at: new Date().toISOString(),
    financial_coverage_pct: Number(financialAverage.toFixed(2)),
    low_financial_coverage: lowFinancial.map((company) => ({
      ticker: company.ticker,
      pct: Number(company.financial_coverage?.required_metrics_verified_pct || 0),
    })),
    valuation_coverage_pct: Number(valuationPct.toFixed(2)),
    valuation_verified: valuationVerified,
    valuation_total: valuationTotal,
    model_price_coverage_pct: Number(modelPricePct.toFixed(2)),
    model_priced: pricedModels.length,
    model_total: mainModels.length,
    market_gaps: marketGaps,
    market_as_of: market.asOf || market.updatedAt || null,
    high_risk_anomalies: sanity.errors,
    warnings: sanity.warnings,
  };
}

function buildDataQuality({ data, companies, eventSummary, renderableModels, missingInfo, reportDate }) {
  return {
    report_date: reportDate,
    missing_required_fields_by_company: companies.map((company) => ({
      ticker: company.ticker,
      fields: [
        !company.core_positioning && 'core_positioning',
        !(company.revenue_breakdown || []).length && 'revenue_breakdown',
        !(company.financial_history_verified || []).some((row) => row.period_type === 'annual') && 'financial_history.annual',
        company.market_data?.dataQuality === 'missing' && 'market_data',
      ].filter(Boolean),
    })).filter((item) => item.fields.length),
    market_data_missing_fields: companies.map((company) => ({
      ticker: company.ticker,
      fields: ['price', 'marketCap', 'return1d', 'return5d', 'return20d', 'returnYtd'].filter((field) => company.market_data?.[field] === null || company.market_data?.[field] === undefined),
      dataQuality: company.market_data?.dataQuality,
    })).filter((item) => item.fields.length || item.dataQuality === 'missing'),
    event_window: eventSummary.meta || {},
    event_count: eventSummary.events.length,
    renderable_models: renderableModels.length,
    obsidian_status: data.obsidianHits?.meta?.status || 'not_configured',
    missing_info_prompt_count: missingInfo.length,
    missing_info_prompt_path: `data/data_quality/missing_info_prompt_${reportDate}.md`,
  };
}

function buildCoverageNotes(data, companies) {
  const notes = [];
  notes.push(`结构化标的 ${companies.length} 个；补充事实 ${data.supplementalFacts.length} 条。`);
  notes.push(`行情缓存日期 ${data.market?.asOf || '—'}；事件窗口 ${data.eventSummary?.meta?.window_start || '—'} 至 ${data.eventSummary?.meta?.window_end || '—'}。`);
  if (data.obsidianHits?.meta?.status === 'ok') notes.push(`Obsidian 命中 ${data.obsidianHits.meta.hit_count || 0} 条，页面只展示摘要和本地路径。`);
  return notes;
}

function listOrMissing(items) {
  const list = asArray(items).filter(Boolean);
  if (!list.length) return '<span class="empty">—</span>';
  return `<ul class="small-list">${list.slice(0, 10).map((item) => `<li>${escapeHtml(cleanVisibleText(item))}</li>`).join('')}</ul>`;
}

function typeLabel(type = '') {
  if (/initial/i.test(type)) return 'profile';
  if (/upload/i.test(type)) return '上传资料';
  return type || '—';
}

function statusLabel(status = '') {
  if (status === 'imported') return '已导入';
  if (status === 'skipped') return '跳过';
  if (status === 'failed') return '失败';
  return status || '—';
}

function metricLabel(metric = '') {
  if (/cloud|云/i.test(metric)) return '云收入';
  if (/AI_REVENUE|AI收入/i.test(metric)) return 'AI收入';
  if (/FCF|free cash flow|自由现金流/i.test(metric)) return 'FCF';
  if (/backlog|订单积压/i.test(metric)) return '订单积压';
  if (/order|订单/i.test(metric)) return '订单';
  if (/user|subscriber|用户/i.test(metric)) return '用户数';
  if (/revenue|REVENUE|收入/i.test(metric)) return '收入';
  if (/gross/i.test(metric)) return '毛利率';
  if (/operating/i.test(metric)) return '营业利润率';
  if (/EPS/i.test(metric)) return 'EPS';
  if (/other.*CAPEX|其他资本开支/i.test(metric)) return '其他资本开支';
  if (/CAPEX|capital_expenditure|资本开支/i.test(metric)) return 'CAPEX';
  if (/capacity|产能/i.test(metric)) return '产能';
  if (/shipment|出货/i.test(metric)) return '出货量';
  if (/AI/i.test(metric)) return 'AI收入';
  return null;
}

function refinancingPressure(capital, record) {
  if (capital.refinancing_pressure) return capital.refinancing_pressure;
  if (!capital.total_debt && !record.debt && !capital.net_cash_or_debt && !record.net_debt) return '低：未见明确债务压力';
  if (/净现金|-/.test(String(capital.net_cash_or_debt || record.net_debt))) return '低：净现金缓冲';
  return '中：需跟踪债务到期和利率';
}

function investmentPressure(company, record) {
  const capital = normalizedCapitalStructure(company);
  if (capital.investment_pressure) return capital.investment_pressure;
  if (/NBIS|ASX/i.test(`${company.ticker} ${company.display_ticker}`)) return '高：扩产和AI基础设施投入需匹配融资能力';
  if (/云厂商|FAB|半导体设备|通信设备/.test(company.group || '') || record.capex || capital.capex) return '中：需匹配AI/产能投资回报';
  return '低：偏研发和软件投入';
}

function severityLabel(value = '') {
  if (/无新增|未发现|风险较低|暂无/.test(value)) return '低';
  if (/高|high/i.test(value)) return '高';
  if (/低|low/i.test(value)) return '低';
  return '中';
}

function severityRank(value) {
  return value === '高' ? 0 : value === '中' ? 1 : 2;
}

function shortRiskTitle(value = '') {
  const clean = compactWhitespace(value);
  return cleanVisibleText(clean.split(/[：:。；;]/)[0]).slice(0, 18) || '风险';
}

function chineseTitleLimit(value = '', max = 18) {
  const clean = cleanVisibleText(value);
  return clean.length > max ? clean.slice(0, max) : clean;
}

function adjustmentText(latest, previous) {
  if (!latest) return '—';
  const text = `${latest.field || ''} ${latest.value || ''} ${latest.notes || ''}`;
  if (/revision|raised|increase|上调|增加/i.test(text)) return '上调';
  if (/lowered|decrease|下调|削减/i.test(text)) return '下调';
  return previous ? '更新' : '首次披露';
}

function capexCommentary(rows, category) {
  const eligibleRows = rows.filter((item) => isCapexActualRow(item) || isAccountingCapexGuidance(item));
  const row = eligibleRows.find((item) => hasNumber(item.value) || hasNumber(item.notes));
  if (!row) return '—';
  const value = shortCapexValue(row.value) || shortCapexValue(row.notes);
  if (value === '—') return '—';
  if (category === 'china') return visibleShortText(`披露口径含${value}，关注云与AI投入节奏。`, 70);
  return visibleShortText(`最新公开口径含${value}，重点跟踪AI算力需求兑现。`, 70);
}

function capexTransmissionNote(company, rows = [], category = '', record = {}) {
  const text = `${company} ${record.group || ''} ${rows.map((row) => `${row.field || ''} ${row.value || ''} ${row.notes || ''}`).join(' ')}`;
  if (category === 'china') return '云与AI投入传导至ASML、TSM、AVGO；封装需求传导至ASX。';
  if (/Microsoft|Alphabet|Google|Amazon|Meta|Oracle|云|AI/i.test(text)) return 'AI算力扩张传导至ASML、TSM、AVGO；网络扩容传导至CIEN。';
  if (/ASML|EUV|光刻|半导体设备/i.test(text)) return '先进制程扩产主要传导至EUV和High-NA设备需求。';
  if (/TSM|Samsung|GFS|005930|FAB|HBM|CoWoS|封装|晶圆/i.test(text)) return '先进制程、HBM与封装扩产影响设备和材料链。';
  if (/ASX|封装|OSAT/i.test(text)) return '先进封装和AI服务器需求影响OSAT稼动率。';
  if (/CIEN|NOK|网络|optical|光通信|通信设备/i.test(text)) return 'AI数据中心网络扩容传导至光通信和传输设备。';
  if (/AVGO|QCOM|BB|ASIC|软件/i.test(text)) return '轻资产投入以研发和客户需求传导为主。';
  return '关注资本开支兑现与下游AI需求匹配度。';
}

function relatedHoldingsForEntity(company, rows) {
  const text = `${company} ${rows.map((row) => `${row.value} ${row.notes}`).join(' ')}`;
  const out = [];
  if (/Microsoft|Google|Amazon|Meta|Oracle|阿里|腾讯|百度|字节|AI|云/i.test(text)) out.push('ASML', 'TSM', 'AVGO', 'Samsung', 'ASX', 'CIEN', 'NOK', 'NBIS', 'IFX');
  if (/网络|光|optical|Infinera/i.test(text)) out.push('CIEN', 'NOK', 'AVGO');
  return [...new Set(out)].slice(0, 9);
}

function yoyFromRows(rows) {
  const text = rows.map((row) => `${row.value || ''} ${row.notes || ''}`).join(' ');
  const match = text.match(/(?:同比|YoY|QoQ|环比)[^。；;]{0,24}/i);
  if (!match) return '—';
  const clean = cleanVisibleText(match[0]);
  if (looksLikeLongEnglish(clean)) return '—';
  return clean;
}

function investmentFocus(company, rows, lightAsset) {
  if (lightAsset) return '研发、软件平台、并购整合';
  const text = rows.map((row) => `${row.value || ''} ${row.notes || ''}`).join(' ');
  if (/EUV|光刻/i.test(text)) return 'EUV/High-NA设备和先进制程扩产';
  if (/HBM|CoWoS|封装/i.test(text)) return 'HBM、先进封装与AI加速器供应链';
  if (/产能|capacity/i.test(text)) return '产能扩张和先进工艺爬坡';
  if (/通信|optical|network|数据中心/i.test(text)) return 'AI数据中心网络与光通信扩容';
  return '产能、设备和AI相关基础设施';
}

function fundingPressure(company, rows, lightAsset) {
  if (lightAsset) return '低：资本开支低，重点看研发回报';
  if (rows.some((row) => /debt|融资|refinanc/i.test(`${row.value} ${row.notes}`))) return '中：需跟踪融资和现金消耗';
  return '中：重资产投入需匹配需求兑现';
}

function modelProviderGroup(provider = '') {
  const text = String(provider || '');
  if (/DeepSeek/i.test(text)) return 'DeepSeek';
  if (/Moonshot|Kimi/i.test(text)) return 'Kimi / Moonshot';
  if (/Alibaba|Qwen|通义/i.test(text)) return 'Qwen / Alibaba';
  if (/Google|Gemini|Gemma/i.test(text)) return 'Gemini / Google';
  if (/Anthropic|Claude/i.test(text)) return 'Anthropic';
  if (/OpenAI|GPT|o\d/i.test(text)) return 'OpenAI';
  if (/xAI|Grok/i.test(text)) return 'xAI';
  return '其他';
}

function isModelDateRenderable(date = '') {
  const text = String(date || '');
  if (/202[6-9]|203\d/.test(text)) return true;
  const exact = text.match(/\b(20\d{2})-\d{2}-\d{2}\b/);
  if (exact) return exact[1] >= '2025';
  return /\b2025\b/.test(text);
}

function modelGroupRank(group) {
  const index = MODEL_GROUPS.indexOf(group);
  return index === -1 ? MODEL_GROUPS.length : index;
}

function modelNextInfo(entry) {
  const text = cleanModelNextText(entry.next_model_info || entry.next_generation || '');
  if (!text) return null;
  if (/approximate|third.party|limited official|Date|待官方确认|Debuted|preview shown|shown July/i.test(text)) return null;
  const clean = cleanVisibleText(text);
  if (looksLikeLongEnglish(clean)) return null;
  if (/Preview|teacher model|closed-weights|Debuted|shown/i.test(clean)) return null;
  return visibleShortText(clean, 70);
}

function cleanModelNextText(value = '') {
  const text = compactWhitespace(value);
  if (!text || /Debuted|preview shown|shown July|后续信息待官方确认|待官方确认|third.party|Date approximate|released alongside|alongside/i.test(text)) return null;
  return cleanVisibleText(text);
}

function modelReleaseDate(value = '') {
  const clean = cleanVisibleText(value);
  const exact = clean.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (exact) return exact[1];
  const yearMonth = clean.match(/\b(20\d{2}-\d{2})\b/);
  if (yearMonth) return `约 ${yearMonth[1]}`;
  return clean || null;
}

function modelCapability(value = '', entry = {}) {
  const text = `${entry.provider || ''} ${entry.model_name || ''} ${value || ''}`;
  let out = '';
  if (/Qwen|Alibaba|通义/i.test(text)) out = '通义系列覆盖多尺寸、推理和代码能力，适合云端API与开源生态部署。';
  else if (/Claude|Anthropic/i.test(text)) out = 'Claude 系列强调长文本、代码和代理任务，企业场景推理稳定性较强。';
  else if (/Gemini|Gemma|Google/i.test(text)) out = 'Gemini/Gemma 系列覆盖长上下文和多模态，适合代码、视觉与高吞吐应用。';
  else if (/OpenAI|GPT|o\d/i.test(text)) out = 'OpenAI 模型强化推理、代码和工具调用，适合复杂知识工作与代理执行。';
  else if (/Grok|xAI/i.test(text)) out = 'Grok 系列强调实时信息、推理和工具使用，面向网页端与API场景。';
  else if (/Llama|Meta/i.test(text)) out = 'Llama 系列开源权重覆盖多尺寸，多模态和长上下文能力持续增强。';
  else if (/ERNIE|Baidu|文心/i.test(text)) out = 'ERNIE 系列强化中文、多模态和推理能力，主要服务云端与企业应用。';
  else if (/DeepSeek/i.test(text)) out = 'DeepSeek 系列突出推理和代码性价比，适合高吞吐API与本地部署。';
  else if (/Kimi|Moonshot/i.test(text)) out = 'Kimi 系列强调长上下文和中文任务，适合知识检索与代理应用。';
  else out = cleanVisibleText(value);
  const clean = cleanVisibleText(out);
  if (!clean || looksLikeLongEnglish(clean)) return null;
  return visibleShortText(clean, 80);
}

function modelContextWindow(value = '') {
  const clean = cleanVisibleText(value);
  const compact = clean.replace(/\s+/g, '');
  const tokenMatch = compact.match(/\b(\d+(?:\.\d+)?)(K|M)(?:token|tokens|context|上下文)?\b/i);
  if (!tokenMatch) return '—';
  const number = Number(tokenMatch[1]);
  const unit = tokenMatch[2].toUpperCase();
  if (!Number.isFinite(number)) return '—';
  if (unit === 'M' && number < 8 && !/token|context|上下文/i.test(compact)) return '—';
  return `${tokenMatch[1]}${unit} tokens`;
}

function modelModalities(value = []) {
  const list = modalitiesFromText(value);
  const labels = list.map((item) => ({
    text: '文本',
    image: '图像',
    audio: '音频',
    video: '视频',
  })[item] || null).filter(Boolean);
  return [...new Set(labels)].join('、') || '文本';
}

function richerModalities(left = '', right = '') {
  const leftCount = left.split('、').filter(Boolean).length;
  const rightCount = right.split('、').filter(Boolean).length;
  return rightCount > leftCount ? right : left;
}

function modalitiesFromText(value = []) {
  const text = Array.isArray(value) ? value.join(' ') : String(value || '');
  const out = [];
  if (/text|文本|language|语言/i.test(text) || !text) out.push('text');
  if (/image|vision|图像|视觉/i.test(text)) out.push('image');
  if (/audio|speech|语音|音频/i.test(text)) out.push('audio');
  if (/video|视频/i.test(text)) out.push('video');
  if (/multimodal|多模态/i.test(text) && out.length === 1) out.push('image');
  return [...new Set(out)];
}

function modelPricing(value = null) {
  return normalizeModelPricing(value).display;
}

function normalizeModelPricing(value = null) {
  if (!value) return { display: '—', status: 'missing_official_pricing' };
  if (typeof value === 'string') {
    const clean = cleanVisibleText(value);
    return clean && clean !== '—' ? { display: visibleShortText(clean, 70), status: 'official_pricing_text' } : { display: '—', status: 'missing_official_pricing' };
  }
  const input = value.input_per_1m;
  const cached = value.cached_input_per_1m;
  const output = value.output_per_1m;
  const currency = value.currency || 'USD';
  if (input !== null && input !== undefined && output !== null && output !== undefined) {
    const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `;
    const cacheText = cached !== null && cached !== undefined ? `；缓存 ${symbol}${cached} / 1M tokens` : '';
    return { display: `输入 ${symbol}${input} / 1M tokens${cacheText}；输出 ${symbol}${output} / 1M tokens；截至 ${value.as_of || '2026-06-06'}`, status: 'official_pricing_value' };
  }
  if (value.pricing_url) return { display: '待解析官方价格', status: 'official_page_found_unparsed' };
  return { display: '—', status: 'missing_official_pricing' };
}

function providerLabel(provider = '') {
  if (/Alibaba|通义|Qwen/i.test(provider)) return 'Alibaba/通义千问';
  if (/Google|Gemini|Gemma/i.test(provider)) return 'Google';
  if (/Moonshot|Kimi/i.test(provider)) return 'Moonshot/Kimi';
  return provider;
}

function hasNumber(value) {
  return /\d/.test(String(value || ''));
}

function isCapexActualRow(row) {
  const field = String(row.field || '');
  return /(AI_CAPEX_ACTUAL|quarterly_CAPEX|annual_CAPEX|capital_expenditure_actual)$/i.test(field) && hasNumber(row.value);
}

function isCapexGuidanceRow(row) {
  const field = String(row.field || '');
  return /(AI_CAPEX_GUIDANCE|AI_CAPEX_guidance|AI_CAPEX_GUIDANCE_REVISION|AI_CAPEX_revision|capital_expenditure_guidance|CAPEX Plans|HYPERSCALER_CAPEX_OUTLOOK)$/i.test(field) && hasNumber(row.value);
}

function isAccountingCapexGuidance(row = {}) {
  if (!isCapexGuidanceRow(row)) return false;
  const text = cleanVisibleText(`${row.field || ''} ${row.value || ''} ${row.notes || ''}`);
  if (/PRIVATE|private company|internal planning|media reports/i.test(`${row.ticker || ''} ${row.source_title || ''} ${text}`)) return false;
  if (/AI infrastructure budget|AI-related investment|GPU|H20|Ascend|chip procurement|chips in 20\d{2}|targeting AI-related revenue|total facilities and R&D|over next five years/i.test(text)) return false;
  if (/GW|MW|capacity|产能|data center|数据中心|campus|supercluster|electricity load/i.test(text)) return false;
  if (/\b15\s*[-–—至]\s*20\s*%|of revenue|收入占比/i.test(text) && !/capex intensity|资本开支强度/i.test(text)) return false;
  return /[$€¥₩]|USD|EUR|RMB|CNY|KRW|TWD|美元|欧元|人民币|韩元|新台币|亿|万亿|B|M|billion|million/i.test(text);
}

function shortCapexValue(value) {
  const clean = cleanVisibleText(value);
  if (!clean || /未获取到最新公开资本开支指引数据|markdown|来源|置信度/i.test(clean)) return '—';
  if (!hasNumber(clean)) return '—';
  const normalized = standardizeCapexText(clean);
  const latestCombined = latestCombinedQuarterCapexValue(clean) || latestCombinedQuarterCapexValue(normalized);
  if (latestCombined) return latestCombined;
  if (looksLikeLongEnglish(normalized)) return capexNumericSummary(normalized);
  return visibleShortText(normalized, 78);
}

function shortCapexPlanText(value) {
  const clean = standardizeCapexText(cleanVisibleText(value))
    .replace(/\b(\d+(?:\.\d+)?)\s*GW\+?/gi, '$1千兆瓦')
    .replace(/\b(\d+(?:\.\d+)?)\s*MW\+?/gi, '$1兆瓦')
    .replace(/\b15\s*[-–—]\s*20\s*%/g, '15至20%');
  if (!clean || !hasNumber(clean)) return '—';
  const capacity = clean.match(/\d+(?:\.\d+)?\s*(?:千兆瓦|兆瓦)/);
  if (capacity && looksLikeLongEnglish(clean)) return `${capacity[0].replace(/\s+/g, '')}级数据中心项目`;
  if (looksLikeLongEnglish(clean)) return capexNumericSummary(clean);
  return visibleShortText(clean, 90);
}

function latestCombinedQuarterCapexValue(value = '') {
  const text = compactWhitespace(value);
  const q4q1 = text.match(/人民币\s*[\d,.]+\s*亿元\s*\((?:Q4\s*2024|2024Q4)\)\s*[;；]\s*人民币\s*([\d,.]+)\s*亿元\s*\((?:Q1\s*2025|2025Q1)\)/i);
  if (q4q1) return `人民币 ${q4q1[1]} 亿元`;
  const rmbQ4q1 = text.match(/RMB\s*[\d,.]+\s*(?:billion|B)\s*\((?:Q4\s*2024|2024Q4)\)\s*[;；]\s*RMB\s*([\d,.]+)\s*(?:billion|B)\s*\((?:Q1\s*2025|2025Q1)\)/i);
  if (rmbQ4q1) return `人民币 ${formatYi(Number(rmbQ4q1[1].replace(/,/g, '')) * 10)} 亿元`;
  return null;
}

function capexNumericSummary(value = '') {
  const clean = standardizeCapexText(cleanVisibleText(value));
  const period = clean.match(/\b(?:FY20\d{2}|Q[1-4]\s*20\d{2}|20\d{2}-\d{2}-\d{2})\b/i)?.[0];
  const revenueRatio = clean.match(/(?:low-teens|approx|约)?\s*\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?\s*%\s*(?:of revenue|收入)/i)?.[0];
  const moneyMatches = [...clean.matchAll(/(?:(?:USD|EUR|RMB|KRW|TWD|Won|人民币|美元|欧元|韩元|新台币)\s*~?\d[\d,.]*(?:\s*[-/]\s*\d[\d,.]*)?\s*(?:B|M|T|billion|million|trillion|亿|万亿|百万|十亿|亿美元|亿元|欧元)?|[$€¥₩]\s*~?\d[\d,.]*(?:\s*[-/]\s*\d[\d,.]*)?\s*(?:B|M|T|billion|million|trillion)?|~?\d[\d,.]*(?:\s*[-/]\s*\d[\d,.]*)?\s*(?:B|M|T|billion|million|trillion|亿|万亿|百万|十亿|亿美元|亿元|亿欧元|亿韩元|亿新台币))/gi)]
    .map((match) => compactWhitespace(match[0]))
    .filter((item) => /\d/.test(item));
  const percent = clean.match(/\d+(?:\s*-\s*\d+)?%/)?.[0];
  const capacity = clean.match(/\d+(?:\.\d+)?\s*(?:GW|MW|万片|千片|wafers?)/i)?.[0];
  const amount = [moneyMatches[0], moneyMatches[1], revenueRatio || percent, capacity].filter(Boolean).slice(0, 2).join(' / ');
  if (!amount) return visibleShortText(clean.replace(/[A-Za-z]{4,}/g, ' ').replace(/\s+/g, ' ').trim(), 48) || '—';
  return compactWhitespace(`${period || ''} ${amount}`);
}

function standardizeCapexText(value = '') {
  return compactWhitespace(value)
    .replace(/RMB\s*380\s*billion\s*\/\s*3/gi, '人民币 3,800 亿元 / 未来 3 年')
    .replace(/2024-Q4 and 2025-Q Q4/gi, '2024Q4')
    .replace(/\bFY\s*(20\d{2})\b/gi, 'FY$1')
    .replace(/\bQ([1-4])\s*(20\d{2})\b/gi, '$2Q$1')
    .replace(/US\$\s*/gi, '$')
    .replace(/USD\s*(\d[\d,.]*)\s*billion/gi, '$1B')
    .replace(/\$(\d[\d,.]*)\s*billion/gi, '$1B')
    .replace(/\$(\d[\d,.]*)\s*million/gi, '$1M')
    .replace(/RMB\s*(\d[\d,.]*)\s*B\b/gi, (_, value) => `人民币 ${formatYi(Number(String(value).replace(/,/g, '')) * 10)} 亿元`)
    .replace(/RMB\s*(\d[\d,.]*)\s*-\s*(\d[\d,.]*)\s*B\b/gi, (_, low, high) => `人民币 ${formatYi(Number(String(low).replace(/,/g, '')) * 10)}-${formatYi(Number(String(high).replace(/,/g, '')) * 10)} 亿元`)
    .replace(/EUR\s*(\d[\d,.]*)\s*million/gi, '$1百万欧元')
    .replace(/EUR\s*(\d[\d,.]*)\s*billion/gi, '$1十亿欧元')
    .replace(/\b(\d[\d,.]*)\s*billion\b/gi, '$1B')
    .replace(/\b(\d[\d,.]*)\s*million\b/gi, '$1M')
    .replace(/RMB\s*(\d[\d,.]*)\s*-\s*(\d[\d,.]*)\s*B\b/gi, (_, low, high) => `人民币 ${formatYi(Number(String(low).replace(/,/g, '')) * 10)}-${formatYi(Number(String(high).replace(/,/g, '')) * 10)} 亿元`)
    .replace(/RMB\s*(\d[\d,.]*)\s*B\b/gi, (_, value) => `人民币 ${formatYi(Number(String(value).replace(/,/g, '')) * 10)} 亿元`)
    .replace(/\(calendar\s*~?\s*(\$\d[\d,.]*[BM]?)\s+in\s+(FY20\d{2})\)/gi, '（日历年$2约$1）')
    .replace(/\s+in\s+(FY20\d{2})/gi, ' $1')
    .replace(/\s+for\s+(FY20\d{2})/gi, ' $1')
    .replace(/\s*\(\$[\d,.]+[BM]?\)/gi, '')
    .replace(/\s*全年\s*(20\d{2})/g, '')
    .replace(/\b(FY20\d{2}Q[1-4])\s+e\b/gi, '$1')
    .replace(/\s+and\s+/gi, '/')
    .replace(/\s*\+\/-\s*/g, '±')
    .replace(/Capex口径|Capex计划/g, '')
    .replace(/需继续核对云与AI投入节奏|待核对/g, '')
    .replace(/\s+[;；]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatYi(value) {
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function sortByPeriodDesc(a, b) {
  return String(b.period || '').localeCompare(String(a.period || ''));
}

function periodShort(period = '') {
  const raw = compactWhitespace(period);
  const quarters = [...raw.matchAll(/(20\d{2})-?Q([1-4])/gi)].map((match) => `${match[1]}Q${match[2]}`);
  if (/and|\/|；|;/.test(raw) && quarters.length) return quarters.at(-1);
  const leadingQuarter = raw.match(/^(20\d{2})-?Q([1-4])/i);
  if (leadingQuarter) return `${leadingQuarter[1]}Q${leadingQuarter[2]}`;
  const clean = raw
    .replace(/2024-Q4 and 2025-Q Q4/gi, '2024Q4')
    .replace(/(\d{4})-Q([1-4])/gi, '$1Q$2')
    .replace(/(\d{4})-12-31/gi, '$1全年')
    .replace(/(\d{4})-06-30/gi, '$1H1');
  return clean.length > 18 ? clean.slice(0, 18) : clean;
}

function dateDisplay(value = '') {
  if (value === null || value === undefined) return null;
  const clean = compactWhitespace(value);
  const iso = clean.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[2]}/${iso[3]}`;
  return clean || null;
}

function timeDisplay(value = '') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function mmdd(dateIso = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return null;
  return `${dateIso.slice(5, 7)}/${dateIso.slice(8, 10)}`;
}

function cleanVisibleText(value = '') {
  if (value === null || value === undefined) return '';
  return standardizeVisibleMetrics(compactWhitespace(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bweixin\.qq\.com\/s\/\S*/gi, '')
    .replace(/\bcom\/s\/\S*/gi, '')
    .replace(/\b[a-f0-9]{10,}_/gi, '')
    .replace(/Date approximate/gi, '')
    .replace(/\breleased\s*[：:]?/gi, '发布')
    .replace(/\bundefined\b|\bnull\b/gi, '')
    .replace(/TMT\s*[-–]\s*/gi, '')
    .replace(/Broadcom/gi, '博通')
    .replace(/Ciena Corporation/gi, 'Ciena')
    .replace(/recurring revenue/gi, '经常性收入')
    .replace(/_connected\s*TV/gi, '联网电视')
    .replace(/置信度/g, '确信')
    .replace(/Calendar year/gi, '日历年')
    .replace(/full year/gi, '全年')
    .replace(/approximately/gi, '约')
    .replace(/expected to exceed/gi, '预计超过')
    .replace(/CapEx|CAPEX/g, 'Capex')
    .replace(/\b1\s*GW\+?/gi, '千兆瓦级')
    .replace(/\b15\s*[-–—]\s*20\s*%/g, '15至20%')
    .replace(/co-located data center and generation complex/gi, '共址数据中心和发电综合体')
    .replace(/co-located data center/gi, '共址数据中心')
    .replace(/generation complex/gi, '发电综合体')
    .replace(/data center/gi, '数据中心')
    .replace(/battery storage/gi, '储能')
    .replace(/on-site gas-fired generation/gi, '现场燃气发电')
    .replace(/\bsolar\b/gi, '光伏')
    .replace(/community fund announced/gi, '社区基金已公布')
    .replace(/European technical infrastructure investment/gi, '欧洲技术基础设施投资')
    .replace(/European tech/gi, '欧洲技术基础设施')
    .replace(/integrating\s+w\w*/gi, '整合供电资源')
    .replace(/Part of continued/gi, '持续推进')
    .replace(/原始链接|资料：wechat|来源平台：wechat|来源：wechat|wechat/gi, '')
    .replace(/quoteSummary 需要授权/g, '缺少可靠公开估值数据')
    .replace(/source_file|source_type|source_url|confidence/gi, '')
    .replace(/原始来源|来源平台|来源/g, '资料')
    .replace(/\.{3,}|…/g, '')
    .replace(/\s+[A-Z]$/g, '')
    .replace(/\s+([。；，、])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim());
}

function standardizeVisibleMetrics(value = '') {
  return compactWhitespace(value)
    .replace(/收入\s*\$1\.57(?![BM\d])/g, '收入15.7亿美元')
    .replace(/\$\s*(\d+(?:\.\d+)?)\s*billion\s*\+\/-\s*\$\s*(\d+(?:\.\d+)?)\s*million/gi, (_, billion, million) => `$${billion}B±$${million}M`)
    .replace(/\$\s*(\d+(?:\.\d+)?)\s*billion/gi, '$$$1B')
    .replace(/\$\s*(\d+(?:\.\d+)?)\s*million/gi, '$$$1M')
    .replace(/\b(\d+(?:\.\d+)?)\s*billion\s*\+\/-\s*(\d+(?:\.\d+)?)\s*million/gi, '$1B±$2M')
    .replace(/\b(\d+(?:\.\d+)?)\s*billion\b/gi, '$1B')
    .replace(/\b(\d+(?:\.\d+)?)\s*million\b/gi, '$1M')
    .replace(/\s*\+\/-\s*/g, '±')
    .replace(/;\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeLongEnglish(value = '') {
  const clean = compactWhitespace(value);
  if (!clean) return false;
  const hasChinese = /[\u3400-\u9fff]/.test(clean);
  if (!hasChinese && /[A-Za-z]/.test(clean)) return true;
  const englishWords = clean.match(/[A-Za-z]{4,}/g) || [];
  if (englishWords.length >= 5 && englishWords.join('').length >= 30) return true;
  return /[A-Za-z]{5,}(?:\s+[A-Za-z]{4,}){4,}/.test(clean);
}

function compactEventText(value = '') {
  return visibleShortText(cleanVisibleText(value), 56);
}

function compactDriverText(value = '') {
  return visibleShortText(standardizeVisibleMetrics(cleanVisibleText(value))
    .replace(/^[A-Za-z .,&-]+发布/, '发布')
    .replace(/Corporation|Inc\.?|Limited|Holding|Group/gi, '')
    .replace(/\s+/g, ' ')
    .trim(), 56);
}

function looksLikeResearchTitle(value = '') {
  return /TMT外资观点|研报|纪要|前瞻|深度|策略|^\d{2}\/\d{2}\s*[A-Za-z]+$|Date approximate|released|发布发布/i.test(value);
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '—') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number > 0 ? '+' : ''}${number.toFixed(2).replace(/\.00$/, '')}%`;
}

function formatPoints(value) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number > 0 ? '+' : ''}${number.toFixed(2).replace(/\.00$/, '')} pct`;
}

function diff(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return Number((a - b).toFixed(2));
}

function averageReturn(companies, field) {
  const values = companies
    .map((company) => company.market_data?.[field])
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function highlightFirstEnglish(text = '') {
  const clean = escapeHtml(cleanVisibleText(text));
  return clean.replace(/\b([A-Za-z][A-Za-z0-9.-]*)\b/, (word) => `<span class="letter-${word[0].toLowerCase()}">${word}</span>`);
}

function tickerSortKey(company) {
  return String(company.display_ticker || company.ticker || '').toUpperCase();
}

function tickerKey(value = '') {
  return String(value || '').toUpperCase().replace(/\.(O|N|US|DF)$/i, '').replace(/[^A-Z0-9]/g, '');
}

function groupBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    acc[key] = acc[key] || [];
    acc[key].push(item);
    return acc;
  }, {});
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

function emptyCard(title, text) {
  return `<article class="card full"><h2>${escapeHtml(title)}</h2><span class="empty">${escapeHtml(text)}</span></article>`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
