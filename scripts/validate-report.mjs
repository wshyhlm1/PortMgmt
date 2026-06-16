import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PATHS,
  containsMarkdownTable,
  escapeHtml,
  pathExists,
  readJson,
  todayInZone,
  writeJson,
} from './shared.mjs';
import { collectFinancialSanityIssues } from './financials/sanity.mjs';

async function main() {
  const config = await readJson(PATHS.config, {});
  const reportDate = process.argv[2] || todayInZone(config.report_timezone || process.env.REPORT_TZ || 'Asia/Shanghai');
  const htmlPath = path.join(PATHS.reports, reportDate, `${reportDate}.html`);
  const indexPath = path.join(PATHS.reports, 'index.html');
  const jsonPath = path.join(PATHS.reports, reportDate, `${reportDate}.json`);
  const marketPath = path.join(PATHS.marketCache, `${reportDate}.json`);
  const liveMarketPath = path.join(PATHS.reports, 'market_live.json');
  const liveDataPath = path.join(PATHS.data, 'market_live', 'latest.json');
  const missingPath = path.join(PATHS.dataQuality, `missing_info_prompt_${reportDate}.md`);
  const guidanceVerifiedPath = path.join(PATHS.data, 'guidance', 'guidance_verified.json');
  const guidanceRejectedPath = path.join(PATHS.data, 'guidance', 'guidance_rejected.json');
  const obsidianVerifiedPath = path.join(PATHS.data, 'obsidian_hits_verified.json');
  const valuationVerifiedPath = path.join(PATHS.data, 'valuation_verified.json');
  const valuationTaskPath = path.join(PATHS.data, 'valuation_tasks', `${reportDate}.json`);
  const html = await fs.readFile(htmlPath, 'utf8');
  const indexHtml = await fs.readFile(indexPath, 'utf8');
  const report = await readJson(jsonPath, {});
  const liveMarket = await readJson(liveMarketPath, null);
  const guidanceVerified = await readJson(guidanceVerifiedPath, { rows: [] });
  const guidanceRejected = await readJson(guidanceRejectedPath, { rows: [] });
  const obsidianVerified = await readJson(obsidianVerifiedPath, { rows: [] });
  const valuationVerified = await readJson(valuationVerifiedPath, { rows: [] });
  const valuationTasks = await readJson(valuationTaskPath, { tasks: [] });
  const errors = [];
  const warnings = [];

  runHtmlChecks({ label: 'dated report', html, report, liveMarket, liveMarketPath, liveDataPath, errors, warnings });
  runHtmlChecks({ label: 'index report', html: indexHtml, report, liveMarket, liveMarketPath, liveDataPath, errors, warnings });
  checkEventWindow(report, errors);
  checkEventQuality(report, errors);
  checkGuidanceQuality(report, guidanceVerified, guidanceRejected, errors);
  checkRiskQuality(report, errors);
  checkLibraryQuality(report, obsidianVerified, errors);
  checkValuationQuality(report, valuationVerified, errors);
  checkValuationTasks(report, valuationTasks, errors);
  checkWatchlistQuality(config.watchlist || [], errors);
  checkModelProviders(report, errors);
  checkRenderableModelsQuality(report, errors);
  checkFinancialSemantics(report, errors);
  await checkRequiredDocs(errors);
  checkMarketData(report, warnings);
  checkDisplayNames(report, errors);
  checkRawKeys(report, errors);

  const status = {
    report_date: reportDate,
    status: errors.length ? 'fail' : 'ok',
    errors,
    warnings,
    generated: {
      html: htmlPath,
      index: indexPath,
      json: jsonPath,
      market: marketPath,
      market_live: liveMarketPath,
      market_live_data: liveDataPath,
      missing_info_prompt: missingPath,
      guidance_verified: guidanceVerifiedPath,
      guidance_rejected: guidanceRejectedPath,
      obsidian_verified: obsidianVerifiedPath,
      valuation_verified: valuationVerifiedPath,
      valuation_tasks: valuationTaskPath,
    },
  };
  await writeJson(path.join(PATHS.dataQuality, `validation_${reportDate}.json`), status);
  console.log(`generated html path: ${htmlPath}`);
  console.log(`generated index path: ${indexPath}`);
  console.log(`generated json path: ${jsonPath}`);
  console.log(`market data path: ${marketPath}`);
  console.log(`missing info prompt path: ${missingPath}`);
  console.log(`validation status: ${status.status}`);
  if (warnings.length) {
    console.warn(`warnings: ${warnings.length}`);
    for (const warning of warnings.slice(0, 20)) console.warn(`- ${warning}`);
  }
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
}

function runHtmlChecks({ label, html, report, liveMarket, liveMarketPath, liveDataPath, errors, warnings }) {
  const localErrors = [];
  const localWarnings = [];
  checkRawMarkdownLeak(html, localErrors);
  checkLongTableCells(html, localErrors, localWarnings);
  checkHtmlContract(html, localErrors);
  checkDataHealthContract(html, report, localErrors);
  checkVisibleTextQuality(html, localErrors);
  checkRequiredCompanyPanels(html, report, localErrors);
  checkAiCapexContract(html, localErrors);
  checkModelContract(html, localErrors);
  checkFinancialHtmlContract(html, report, localErrors);
  checkBusinessBreakdownContract(html, localErrors);
  checkValuationHtmlContract(html, localErrors);
  checkMarketRefreshQuality({ html, report, liveMarket, liveMarketPath, liveDataPath }, localErrors, localWarnings);
  checkMissingText(html, localErrors, localWarnings);
  checkReportSize(html, localWarnings);
  errors.push(...localErrors.map((error) => `${label}: ${error}`));
  warnings.push(...localWarnings.map((warning) => `${label}: ${warning}`));
}

function checkHtmlContract(html, errors) {
  const text = stripTags(html);
  const requiredTabs = ['组合总览', '持仓追踪', '事件汇总', 'AI Capex', '模型发布', '资料库'];
  for (const tab of requiredTabs) {
    if (!text.includes(tab)) errors.push(`Missing required top-level tab: ${tab}`);
  }
  const topTabs = [...html.matchAll(/<button class="tab[^"]*" data-panel="[^"]+">([^<]+)<\/button>/g)].map((match) => stripTags(match[1]).trim());
  if (topTabs.length && topTabs.join('|') !== requiredTabs.join('|')) errors.push(`Top-level tabs mismatch: ${topTabs.join(', ')}`);
  const forbiddenVisible = [
    'Top Movers',
    '可能驱动因素',
    '相对 QQQ / SPY',
    '催化事件',
    '行动提醒',
    '数据质量',
    'null',
    'undefined',
    'Date approximate',
    'released',
    'released：',
    'management_guidance',
    'long_term_outlook',
    'compute_impact',
    'source_file',
    'source_type',
    'source_url',
    'confidence',
    'solar',
    'European tech',
    'billion +/-',
    'Capex口径',
    '需继续核对',
    '2024-Q4 and 2025-Q Q4',
    'RMB 380 billion / 3',
    '产能=6',
    '观点待补充',
    '原始链接',
    '资料：wechat',
    'weixin.qq.com',
    'com/s/',
    '置信度',
    'quoteSummary 需要授权',
    'Broadcom',
    'prioritize',
    'margin',
    'integrating w',
    'Part of continued',
    '...；...',
  ];
  for (const term of forbiddenVisible) {
    if (text.includes(term)) errors.push(`HTML visible text contains forbidden term: ${term}`);
  }
  if (/\|\s*-{3,}\s*\|/.test(text)) errors.push('HTML contains Markdown table residue: | --- |');
  if (!text.includes('刷新行情')) errors.push('Overview missing 刷新行情 button');
  if (!/data-market-refresh/.test(html)) errors.push('Refresh button missing data-market-refresh');
  if (!/function\s+refreshMarket\s*\(/.test(html)) errors.push('Refresh JS handler refreshMarket() missing');
  if (!/function\s+applyMarketData\s*\(/.test(html)) errors.push('Refresh JS handler applyMarketData() missing');
  if (!/function\s+fetchMarketPayload\s*\(/.test(html)) errors.push('Refresh JS handler fetchMarketPayload() missing');
  if (!/MARKET_LIVE_CONFIG/.test(html)) errors.push('Refresh config MARKET_LIVE_CONFIG missing');
  for (const field of ['price', 'market_cap', 'return_1d', 'return_5d', 'return_20d', 'return_ytd']) {
    if (!html.includes(`data-market-field="${field}"`)) errors.push(`Market field missing stable data attribute: ${field}`);
  }
  for (const field of ['return_1d_avg', 'return_5d_avg', 'qqq_return_1d', 'mag7_return_1d_avg', 'relative_qqq_1d', 'relative_mag7_1d']) {
    if (!html.includes(`data-portfolio-field="${field}"`)) errors.push(`Portfolio field missing stable data attribute: ${field}`);
  }
  if (/(?:[A-Z][a-z]+(?:\s+[A-Za-z][a-z]+){7,})/.test(text)) {
    errors.push('HTML appears to contain an untranslated long English sentence');
  }
  const firstOverview = text.indexOf('总览表');
  const relative = text.indexOf('相对表现');
  if (firstOverview === -1) errors.push('Overview does not contain 总览表');
  if (relative === -1) errors.push('Overview does not contain 相对表现');
  if (firstOverview !== -1 && relative !== -1 && firstOverview > relative) errors.push('组合总览 first block must be 总览表 before 相对表现');
}

function checkDataHealthContract(html, report, errors) {
  const overview = sectionHtml(html, 'overview');
  const text = stripTags(overview);
  if (!report.data_health) errors.push('Report JSON missing data_health');
  for (const label of ['数据健康度', '财务覆盖', '估值覆盖', '模型价格覆盖', '行情缺口', '高风险数据异常']) {
    if (!text.includes(label)) errors.push(`Data health card missing label: ${label}`);
  }
}

function checkVisibleTextQuality(html, errors) {
  const text = stripTags(html).replace(/\s+/g, ' ').trim();
  const hardForbidden = [
    'MarketBea...',
    'Alph...',
    'recurring revenue',
    '_connected',
    '一句话结论',
    '需继续验证基本面影响',
    '风险 风险',
    '专利诉讼 专利诉讼',
    '原本 2026年',
    'source_url',
    'confidence',
    'Date approximate',
    'undefined',
    'null',
    'Debuted Feb 2025',
  ];
  for (const term of hardForbidden) {
    if (text.includes(term)) errors.push(`HTML visible text contains hard-forbidden term: ${term}`);
  }
  if (text.includes('...')) errors.push('HTML visible text contains ASCII ellipsis ...');
  const notes = [...html.matchAll(/<p class="table-note">([\s\S]*?)<\/p>/gi)].map((match) => stripTags(match[1]).replace(/\s+/g, ' ').trim());
  for (const note of notes) {
    if (note.includes('...') || /[A-Za-z]{2,}\.\.\./.test(note)) errors.push(`Table note appears hard-truncated: ${note}`);
    const chineseLength = (note.match(/[\u3400-\u9fff]/g) || []).length;
    if (/资料：/.test(note) && chineseLength > 80) errors.push(`Valuation source footnote exceeds 80 Chinese chars: ${note}`);
  }
  const englishAllowance = /\b(?:EPS|FCF|EBITDA|Capex|API|GPT|Claude|Gemini|Grok|Qwen|DeepSeek|Kimi|Llama|tokens|MarketBeat|Yahoo Finance|NASDAQ|IR|AI|CATV|Telecom|FTTH|SEC|CIK|ISIN|CUSIP)\b/g;
  if (/[A-Za-z]{5,}(?:\s+[A-Za-z]{4,}){5,}/.test(text.replace(englishAllowance, ''))) {
    errors.push('HTML visible body contains an English sentence or long untranslated phrase');
  }
}

function checkEventWindow(report, errors) {
  const reportDate = report.meta?.report_date;
  if (!reportDate) return;
  const start = shiftDate(reportDate, -6);
  const events = report.event_summary?.events || report.events || [];
  for (const event of events) {
    if (!event.date_iso) errors.push(`Event missing date_iso: ${event.ticker || ''} ${event.event || event.title || ''}`);
    if (event.date_iso && (event.date_iso < start || event.date_iso > reportDate)) errors.push(`Event outside 7-day window: ${event.date_iso} ${event.ticker}`);
    if (!['公司新闻', '公司公告', '行业背景', '市场/板块因素'].includes(event.type)) errors.push(`Invalid event type: ${event.type}`);
    if (!['利好', '利空', '中性', '待验证'].includes(event.direction)) errors.push(`Invalid event direction: ${event.direction}`);
    if (!['高', '中', '低'].includes(event.importance)) errors.push(`Invalid event importance: ${event.importance}`);
    if (event.type === '公司公告' && event.commentary && event.commentary.length > 55) errors.push(`Announcement commentary too long: ${event.ticker} ${event.commentary}`);
    if (event.date_iso >= shiftDate(reportDate, -2) && !event.emoji) errors.push(`Recent event missing emoji: ${event.date_iso} ${event.ticker}`);
  }
}

function checkEventQuality(report, errors) {
  const events = report.event_summary?.events || report.events || [];
  const tickers = new Set((report.companies || []).map((company) => tickerKey(company.ticker)));
  const reportDate = report.meta?.report_date;
  for (const event of events) {
    const text = String(event.event || '');
    if (['公司新闻', '公司公告'].includes(event.type) && !tickers.has(tickerKey(event.ticker))) errors.push(`Event ticker not in stock pool: ${event.ticker}`);
    if (/https?:\/\/|weixin\.qq\.com|com\/s\/|\/Users\/|source_file|[a-f0-9]{10,}_/i.test(text)) errors.push(`Event contains source noise: ${event.ticker} ${text}`);
    if (/Date approximate|released|\.{3,}|Broadcom|Ciena Corporation|一句话结论|需继续验证基本面影响|这意味着\s*$/i.test(text)) errors.push(`Event contains forbidden raw wording: ${event.ticker} ${text}`);
    if (/行业规模预测|Yole预测.*CPO市场|市场将从20\d{2}/i.test(text) && ['公司新闻', '公司公告'].includes(event.type)) errors.push(`Industry forecast misattributed to company event: ${event.ticker} ${text}`);
    if (/^[A-Za-z0-9 .,&'()/-]{12,}$/.test(text)) errors.push(`Event is untranslated English/raw title: ${event.ticker} ${text}`);
    if (/[A-Za-z]{5,}(?:\s+[A-Za-z]{4,}){5,}/.test(text)) errors.push(`Event contains long English phrase: ${event.ticker} ${text}`);
    const chineseCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
    if (chineseCount < 8) errors.push(`Event summary too sparse in Chinese: ${event.ticker} ${text}`);
    if (event.type === '公司公告') {
      const commentary = String(event.commentary || '');
      const commentChinese = (commentary.match(/[\u3400-\u9fff]/g) || []).length;
      if (!commentary) errors.push(`Announcement missing commentary: ${event.ticker} ${text}`);
      if (commentChinese < 15 || commentChinese > 45) errors.push(`Announcement commentary length outside 15-45 Chinese chars: ${event.ticker} ${commentary}`);
    }
    if (reportDate && event.date_iso >= shiftDate(reportDate, -2) && !event.emoji) errors.push(`Recent event missing emoji: ${event.date_iso} ${event.ticker}`);
  }
  const commentTickers = new Map();
  for (const event of events.filter((item) => item.type === '公司公告' && item.commentary)) {
    const comment = String(event.commentary || '');
    commentTickers.set(comment, commentTickers.get(comment) || new Set());
    commentTickers.get(comment).add(tickerKey(event.ticker));
  }
  for (const [comment, tickers] of commentTickers) {
    if (tickers.size > 1) errors.push(`Announcement commentary duplicated across companies: ${comment}`);
  }
}

function checkGuidanceQuality(report, guidanceVerified, guidanceRejected, errors) {
  const allowedMetrics = new Set(['收入', '毛利率', '营业利润率', 'EPS', 'CAPEX', '产能', '出货量', 'AI收入', '云收入', 'FCF', '订单', '订单积压', '用户数', '其他资本开支']);
  const verifiedRows = guidanceVerified.rows || [];
  const reportRows = (report.companies || []).flatMap((company) => (company.guidance || []).map((row) => ({ ticker: company.ticker, ...row })));
  if (verifiedRows.length !== reportRows.length) errors.push(`guidance_verified row count mismatch: file ${verifiedRows.length}, report ${reportRows.length}`);
  if (!Array.isArray(guidanceRejected.rows)) errors.push('guidance_rejected file missing rows array');
  for (const company of report.companies || []) {
    const rows = company.guidance || [];
    const otherCount = rows.filter((row) => row.metric === '其他').length;
    if (rows.length && otherCount / rows.length > 0.2) errors.push(`Guidance metric=其他 ratio too high: ${company.ticker}`);
    for (const row of rows) {
      const metric = row.metric;
      const value = row.guidance_value || row.value || '';
      const comment = row.comment || row.summary || '';
      if (row.date === null || row.date === undefined || String(row.date).toLowerCase() === 'null') errors.push(`Guidance date is null: ${company.ticker}`);
      if (!row.period || /ended|Dec|period ended|\(.{8,}\)/i.test(String(row.period))) errors.push(`Guidance period not normalized: ${company.ticker} ${row.period}`);
      if (!allowedMetrics.has(metric)) errors.push(`Guidance metric not in enum: ${company.ticker} ${metric}`);
      if (/^(?:20)?\d{2}$|^20\d{2}$/.test(String(value).trim())) errors.push(`Guidance value is standalone year: ${company.ticker} ${metric} = ${value}`);
      if (/^[+-]?\d+(?:\.\d+)?$/.test(String(value).trim())) errors.push(`Guidance value is bare number: ${company.ticker} ${metric} = ${value}`);
      if (String(value).length > 60) errors.push(`Guidance value too long: ${company.ticker} ${metric} = ${value}`);
      if (/若\s*20\d{2}|若2027|Low-NA.*若|High-NA.*若/i.test(String(value))) errors.push(`Guidance value appears truncated: ${company.ticker} ${metric} = ${value}`);
      if ((metric === 'CAPEX' || metric === '其他资本开支') && /融资计划|债务融资|未完成订单|backlog/i.test(`${value} ${comment}`)) errors.push(`Guidance Capex row is funding/backlog text: ${company.ticker} ${value}`);
      if ((metric === 'CAPEX' || metric === '其他资本开支') && /^-\s*[\d,]+(?:\.\d+)?\s*(?:亿)?美元/.test(String(value)) && !/自由现金流|现金流|支出|outflow/i.test(comment)) errors.push(`Guidance negative capex lacks cashflow context: ${company.ticker} ${value}`);
      if (guidanceMetricMismatch(metric, value)) errors.push(`Guidance metric/value mismatch: ${company.ticker} ${metric} = ${value}`);
      if (!comment || /null|undefined/i.test(comment)) errors.push(`Guidance comment missing/null: ${company.ticker} ${metric}`);
      if (/[A-Za-z]{5,}(?:\s+[A-Za-z]{4,}){3,}|prioritize|margin|management_guidance|long_term_outlook|Date approximate|released/i.test(comment)) errors.push(`Guidance comment not translated: ${company.ticker} ${comment}`);
    }
  }
}

function checkRiskQuality(report, errors) {
  const allowed = new Set(['需求周期下行', '出口管制升级', '客户集中度', '技术路线替代', '产能扩张不及预期', '资本开支压力', '再融资压力', '监管/反垄断', '地缘政治', '竞争加剧', '毛利率下行', '订单兑现不及预期', '模型/API价格战', '安全/数据泄露', '其他，经人工确认']);
  for (const company of report.companies || []) {
    const risks = company.risks || [];
    if (risks.length > 5) errors.push(`Risk count exceeds 5: ${company.ticker}`);
    for (const risk of risks) {
      if (!allowed.has(risk.title)) errors.push(`Risk category not allowed: ${company.ticker} ${risk.title}`);
      if (risk.title.length > 18 && risk.title !== '其他，经人工确认') errors.push(`Risk title too long: ${company.ticker} ${risk.title}`);
      if (!risk.source_title && !risk.source_url) errors.push(`Risk missing source: ${company.ticker} ${risk.title}`);
      if (!risk.risk_category) errors.push(`Risk missing risk_category: ${company.ticker} ${risk.title}`);
      if (!['high', 'medium', 'low'].includes(risk.confidence)) errors.push(`Risk confidence invalid: ${company.ticker} ${risk.title}`);
      const text = `${risk.trigger || ''} ${risk.impact || ''}`;
      if (/若美国、荷兰或中国进一步收紧出口、服务或反制规则|若关税、贸易规则或跨境供应链限制升级|若出现明确罚款、调查、禁令或业务限制/.test(text)) {
        errors.push(`Risk still uses generic template wording: ${company.ticker} ${risk.title}`);
      }
      if (/无新增|未发现|风险较低|暂无|相对较低|直接影响有限/.test(text)) errors.push(`Non-risk wording displayed as risk: ${company.ticker} ${risk.title}`);
      if (/风险\s+风险|专利诉讼\s*专利诉讼|原本\s*20\d{2}年|\.{3,}/.test(text)) errors.push(`Risk contains raw/repeated/truncated wording: ${company.ticker} ${risk.title}`);
      if (risk.severity === '高' && /无新增|未发现|风险较低|暂无|相对较低/.test(text)) errors.push(`Low-risk wording marked high: ${company.ticker} ${risk.title}`);
      if (!riskCategoryMatches(risk.title, text)) errors.push(`Risk category/trigger mismatch: ${company.ticker} ${risk.title}`);
      if (similarText(risk.trigger, risk.impact) > 0.75) errors.push(`Risk trigger and impact too similar: ${company.ticker} ${risk.title}`);
    }
  }
}

function riskCategoryMatches(title, text = '') {
  const rules = {
    资本开支压力: /capex|扩产|建厂|设备投资|现金流|融资压力|资本开支/i,
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
  if (title === '其他，经人工确认') return false;
  return rules[title] ? rules[title].test(text) : true;
}

function checkLibraryQuality(report, obsidianVerified, errors) {
  const rows = obsidianVerified.rows || report.obsidian_hits || [];
  const byTicker = new Map();
  for (const row of rows) {
    const key = tickerKey(row.ticker_key || row.ticker);
    byTicker.set(key, (byTicker.get(key) || 0) + 1);
    if (!row.date || row.date < '2025-01-01') errors.push(`Library row has old/missing date: ${row.ticker} ${row.date}`);
    const visible = `${row.ticker || ''} ${row.title_clean || ''} ${row.summary || ''} ${row.core_view || ''} ${row.related_module || ''}`;
    if (/https?:\/\/|weixin\.qq\.com|com\/s\/|资料：wechat|原始链接|[a-f0-9]{10,}_/i.test(visible)) errors.push(`Library row contains source noise: ${row.ticker} ${row.title_clean}`);
    if (/[A-Za-z]{5,}(?:\s+[A-Za-z]{4,}){5,}/.test(visible)) errors.push(`Library row contains long English: ${row.ticker} ${row.title_clean}`);
    if (/Samsung Biologics|Samsung Life|Samsung Insurance|三星生物|三星生命|三星保险|三星电机/i.test(visible)) errors.push(`Library Samsung entity mismatch: ${row.title_clean}`);
    if ('local_path' in row && report.obsidian_hits?.some((hit) => hit.local_path)) {
      continue;
    }
  }
  for (const [ticker, count] of byTicker) {
    if (count > 10) errors.push(`Library ticker exceeds 10 rows: ${ticker} ${count}`);
  }
}

function checkValuationQuality(report, valuationVerified, errors) {
  const allowedFields = new Set(['Forward PE', 'EV/EBITDA', 'FCF Yield', 'FY2026E EPS', 'FY2027E EPS', 'FY2026E PE', 'FY2027E PE', 'FY2026E EV/EBITDA', 'FY2027E EV/EBITDA', 'FY2026E FCF Yield', 'FY2027E FCF Yield']);
  const rows = valuationVerified.rows || [];
  for (const row of rows) {
    if (!row.ticker || !row.field || !row.value) errors.push(`Valuation verified missing key field: ${JSON.stringify(row).slice(0, 120)}`);
    if (!allowedFields.has(row.field)) errors.push(`Valuation verified field not allowed: ${row.ticker} ${row.field}`);
    if (!row.period) errors.push(`Valuation verified missing period: ${row.ticker} ${row.field}`);
    if (!row.as_of || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.as_of))) errors.push(`Valuation verified missing as_of: ${row.ticker} ${row.field}`);
    if (!row.source_title && !row.source_url) errors.push(`Valuation verified missing source: ${row.ticker} ${row.field}`);
    if (!['high', 'medium'].includes(row.confidence)) errors.push(`Valuation verified confidence not renderable: ${row.ticker} ${row.field} ${row.confidence}`);
  }
  const rowKeys = new Set(rows.map((row) => `${tickerKey(row.ticker)}|${row.field}|${row.value}`));
  for (const company of report.companies || []) {
    for (const row of company.valuation_verified || []) {
      const key = `${tickerKey(row.ticker)}|${row.field}|${row.value}`;
      if (!rowKeys.has(key)) errors.push(`Report valuation row not backed by valuation_verified.json: ${company.ticker} ${row.field}`);
      if (!row.source_title && !row.source_url) errors.push(`Report valuation row missing source: ${company.ticker} ${row.field}`);
    }
  }
}

function checkValuationTasks(report, valuationTasks, errors) {
  const tasks = valuationTasks.tasks || [];
  const reportTasks = report.valuation_tasks || [];
  if (tasks.length !== reportTasks.length) errors.push(`Valuation task count mismatch: file ${tasks.length}, report ${reportTasks.length}`);
  const companies = new Map((report.companies || []).map((company) => [tickerKey(company.ticker), company]));
  for (const task of tasks) {
    if (!task.missing_fields?.length) errors.push(`Valuation task has no missing fields: ${task.ticker}`);
    const company = companies.get(tickerKey(task.ticker));
    const verified = new Set((company?.valuation_verified || []).map((row) => row.field || row.metric));
    for (const field of task.missing_fields || []) {
      if (verified.has(field)) errors.push(`Valuation task asks for already verified field: ${task.ticker} ${field}`);
    }
    if (!task.required_output_schema?.source_title || !task.required_output_schema?.as_of) errors.push(`Valuation task schema incomplete: ${task.ticker}`);
  }
}

function checkRequiredCompanyPanels(html, report, errors) {
  const text = stripTags(html);
  const required = ['业务拆分', '财务指标', '指引', '估值', '财务状况', '风险要素', '缺口字段'];
  for (const label of required) {
    if (!text.includes(label)) errors.push(`Company panels missing section: ${label}`);
  }
  for (const company of report.companies || []) {
    const name = company.display_name || company.ticker;
    if (!text.includes(name)) errors.push(`Company missing from HTML: ${company.ticker}`);
    for (const marker of ['Price', 'MCap', '1D', '20D', 'YTD', 'vs QQQ']) {
      if (!html.includes(marker)) errors.push(`Company market headline missing ${marker}`);
    }
  }
}

function checkMarketRefreshQuality({ html, report, liveMarket, liveMarketPath, liveDataPath }, errors, warnings) {
  if (!liveMarket) {
    errors.push(`market_live.json missing: ${liveMarketPath}`);
    return;
  }
  const liveTickers = new Set((liveMarket.quotes || []).map((quote) => tickerKey(quote.ticker)));
  const expected = [
    ...(report.companies || []).map((company) => company.ticker),
    'QQQ',
    'AAPL',
    'MSFT',
    'NVDA',
    'AMZN',
    'META',
    'GOOGL',
    'TSLA',
  ];
  for (const ticker of expected) {
    if (!liveTickers.has(tickerKey(ticker))) errors.push(`market_live quote missing ticker: ${ticker}`);
  }
  for (const field of ['return_1d_avg', 'return_5d_avg']) {
    if (liveMarket.portfolio?.[field] === null || liveMarket.portfolio?.[field] === undefined) errors.push(`market_live portfolio missing ${field}`);
  }
  for (const quote of liveMarket.quotes || []) {
    for (const field of ['price', 'return_1d', 'return_5d', 'return_20d', 'return_ytd', 'updated_at']) {
      if (quote[field] === null || quote[field] === undefined || quote[field] === '') errors.push(`market_live ${quote.ticker} missing ${field}`);
    }
    if (!quote.source) warnings.push(`market_live ${quote.ticker} missing source`);
  }
  if (!/data-panel/.test(html) || !/applyMarketData/.test(html)) errors.push('Refresh JS contract missing tab-preserving updater');
  if (!liveDataPath) warnings.push('market_live data path not reported');
}


function checkAiCapexContract(html, errors) {
  const text = stripTags(html);
  for (const label of ['海外CSP', '国内链', '持仓公司Capex']) {
    if (!text.includes(label)) errors.push(`AI Capex missing table: ${label}`);
  }
  for (const forbidden of ['相关公司', '相关持仓', '映射持仓', 'related holdings', 'related companies', 'ASML TSM AVGO Samsung ASX CIEN NOK NBIS IFX', 'RMB 380 billion / 3', 'Capex口径', '需继续核对', '需核对', '2024-Q4 and 2025-Q', '2024Q4 and 2025Q1', '2025 / 12-13']) {
    if (new RegExp(forbidden, 'i').test(text)) errors.push(`AI Capex contains removed related-company column: ${forbidden}`);
  }
  const capexSection = sectionHtml(html, 'capex');
  const cells = [...capexSection.matchAll(/<td\b[^>]*data-label="([^"]*)"[^>]*>([\s\S]*?)<\/td>/gi)];
  for (const match of cells) {
    const label = stripTags(match[1]).trim();
    const cell = stripTags(match[2]).replace(/\s+/g, ' ').trim();
    if (!cell || cell === '—') continue;
    if (cell.length > 120) errors.push(`AI Capex cell too long (${cell.length}) in ${label}: ${cell.slice(0, 80)}...`);
    if (/最近4季度Capex|最新季度Capex|最新全年指引|上次指引|最新指引|管理层\/机构评价/.test(label)) {
      if (/Capex口径|需继续核对|需核对|RMB 380 billion \/ 3|2024-Q4 and 2025-Q|2024Q4 and 2025Q1|AI infrastructure budget|AI-related investment|targeting AI-related revenue|total facilities and R&D|private company|internal planning|revised up|initially|Major NVIDIA|Won 5 trillion/i.test(cell)) errors.push(`AI Capex raw text leak in ${label}: ${cell}`);
      if (/\b1\s*GW\b|15\s*-\s*20%/.test(cell)) errors.push(`AI Capex guidance contains capacity/ratio instead of accounting capex: ${label}: ${cell}`);
      if (!/(FY20\d{2}|20\d{2}Q[1-4]|20\d{2}-\d{2}-\d{2}|日历年|全年|季度|B|M|亿|美元|欧元|人民币|韩元|新台币|\$|€|¥|₩|GW|MW|%)/i.test(cell)) {
        errors.push(`AI Capex amount lacks period/unit in ${label}: ${cell}`);
      }
    }
    if (label === '传导说明') {
      const chinese = (cell.match(/[\u3400-\u9fff]/g) || []).length;
      if (chinese > 60) errors.push(`AI Capex transmission note exceeds 60 Chinese chars: ${cell}`);
    }
    if (label === '投资计划' && (/^(?:to\s+)?20\d{2}$|^[-: ]+|revenue|guidance|EPS|\d+(?:\.\d+)?M$/i.test(cell))) {
      errors.push(`AI investment plan contains noisy non-investment text: ${cell}`);
    }
    if (label === '计划类型' && !/^(cash investment|capex guidance range|capacity plan|project budget|ambiguous)$/.test(cell)) {
      errors.push(`AI investment plan type invalid: ${cell}`);
    }
  }
}

function sectionHtml(html, panelId) {
  const start = html.search(new RegExp(`<section id="${panelId}"(?:\\s|>)`, 'i'));
  if (start === -1) return '';
  const rest = html.slice(start);
  const next = rest.slice(1).search(/\n\s*<section id="(?:overview|companies|events|capex|models|library)"(?:\s|>)/i);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function articleHtmlByHeading(html, heading) {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  if (start === -1) return '';
  const articleStart = html.lastIndexOf('<article', start);
  const end = html.indexOf('</article>', start);
  if (articleStart === -1 || end === -1) return '';
  return html.slice(articleStart, end + '</article>'.length);
}

function checkModelContract(html, errors) {
  const modelSection = sectionHtml(html, 'models');
  const text = stripTags(modelSection);
  for (const label of ['最近一年关键模型发布时间线', '核心变化', '数据状态', 'API定价', '下一代模型/后续信息']) {
    if (!text.includes(label)) errors.push(`Model table missing column: ${label}`);
  }
  if ((text.match(/最近一年关键模型发布时间线/g) || []).length < 1) errors.push('Model tab missing release timeline block');
  if (/<h2>其他<\/h2>/.test(modelSection)) errors.push('Model main table renders provider group 其他 outside folded observation area');
  if (/折叠观察区：其他模型/.test(modelSection) && !/<details class="model-observation">/.test(modelSection)) errors.push('Model observation area is not folded with details');
  const timeline = articleHtmlByHeading(modelSection, '最近一年关键模型发布时间线');
  const timelineRows = [...timeline.matchAll(/<tbody>([\s\S]*?)<\/tbody>/gi)]
    .flatMap((match) => [...match[1].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((row) => row[1]));
  if (timelineRows.length < 5) errors.push(`Model timeline rows too sparse: ${timelineRows.length}`);
  const allowedTypes = new Set(['旗舰模型', '推理模型', '速度模型', '多模态模型', '编码模型', '开源/开放权重模型', '价格调整', '生命周期变更']);
  const allowedStatuses = new Set(['verified', 'candidate', 'date_estimated', 'pricing_missing', 'source_unparsed']);
  for (const rowHtml of timelineRows) {
    const cells = Object.fromEntries([...rowHtml.matchAll(/data-label="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((match) => [stripTags(match[1]).trim(), stripTags(match[2]).replace(/\s+/g, ' ').trim()]));
    for (const field of ['日期', '厂商', '模型', '类型', '核心变化', 'API定价', '数据状态']) {
      if (!cells[field] || cells[field] === '—') errors.push(`Model timeline row missing ${field}: ${JSON.stringify(cells)}`);
    }
    if (cells['类型'] && !allowedTypes.has(cells['类型'])) errors.push(`Model timeline type invalid: ${cells['类型']}`);
    if (cells['数据状态'] && !allowedStatuses.has(cells['数据状态'])) errors.push(`Model timeline data_status invalid: ${cells['数据状态']}`);
    if (/见官方定价页|^\s*$/.test(cells['API定价'] || '')) errors.push(`Model timeline pricing invalid: ${cells['API定价']}`);
  }
  if (text.includes('见官方定价页')) errors.push('Model API pricing contains forbidden phrase: 见官方定价页');
  for (const forbidden of ['Debuted Feb', '2025-2026', '2026年持续', '预计2026年6月', '2026-01 前后', '后续信息待官方确认', 'released alongside', 'alongside']) {
    if (text.includes(forbidden)) errors.push(`Model table contains forbidden raw text: ${forbidden}`);
  }
  for (const forbidden of ['算力链影响', '影响标的', 'Status']) {
    if (text.includes(forbidden)) errors.push(`Model table still contains old column: ${forbidden}`);
  }
}

function checkBusinessBreakdownContract(html, errors) {
  const companies = sectionHtml(html, 'companies');
  const cells = [...companies.matchAll(/<td\b[^>]*data-label="收入\/占比"[^>]*>([\s\S]*?)<\/td>/gi)];
  for (const match of cells) {
    const cell = stripTags(match[1]).replace(/\s+/g, ' ').trim();
    if (!cell || cell === '—') continue;
    if (cell === '-' || /^[+-]?\d+(?:\.\d+)?$/.test(cell)) errors.push(`Business breakdown revenue/share is bare value: ${cell}`);
    if (/\d/.test(cell) && !/(%|美元|欧元|人民币|新台币|韩元|亿|万亿|\$|€|¥|₩)/.test(cell)) {
      errors.push(`Business breakdown revenue/share lacks unit: ${cell}`);
    }
  }
}

function checkValuationHtmlContract(html, errors) {
  const companies = sectionHtml(html, 'companies');
  if (/<td\b[^>]*>\s*-\s*<\/td>/i.test(companies)) errors.push('Company tables contain standalone hyphen cell');
  const taskBlocks = [...companies.matchAll(/<details class="valuation-task">([\s\S]*?)<\/details>/gi)];
  for (const block of taskBlocks) {
    const text = stripTags(block[1]).replace(/\s+/g, ' ');
    if (/最近(?:收入|净利润|FCF)\s+[+-]?\d+(?:\.\d+)?(?:[；。]|$)/.test(text)) errors.push(`Valuation task context contains bare financial value: ${text.slice(0, 120)}`);
  }
}

function checkFinancialHtmlContract(html, report, errors) {
  const companies = sectionHtml(html, 'companies');
  if (!companies) return;
  const hasLowCoverage = (report.companies || []).some((company) => Number(company.financial_coverage?.required_metrics_verified_pct || 0) < 0.5);
  if (hasLowCoverage && !/financial-low-warning/.test(companies)) errors.push('Low financial coverage warning missing in company section');
  if (hasLowCoverage && !/<details class="financial-details">/.test(companies)) errors.push('Low financial coverage details table is not folded by default');
  const cells = [...companies.matchAll(/<td\b[^>]*data-label="([^"]*)"[^>]*>([\s\S]*?)<\/td>/gi)];
  for (const match of cells) {
    const label = stripTags(match[1]).trim();
    const cell = stripTags(match[2]).replace(/\s+/g, ' ').trim();
    if (!cell || cell === '—') continue;
    if (cell === '-') errors.push(`Financial/company table uses hyphen in ${label}`);
    if (/^(FY20\d{2}|最近季度|最近季度-1|指标|期间)$/.test(label)) continue;
    if (/^(收入|净利润|FCF|现金|债务|Capex|OCF|营业利润)$/.test(label) && /^[+-]?\d+(?:\.\d+)?$/.test(cell)) {
      errors.push(`Financial amount cell is bare number in ${label}: ${cell}`);
    }
    if (/^(收入|净利润|FCF|现金|债务|Capex|OCF|营业利润)$/.test(label) && /%/.test(cell)) {
      errors.push(`Financial amount cell contains percent in ${label}: ${cell}`);
    }
    if (/毛利率|营业利润率|最新同比/.test(label) && cell !== '—' && /美元|欧元|人民币|新台币|韩元|亿/.test(cell) && !/%/.test(cell)) {
      errors.push(`Financial ratio cell contains amount in ${label}: ${cell}`);
    }
  }
}

function checkRawMarkdownLeak(html, errors) {
  const tdLeaks = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((match) => stripTags(match[1]))
    .filter((text) => containsMarkdownTable(text) || /\|\s*(指标|Company|云厂商|FY20\d{2})\s*\|/i.test(text));
  if (tdLeaks.length) {
    errors.push(`HTML table cells contain raw Markdown table strings: ${tdLeaks.slice(0, 3).map((item) => escapeHtml(item.slice(0, 120))).join(' / ')}`);
  }
  if (/\|\s*:?-{2,}:?\s*\|/.test(stripTags(html))) {
    errors.push('HTML contains Markdown table separator pattern | --- |');
  }
}

function checkLongTableCells(html, errors, warnings) {
  const cells = [...html.matchAll(/<td\b[^>]*data-label="([^"]*)"[^>]*>([\s\S]*?)<\/td>/gi)];
  for (const match of cells) {
    const label = stripTags(match[1]);
    const text = stripTags(match[2]).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > 500 && !/note|notes|备注|说明/i.test(label)) {
      errors.push(`Table cell too long (${text.length} chars) in column ${label}: ${text.slice(0, 80)}...`);
    } else if (text.length > 220) {
      warnings.push(`Long table cell (${text.length} chars) in column ${label}: ${text.slice(0, 80)}...`);
    }
  }
}

function checkModelProviders(report, errors) {
  const whitelist = new Set(['OpenAI', 'Anthropic', 'Google', 'xAI', 'Meta', 'DeepSeek', 'Alibaba/通义千问', 'Tencent', 'Baidu', 'Mistral', 'Microsoft', 'Amazon', 'Moonshot', 'IBM']);
  for (const entry of report.ai_models || []) {
    if (entry.provider && !whitelist.has(entry.provider) && !entry.provider_override) {
      errors.push(`Invalid AI model provider: ${entry.provider} (${entry.model_name || 'unknown model'})`);
    }
  }
}

function checkRenderableModelsQuality(report, errors) {
  const mainGroups = new Set(['Anthropic', 'OpenAI', 'Gemini / Google', 'xAI', 'Qwen / Alibaba', 'DeepSeek', 'Kimi / Moonshot']);
  const groups = new Set([...mainGroups, '其他']);
  const seen = new Set();
  for (const model of report.renderable_models || []) {
    const providerText = `${model.provider || ''} ${model.model_name || ''}`;
    if (!groups.has(model.provider_group)) errors.push(`Renderable model invalid group: ${model.provider_group}`);
    if (model.provider_group !== modelProviderGroup(providerText)) errors.push(`Renderable model provider/group mismatch: ${model.provider_group} ${providerText}`);
    if (!model.model_name || !model.release_date) errors.push(`Renderable model missing name/date: ${providerText}`);
    if (!model.source_url && !model.source_title) errors.push(`Renderable model missing source: ${providerText}`);
    if (!['high', 'medium'].includes(model.confidence)) errors.push(`Renderable model confidence not verified: ${providerText} ${model.confidence}`);
    const filled = [
      model.release_date,
      model.context_window_display && model.context_window_display !== '—',
      model.modalities_display && model.modalities_display !== '文本',
      model.key_capabilities_cn,
      model.api_pricing_display && model.api_pricing_display !== '—',
      model.status,
      model.next_model_info,
      model.source_url || model.source_title,
    ].filter(Boolean).length;
    if (mainGroups.has(model.provider_group) && filled < 5) errors.push(`Main model table row lacks valuable fields: ${providerText}`);
    if (model.api_pricing_display === '—' && model.pricing_status !== 'missing_official_pricing') errors.push(`Model missing pricing status: ${providerText}`);
    if (model.api_pricing_display && model.api_pricing_display !== '—' && model.pricing_status === 'missing_official_pricing') errors.push(`Model pricing display/status mismatch: ${providerText}`);
    if (model.provider_group === 'DeepSeek' && /ERNIE|Llama|Kimi|Qwen/i.test(providerText)) errors.push(`DeepSeek group contains wrong provider: ${providerText}`);
    if (model.provider_group === 'Kimi / Moonshot' && /ERNIE|Llama|DeepSeek|Qwen/i.test(providerText)) errors.push(`Kimi group contains wrong provider: ${providerText}`);
    const key = `${model.provider_group}|${model.provider}|${model.model_name}`;
    if (seen.has(key)) errors.push(`Duplicate renderable model: ${key}`);
    seen.add(key);
  }
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

function checkFinancialSemantics(report, errors) {
  const financialRows = (report.companies || []).flatMap((company) => company.financial_history_verified || []);
  const coverageRows = (report.companies || []).map((company) => company.financial_coverage).filter(Boolean);
  const sanity = collectFinancialSanityIssues(financialRows, coverageRows);
  errors.push(...sanity.errors.map((error) => `Financial sanity: ${error}`));
  for (const company of report.companies || []) {
    if (!company.financial_coverage || typeof company.financial_coverage.required_metrics_verified_pct !== 'number') errors.push(`Company missing financial coverage summary: ${company.ticker}`);
    for (const row of company.revenue_breakdown || []) {
      const label = `${company.ticker} ${row.segment || ''}`.trim();
      if (row.revenue !== undefined && row.revenue !== null && String(row.revenue).trim() && !row.display && !row.share_display) {
        errors.push(`Business breakdown row has raw revenue but no display/share_display: ${label}`);
      }
      if (row.display && /^[+-]?\d+(?:\.\d+)?$/.test(String(row.display).trim())) errors.push(`Business breakdown display is bare number: ${label}`);
      if (row.display && /\d/.test(String(row.display)) && !/(美元|欧元|人民币|新台币|韩元|亿|万亿|\$|€|¥|₩)/.test(String(row.display))) {
        errors.push(`Business breakdown display lacks currency/unit: ${label} ${row.display}`);
      }
      if (row.share_display && !/%/.test(String(row.share_display))) errors.push(`Business breakdown share_display lacks percent: ${label} ${row.share_display}`);
      if (row.revenue_value !== null && row.revenue_value !== undefined && typeof row.revenue_value !== 'number') errors.push(`Business breakdown revenue_value is not numeric: ${label}`);
    }
    for (const row of company.financial_history_verified || []) {
      if (!row.display || !row.source_title || !row.source_url) errors.push(`Financial history row missing display/source: ${company.ticker} ${row.metric} ${row.period_label}`);
      if (row.display === '-') errors.push(`Financial history row uses hyphen: ${company.ticker} ${row.metric}`);
      if (/^[+-]?\d+(?:\.\d+)?$/.test(String(row.display || '').trim())) errors.push(`Financial history display is bare number: ${company.ticker} ${row.metric} ${row.display}`);
      if (['revenue', 'net_income', 'free_cash_flow', 'cash', 'debt'].includes(row.metric) && /%/.test(String(row.display || ''))) errors.push(`Financial history amount field contains percent: ${company.ticker} ${row.metric}`);
      if (['gross_margin', 'operating_margin'].includes(row.metric) && !/%/.test(String(row.display || ''))) errors.push(`Financial history margin lacks percent: ${company.ticker} ${row.metric}`);
      if (row.metric === 'capex' && /^-/.test(String(row.display || ''))) errors.push(`Financial history Capex displays negative: ${company.ticker} ${row.period_label}`);
    }
    for (const record of company.financials?.annual || []) {
      for (const key of ['revenue', 'net_income', 'fcf', 'debt']) {
        if (record[key] && /%/.test(String(record[key]))) errors.push(`Financial amount field contains percent: ${company.ticker} ${record.fiscal_year} ${key}=${record[key]}`);
      }
      if (record.fiscal_year && !/^(?:FY)?20\d{2}$/.test(String(record.fiscal_year))) errors.push(`Financial annual period not normalized: ${company.ticker} ${record.fiscal_year}`);
    }
    for (const row of company.financials?.latest || []) {
      if (['revenue', 'net_income', 'fcf', 'debt'].includes(row.metric) && /%/.test(String(row.value || ''))) {
        errors.push(`Financial latest amount field contains percent: ${company.ticker} ${row.period} ${row.metric}=${row.value}`);
      }
    }
    for (const row of company.guidance || []) {
      const text = `${row.metric || ''} ${row.comment || ''} ${row.summary || ''}`;
      if ((row.metric === 'CAPEX' || row.metric === '其他资本开支') && /实际值|actual|已披露.*实际/i.test(text)) {
        errors.push(`Actual capex appears in guidance: ${company.ticker} ${row.guidance_value || row.value}`);
      }
    }
    const valuationFields = new Set((company.valuation_verified || []).map((row) => row.field || row.metric));
    const gapText = `${company.gap_summary || ''} ${company.missing_info_prompt || ''}`;
    for (const field of ['Forward PE', 'EV/EBITDA', 'FCF Yield']) {
      const escaped = field.replace('/', '\\/');
      if (valuationFields.has(field) && new RegExp(`(?:缺(?:少|失)?${escaped}|${escaped}(?:缺失|缺少))`).test(gapText)) {
        errors.push(`Valuation gap contradicts verified ${field}: ${company.ticker}`);
      }
    }
  }
}

async function checkRequiredDocs(errors) {
  const required = [
    'docs/portmgmt_public_data_research_2026-06-06.md',
    'docs/public_model_release_data_2026-06-06.md',
    'docs/public_financial_history_sources_2026-06-06.md',
    'docs/model_release_data_gap.md',
    'docs/financial_history_data_gap.md',
  ];
  for (const relative of required) {
    if (!(await pathExists(path.join(PATHS.data, '..', relative)))) errors.push(`Required doc missing: ${relative}`);
  }
}

function checkWatchlistQuality(items = [], errors) {
  const allowedStatus = new Set(['watching', 'holding', 'archived']);
  const allowedInit = new Set(['pending', 'candidate_ready', 'verified', 'rejected']);
  const allowedPriority = new Set(['high', 'medium', 'low']);
  for (const item of items) {
    if (!item.ticker) errors.push('Watchlist row missing ticker');
    if (!item.company_name) errors.push(`Watchlist row missing company_name: ${item.ticker || '<unknown>'}`);
    if (!allowedStatus.has(item.status)) errors.push(`Watchlist invalid status: ${item.ticker} ${item.status}`);
    if (!allowedInit.has(item.init_status)) errors.push(`Watchlist invalid init_status: ${item.ticker} ${item.init_status}`);
    if (!allowedPriority.has(item.priority)) errors.push(`Watchlist invalid priority: ${item.ticker} ${item.priority}`);
    if (!Array.isArray(item.sector_tags) || !item.sector_tags.length) errors.push(`Watchlist missing sector_tags: ${item.ticker}`);
    if (item.init_status === 'verified') {
      const hasSource = item.source_url || item.ir_url || item.website;
      if (!hasSource) errors.push(`Verified watchlist row missing source_url/IR URL: ${item.ticker}`);
      if (!item.exchange) errors.push(`Verified watchlist row missing exchange: ${item.ticker}`);
      if (!item.core_positioning) errors.push(`Verified watchlist row missing core_positioning: ${item.ticker}`);
      if (!Array.isArray(item.recent_filings) || !item.recent_filings.length) errors.push(`Verified watchlist row missing recent filing: ${item.ticker}`);
      if (!Array.isArray(item.missing_fields)) errors.push(`Verified watchlist row missing missing_fields: ${item.ticker}`);
    }
  }
}

function checkCatalystSources(report, errors, warnings) {
  const confirmed = (report.renderable_events || []).filter((event) => event.level === 'L1');
  for (const event of confirmed) {
    const source = event.source_url || event.original_url || event.originalUrl || '';
    if (!source || !/(sec\.gov|investor|ir\.|press-release|earnings|annualreports|公告)/i.test(source)) {
      errors.push(`L1 event lacks official/SEC/IR/earnings source: ${event.id || event.title}`);
    }
  }
  if ((report.summary?.l1_event_count || 0) !== confirmed.length) {
    warnings.push(`Summary L1 count (${report.summary?.l1_event_count || 0}) differs from renderable confirmed count (${confirmed.length}); profile candidates may be held back.`);
  }
}

function shiftDate(dateIso, delta) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function checkMarketData(report, warnings) {
  for (const company of report.companies || []) {
    const quote = company.market_data || {};
    const missing = ['price', 'marketCap', 'return1d', 'return20d', 'returnYtd'].filter((field) => quote[field] === null || quote[field] === undefined);
    if (missing.length) warnings.push(`${company.ticker} market data missing: ${missing.join(', ')}`);
  }
}

function checkDisplayNames(report, errors) {
  for (const company of report.companies || []) {
    if (!company.display_name || !company.display_name.includes('·')) {
      errors.push(`Company display name missing Chinese alias: ${company.ticker}`);
    }
  }
}

function checkMissingText(html, errors, warnings) {
  const visible = stripTags(html).replace(/摘要待补充|观点待补充/g, '');
  const count = (visible.match(/待补充/g) || []).length;
  if (count > 20) errors.push(`Too many scattered 待补充 labels in HTML: ${count}`);
  else if (count > 8) warnings.push(`HTML still contains ${count} 待补充 labels; keep them concentrated in data quality / missing prompt context.`);
  if (/(?: i| A)<\/td>/.test(html)) errors.push('HTML contains suspicious truncated table cell ending.');
}

function checkReportSize(html, warnings) {
  const kb = Buffer.byteLength(html, 'utf8') / 1024;
  if (kb > 900) warnings.push(`HTML is large (${kb.toFixed(1)} KB); inspect for accidental raw content leakage.`);
}

function checkRawKeys(value, errors, pathParts = []) {
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && containsMarkdownTable(value)) {
      errors.push(`Structured report contains raw Markdown table at ${pathParts.join('.') || '<root>'}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkRawKeys(item, errors, [...pathParts, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const fullPath = [...pathParts, key].join('.');
    const allowedRaw = /guidance_rejected|rejected|candidates/i.test(fullPath);
    if (/^raw(_|$)/i.test(key) && !allowedRaw) errors.push(`Structured report contains raw field: ${fullPath}`);
    checkRawKeys(child, errors, [...pathParts, key]);
  }
}

function tickerKey(value = '') {
  return String(value || '').toUpperCase().replace(/\.(O|N|US|DF)$/i, '').replace(/[^A-Z0-9]/g, '');
}

function guidanceMetricMismatch(metric, value = '') {
  const text = String(value || '');
  if (!text || text === '—') return true;
  if (/^(?:20)?\d{2}$|^20\d{2}$/.test(text.trim())) return true;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text.trim())) return true;
  if (text.length > 60) return true;
  if ((metric === '毛利率' || metric === '营业利润率') && !/%/.test(text)) return true;
  if ((metric === '收入' || metric === 'AI收入' || metric === '云收入' || metric === 'FCF') && !/(亿|billion|million|trillion|美元|欧元|韩元|新台币|\$|EUR|USD|KRW|TWD|RMB|收入)/i.test(text)) return true;
  if ((metric === 'CAPEX' || metric === '其他资本开支') && !/(亿|billion|million|trillion|美元|欧元|韩元|新台币|\$|EUR|USD|KRW|TWD|RMB|%|占收入)/i.test(text)) return true;
  if ((metric === '产能' || metric === '出货量' || metric === '订单' || metric === '订单积压') && !/(台|片|套|座|GW|MW|万|亿|美元|欧元|韩元|新台币|\$|EUR|USD|KRW|TWD|RMB|订单|系统|unit|units|wafers?)/i.test(text)) return true;
  return false;
}

function similarText(a = '', b = '') {
  const left = String(a || '').replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '');
  const right = String(b || '').replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '');
  if (!left || !right) return 0;
  const leftSet = new Set([...left]);
  const rightSet = new Set([...right]);
  const shared = [...leftSet].filter((char) => rightSet.has(char)).length;
  return shared / Math.max(leftSet.size, rightSet.size);
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
