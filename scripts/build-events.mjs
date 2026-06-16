import path from 'node:path';
import {
  PATHS,
  compactWhitespace,
  hashId,
  normalizeExactDate,
  readJson,
  shortText,
  todayInZone,
  writeJson,
} from './shared.mjs';

async function main() {
  const config = await readJson(PATHS.config, {});
  const reportDate = process.argv[2] || todayInZone(config.report_timezone || process.env.REPORT_TZ || 'Asia/Shanghai');
  const companiesData = await readJson(path.join(PATHS.data, 'companies.json'), { companies: [] });
  const factsData = await readJson(path.join(PATHS.data, 'supplemental_facts.json'), { facts: [] });
  const profileEvents = await readJson(path.join(PATHS.data, 'events.json'), { events: [] });
  const obsidian = await readJson(path.join(PATHS.data, 'obsidian_hits.json'), { hits: [] });
  const aliases = await readJson(path.join(PATHS.data, 'company_aliases.json'), {});
  const companies = (companiesData.companies || [])
    .filter((company) => company.status !== 'archived')
    .map((company) => ({
      ...company,
      short_cn: company.chinese_name || aliases[company.ticker]?.short_cn || aliases[company.display_ticker]?.short_cn || null,
    }));
  const companyByKey = new Map(companies.flatMap((company) => [
    [tickerKey(company.ticker), company],
    [tickerKey(company.display_ticker), company],
    [tickerKey(company.yfinance_ticker), company],
  ].filter(([key]) => key)));

  const candidates = [
    ...factsData.facts.map((fact) => eventFromFact(fact, companyByKey, reportDate)),
    ...(obsidian.hits || []).map((hit) => eventFromObsidian(hit, companyByKey, reportDate)),
    ...(profileEvents.events || []).map((event) => eventFromProfile(event, companyByKey, reportDate)),
  ].filter(Boolean);

  const filterStats = {
    outside_7_day_window: 0,
    unmatched_ticker: 0,
    low_quality_or_non_driver: 0,
  };
  const windowed = [];
  const rejected = [];
  for (const event of candidates) {
    if (!inEventWindow(event.date_iso, reportDate)) {
      filterStats.outside_7_day_window += 1;
      rejected.push(rejectedEvent(event, 'outside_7_day_window'));
      continue;
    }
    if (!companyByKey.has(tickerKey(event.ticker))) {
      filterStats.unmatched_ticker += 1;
      rejected.push(rejectedEvent(event, 'unmatched_ticker'));
      continue;
    }
    const rejectReason = badEventReason(event);
    if (rejectReason) {
      filterStats.low_quality_or_non_driver += 1;
      rejected.push(rejectedEvent(event, rejectReason));
      continue;
    }
    windowed.push(withRecentMarker(event, reportDate));
  }

  const events = dedupeBy(windowed, (event) => `${event.ticker}|${event.date_iso}|${event.type}|${event.event}`)
    .sort((a, b) => b.date_iso.localeCompare(a.date_iso) || a.ticker.localeCompare(b.ticker))
    .map(sanitizeEventForOutput)
    .filter((event) => !badEventReason(event));

  const out = {
    meta: {
      report_date: reportDate,
      window_start: shiftDate(reportDate, -6),
      window_end: reportDate,
      generated_at: new Date().toISOString(),
      rule: '仅展示 report_date - 6 days 至 report_date 且匹配股票池的事件。',
      filtered: filterStats,
    },
    events,
    company_news: events.filter((event) => event.type === '公司新闻'),
    company_announcements: events.filter((event) => event.type === '公司公告'),
    industry_background: events.filter((event) => event.type === '行业背景'),
    market_factors: events.filter((event) => event.type === '市场/板块因素'),
  };
  await writeJson(path.join(PATHS.data, 'event_summary.json'), out);
  await writeJson(path.join(PATHS.data, 'events_rejected.json'), {
    report_date: reportDate,
    rows: rejected.slice(0, 500),
  });
  console.log(`Built event summary: ${out.company_news.length} news, ${out.company_announcements.length} announcements.`);
}

function eventFromFact(fact, companyByKey) {
  const company = companyByKey.get(tickerKey(fact.ticker));
  if (!company) return null;
  const date = extractEventDate(fact.period);
  if (!date) return null;
  const type = announcementLike(fact) ? '公司公告' : '公司新闻';
  const direction = directionFor(`${fact.field} ${fact.value} ${fact.notes}`);
  const importance = importanceFor(fact, type);
  const event = eventTitleForFact(fact, company);
  return {
    id: `event_${hashId(fact.id, date, type)}`,
    date_iso: date,
    date: mmdd(date),
    ticker: company.ticker,
    display_ticker: company.display_ticker || fact.display_ticker || company.ticker,
    company: company.short_cn || company.chinese_name || company.company_name || fact.company || company.ticker,
    type,
    event,
    direction,
    importance,
    commentary: type === '公司公告' ? commentaryFor(fact, direction) : '',
    origin: 'supplemental',
    source_kind: fact.source_type || fact.source_dataset || 'supplemental',
    raw_title: fact.value,
  };
}

function eventFromObsidian(hit, companyByKey) {
  const company = companyByKey.get(tickerKey(hit.ticker));
  if (!company) return null;
  const date = extractEventDate(hit.date);
  if (!date) return null;
  const title = compactWhitespace(hit.title || '');
  if (!title || /bae\d|NHN Corp|review|\.KS/i.test(title)) return null;
  if (!obsidianEventIsActionable(hit, company)) return null;
  const direction = directionFor(`${hit.impact || ''} ${hit.summary || title}`);
  const type = /公告|财报|电话会|业绩|investor|IR|press/i.test(`${title} ${hit.event_type || ''}`) ? '公司公告' : '公司新闻';
  return {
    id: `event_obs_${hashId(hit.file, title, date)}`,
    date_iso: date,
    date: mmdd(date),
    ticker: company.ticker,
    display_ticker: company.display_ticker || company.ticker,
    company: company.short_cn || company.chinese_name || company.company_name || company.ticker,
    type,
    event: eventTextFromObsidian(hit, company),
    direction,
    importance: /财报|电话会|公告|业绩/.test(title) ? '高' : '中',
    commentary: type === '公司公告' ? commentaryFor({ field: hit.event_type || 'company_update', value: title, notes: hit.summary }, direction) : '',
    origin: 'obsidian',
    source_kind: 'obsidian',
    raw_title: title,
  };
}

function eventFromProfile(event, companyByKey) {
  const company = companyByKey.get(tickerKey(event.ticker));
  if (!company) return null;
  const date = extractEventDate(event.date || event.date_text);
  if (!date) return null;
  return {
    id: `event_profile_${hashId(event.id, date)}`,
    date_iso: date,
    date: mmdd(date),
    ticker: company.ticker,
    display_ticker: company.display_ticker || company.ticker,
    company: company.short_cn || company.chinese_name || company.company_name || company.ticker,
    type: /公告|财报|业绩|指引/.test(event.title || event.summary || '') ? '公司公告' : '公司新闻',
    event: cleanChineseEvent(event.title || event.summary),
    direction: directionFor(event.impact || event.impact_direction || event.summary),
    importance: event.level === 'L1' ? '高' : '中',
    commentary: event.level === 'L1' ? commentaryFor({ field: event.event_type || 'company_update', value: event.title, notes: event.summary }, event.impact || event.impact_direction) : '',
    origin: 'profile',
    source_kind: event.source_type || 'profile',
    raw_title: event.title,
  };
}

function extractEventDate(value) {
  const exact = normalizeExactDate(value || '');
  if (exact) return exact;
  const text = String(value || '');
  const ymd = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  return ymd ? ymd[0] : null;
}

function announcementLike(fact) {
  return /(SEC|Filing|IR|Company|Earnings|Press_Release|press_release|annual_report|quarterly|guidance|announcement|财报|公告)/i.test(`${fact.source_type} ${fact.field}`);
}

function importanceFor(fact, type) {
  if (type === '公司公告' && /(GUIDANCE|REVISION|CAPEX|Major|Latest Quarterly|Annual|capacity|project)/i.test(fact.field)) return '高';
  if (/(CAPACITY_PROJECT|AI-Related|Major Catalyst)/i.test(fact.field)) return '中';
  return '低';
}

function directionFor(text = '') {
  const clean = String(text || '');
  if (/lowered|down|headwind|decline|risk|delay|tariff|miss|下调|削减|承压|风险|利空|下降/i.test(clean)) return '利空';
  if (/raised|increase|growth|strong|accelerated|completed|launched|invest|partner|up|beat|上调|增长|提升|完成|发布|合作|利好|超预期/i.test(clean)) return '利好';
  if (/verify|uncertain|待验证|不确定/i.test(clean)) return '待验证';
  return '中性';
}

function eventTitleForFact(fact, company) {
  const label = fieldLabel(fact.field);
  const subject = company.short_cn || company.chinese_name || company.company_name || company.ticker;
  const value = zhSnippet(fact.value);
  const notes = zhSnippet(fact.notes);
  return naturalEventSummary({ subject, label, value, notes });
}

function naturalEventSummary({ subject, label, value, notes }) {
  const cleanValue = cleanEventText(value);
  const cleanNotes = cleanEventText(notes);
  const combined = [cleanValue, cleanNotes].filter(Boolean).join('；');
  if (/财报|季度报告/.test(label)) {
    const revenue = metricPhrase(combined, /收入[^；。]*?(?:同比|YoY)?\s*[+＋-]?\s*\d+(?:\.\d+)?%?/i);
    const eps = metricPhrase(combined, /EPS[^；。]*?(?:\$|USD)?\s*\d+(?:\.\d+)?/i);
    return shortNoEllipsis(`${subject}发布最新季度业绩${revenue ? `，${revenue}` : ''}${eps ? `，${eps}` : ''}`, 78);
  }
  if (/经营指引|指引/.test(label)) {
    const revenue = metricPhrase(combined, /(?:FY|Q)?20?\d{0,4}[^；。]{0,12}收入[^；。]{0,42}/i);
    const margin = metricPhrase(combined, /(?:毛利率|营业利润率|operating margin|gross margin)[^；。]{0,36}/i);
    return shortNoEllipsis(`${subject}更新经营指引${revenue ? `，${revenue}` : ''}${margin ? `，${margin}` : ''}`, 78);
  }
  if (/资本开支|AI基建|产能/.test(label)) {
    const capex = metricPhrase(combined, /(?:\$|USD|EUR)?\s*\d+(?:\.\d+)?\s*(?:billion|million|亿美元|亿欧元|GW|MW|万台|台)[^；。]{0,28}/i);
    return shortNoEllipsis(`${subject}${label}${capex ? `，${capex}` : ''}`, 78);
  }
  if (/AI相关布局/.test(label)) return shortNoEllipsis(`${subject}披露AI相关业务进展，需求和订单动能仍需跟踪`, 78);
  return shortNoEllipsis(`${subject}${label}${combined ? `：${combined}` : ''}`, 78);
}

function metricPhrase(text, pattern) {
  const match = cleanEventText(text).match(pattern);
  return match ? cleanEventText(match[0]) : '';
}

function shortNoEllipsis(text = '', max = 80) {
  const clean = cleanEventText(text);
  return clean.length > max ? clean.slice(0, max) : clean;
}

function fieldLabel(field = '') {
  if (/AI_CAPEX_GUIDANCE_REVISION/i.test(field)) return '上调AI资本开支指引';
  if (/AI_CAPEX_GUIDANCE|CAPEX Plans|capital_expenditure_guidance/i.test(field)) return '披露资本开支指引';
  if (/AI_CAPEX_ACTUAL|quarterly_CAPEX|capital_expenditure_actual/i.test(field)) return '披露资本开支实际值';
  if (/REVENUE_GUIDANCE|management_guidance|Management Guidance/i.test(field)) return '披露经营指引';
  if (/Latest Quarterly/i.test(field)) return '发布最新季度报告';
  if (/CAPACITY_PROJECT|major_AI_infrastructure_project|capacity_expansion/i.test(field)) return '推进AI基建/产能项目';
  if (/Major Catalyst Event/i.test(field)) return '出现重要催化';
  if (/AI-Related Initiative|AI_supply_chain/i.test(field)) return '推进AI相关布局';
  if (/annual_report/i.test(field)) return '更新年度报告';
  return `更新${compactWhitespace(field)}`;
}

function zhSnippet(text = '') {
  const clean = compactWhitespace(text).replace(/\s+/g, ' ');
  if (!clean) return '';
  return shortNoEllipsis(clean
    .replace(/Ciena Corporation/gi, 'Ciena')
    .replace(/Broadcom Inc\.?/gi, '博通')
    .replace(/Broadcom/gi, '博通')
    .replace(/Alibaba Group Holding Limited/gi, '阿里巴巴')
    .replace(/Alphabet Inc\.?/gi, '谷歌')
    .replace(/Synopsys ARC Processor IP/gi, 'Synopsys处理器IP')
    .replace(/co-located data center and generation complex/gi, '共址数据中心和发电综合体')
    .replace(/co-located data center/gi, '共址数据中心')
    .replace(/generation complex/gi, '发电综合体')
    .replace(/community fund announced/gi, '社区基金已公布')
    .replace(/battery storage/gi, '储能')
    .replace(/on-site gas-fired generation/gi, '现场燃气发电')
    .replace(/\bsolar\b/gi, '光伏')
    .replace(/European technical infrastructure investment/gi, '欧洲技术基础设施投资')
    .replace(/European tech/gi, '欧洲技术基础设施')
    .replace(/integrating\s+w\w*/gi, '整合供电资源')
    .replace(/Part of continued/gi, '持续推进')
    .replace(/period ended [^;；。]+/gi, '')
    .replace(/adjusted EPS/gi, '调整后EPS')
    .replace(/adjusted gross margin/gi, '调整后毛利率')
    .replace(/adjusted operating margin/gi, '调整后营业利润率')
    .replace(/capital expenditure|CapEx|CAPEX/g, '资本开支')
    .replace(/data center/gi, '数据中心')
    .replace(/cloud/gi, '云')
    .replace(/revenue/gi, '收入')
    .replace(/guidance/gi, '指引')
    .replace(/quarter/gi, '季度')
    .replace(/year over year|YoY/gi, '同比')
    .replace(/up /gi, '提升 ')
    .replace(/growth/gi, '增长')
    .replace(/AI infrastructure/gi, 'AI基础设施')
    .replace(/compute facility/gi, '算力设施'), 120);
}

function cleanChineseEvent(title = '') {
  const clean = compactWhitespace(title)
    .replace(/^TMT\s*[-–]\s*/i, '')
    .replace(/review|transcript|full notes/gi, '纪要')
    .replace(/earnings call/gi, '电话会')
    .replace(/FY202026/gi, 'FY2026')
    .replace(/FY(\d{2})(?!\d)/gi, 'FY20$1')
    .replace(/Q([1-4])/gi, 'Q$1');
  if (/即将发布.*财报/.test(clean)) return shortNoEllipsis(`${clean}，需关注收入和毛利率指引`, 80);
  if (/完成收购Synopsys(?: ARC Processor IP|处理器IP)业务/i.test(clean)) return '完成收购Synopsys处理器IP业务，扩展嵌入式产品组合';
  if (/Genesis Mission/i.test(clean)) return '宣布与美国能源部Genesis Mission合作，推进半导体制造生态';
  return shortNoEllipsis(clean, 80);
}

function obsidianEventIsActionable(hit, company) {
  const text = `${hit.title || ''} ${hit.summary || ''} ${hit.why_it_matters || ''}`;
  const companyToken = `${company.ticker} ${company.display_ticker} ${company.short_cn || ''} ${company.chinese_name || ''} ${company.company_name || ''}`;
  if (!new RegExp(escapeRegExp(company.display_ticker || company.ticker), 'i').test(text) && company.short_cn && !text.includes(company.short_cn)) {
    if (!/(财报|电话会|公告|目标价|上调|下调|订单|收入|毛利|指引|合作|收购|产能|资本开支)/.test(text)) return false;
  }
  if (/原始链接|weixin\.qq\.com|com\/s\/|^\s*[A-Za-z .,&-]+\s*$/i.test(hit.title || '')) return false;
  if (/TMT外资观点|行业深度|前瞻|策略|基金策略|存储周期|光通信与高速光互联|AI疯狂抢内存/i.test(hit.title || '')) return false;
  return /(财报|电话会|公告|目标价|上调|下调|订单|收入|毛利|指引|合作|收购|股息|回购|产能|资本开支)/.test(`${text} ${companyToken}`);
}

function eventTextFromObsidian(hit, company) {
  const subject = company.short_cn || company.chinese_name || company.display_ticker || company.ticker;
  const text = cleanEventText(`${hit.title || ''}；${hit.why_it_matters || hit.summary || ''}`);
  if (/电话会|财报/.test(text)) return shortNoEllipsis(`${subject}财报电话会显示${extractObsidianPoint(text)}`, 76);
  if (/目标价|上调|下调/.test(text)) return shortNoEllipsis(`${subject}获分析师调整预期，${extractObsidianPoint(text)}`, 76);
  if (/订单|收入|毛利|指引/.test(text)) return shortNoEllipsis(`${subject}披露经营变化，${extractObsidianPoint(text)}`, 76);
  if (/合作|收购|股息|回购/.test(text)) return shortNoEllipsis(`${subject}${extractObsidianPoint(text)}`, 76);
  return '';
}

function extractObsidianPoint(text = '') {
  const clean = cleanEventText(text);
  const sentence = clean.split(/[。；;]/).find((part) => /(收入|订单|毛利|指引|目标价|上调|下调|合作|收购|股息|回购|\d)/.test(part));
  return shortNoEllipsis(sentence || '需跟踪订单、利润和估值兑现', 52);
}

function cleanEventText(value = '') {
  if (value === null || value === undefined) return '';
  return standardizeEventMetrics(compactWhitespace(value)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bweixin\.qq\.com\/s\/\S*/gi, '')
    .replace(/\bcom\/s\/\S*/gi, '')
    .replace(/\b[a-f0-9]{10,}_/gi, '')
    .replace(/Date approximate/gi, '')
    .replace(/\breleased\s*[：:]?/gi, '发布')
    .replace(/TMT\s*[-–]\s*/gi, '')
    .replace(/FY202026/gi, 'FY2026')
    .replace(/Broadcom Inc\.?/gi, '博通')
    .replace(/Broadcom/gi, '博通')
    .replace(/Ciena Corporation/gi, 'Ciena')
    .replace(/Alphabet Inc\.?/gi, '谷歌')
    .replace(/Synopsys ARC Processor IP/gi, 'Synopsys处理器IP')
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
    .replace(/原始链接|资料：wechat|来源平台：wechat|来源：wechat|原始来源|来源/g, '')
    .replace(/\.{3,}|…/g, '')
    .replace(/\s+[A-Z]$/g, '')
    .replace(/\s+/g, ' ')
    .trim());
}

function standardizeEventMetrics(value = '') {
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

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commentaryFor(fact, direction) {
  const text = `${fact.field || ''} ${fact.value || ''} ${fact.notes || ''}`;
  if (/CAPEX|capital expenditure|数据中心|AI基础设施/i.test(text)) {
    return direction === '利空' ? '资本开支压力升温，短期现金流和估值承压。' : '资本开支投入上修，设备与网络链订单弹性增强。';
  }
  if (/guidance|指引|收入|revenue/i.test(text)) {
    return direction === '利空' ? '指引走弱削弱增长确定性，需跟踪订单恢复。' : '收入指引改善，短期估值支撑和订单能见度增强。';
  }
  if (/earnings|财报|EPS|毛利|利润/i.test(text)) return '收入和利润率指标改善，确认需求回升趋势。';
  if (/acquisition|收购|completed/i.test(text)) return '并购整合进入兑现期，需跟踪收入和利润贡献。';
  return direction === '利空' ? '披露削弱短期确定性，需观察后续订单验证。' : '披露改善订单能见度，需跟踪财务兑现。';
}

function announcementCommentary(event) {
  const text = cleanEventText(`${event.ticker || ''} ${event.event || ''} ${event.raw_title || ''}`);
  if (/AVGO|博通/i.test(text) && /AI半导体|AI芯片|盘后|Q2|Q3/i.test(text)) return 'AI半导体收入高增，但盘后下跌显示预期已较高。';
  if (/CIEN|Ciena/i.test(text) && /指引|毛利率|全年|FY2026/i.test(text)) return '全年收入和毛利率指引上修，验证云与运营商需求回升。';
  if (/CIEN|Ciena/i.test(text) && /收入|EPS|季度业绩/i.test(text)) return '季度收入和EPS超预期，光网络需求回暖得到验证。';
  if (/CIEN|Ciena/i.test(text) && /AI相关|数据中心/i.test(text)) return 'AI数据中心需求改善，后续看订单转收入节奏。';
  if (/GOOGL|谷歌/i.test(text) && /AI基建|产能项目|数据中心|GW/i.test(text)) return '数据中心项目推进，AI算力投入继续支撑云需求。';
  if (/收购|并购/i.test(text)) return '并购进入整合阶段，后续看收入协同和利润贡献。';
  if (/资本开支|Capex|数据中心/i.test(text)) return '资本开支继续投向AI基础设施，需跟踪现金流回报。';
  if (/收入|EPS|毛利|利润/i.test(text)) return '业绩指标改善，需观察订单和毛利率能否延续。';
  if (/指引/i.test(text)) return '经营指引更新，后续重点看收入和毛利率兑现。';
  return '公告信息已结构化，后续跟踪订单、利润率和现金流影响。';
}

function withRecentMarker(event, reportDate) {
  if (!inRecentDays(event.date_iso, reportDate, 3)) return { ...event, emoji: '' };
  if (event.type === '公司公告' && event.importance === '高') return { ...event, emoji: '📌' };
  if (event.direction === '利好') return { ...event, emoji: '🟢' };
  if (event.direction === '利空') return { ...event, emoji: '🔴' };
  return { ...event, emoji: '🟡' };
}

function badEventReason(event) {
  const text = `${event.raw_title || ''} ${event.event || ''}`;
  if (!cleanEventText(event.event)) return 'empty_event';
  if (/\b202[2-4]-\d{2}-\d{2}\b/.test(text)) return 'old_date_in_text';
  if (/688289\.SH|NHN Corp|bae\d|黑莓 利空 2022|高通 利空 2022/i.test(text)) return 'entity_or_old_noise';
  if (/股票融资计划|债务融资|未完成订单|伯克希尔投资/i.test(text)) return 'non_driver_financing_or_irrelevant';
  if (/Date approximate|released|Qwen|Claude|Gemini|GPT|model release|模型发布/i.test(text)) return 'model_or_raw_release_noise';
  if (/出现公司相关更新，需继续验证基本面影响|需继续验证基本面影响|披露经营变化，一句话结论|一句话结论|一句话总结|这意味着\s*$/i.test(text)) return 'raw_research_summary';
  if (/Yole预测.*CPO市场|行业规模预测|市场将从20\d{2}/i.test(text)) return 'industry_forecast_misattributed';
  if (/即将发布.*财报/i.test(text)) return 'stale_upcoming_event';
  if (/https?:\/\/|weixin\.qq\.com|com\/s\/|\.{3,}|…/.test(text)) return 'source_or_truncation_noise';
  if (/^[A-Za-z .,&-]{4,}$/.test(compactWhitespace(event.event || ''))) return 'untranslated_title';
  return null;
}

function sanitizeEventForOutput(event) {
  const eventText = shortNoEllipsis(cleanEventText(event.event), 80);
  return {
    id: event.id,
    date_iso: event.date_iso,
    date: event.date || mmdd(event.date_iso),
    ticker: event.ticker,
    display_ticker: event.display_ticker || event.ticker,
    company: cleanEventText(event.company),
    type: event.type,
    event: eventText,
    direction: event.direction,
    importance: event.importance,
    commentary: event.type === '公司公告' ? shortNoEllipsis(cleanEventText(announcementCommentary({ ...event, event: eventText })), 45) : '',
    emoji: event.emoji || '',
    origin: event.origin || 'unknown',
    source_kind: event.source_kind || 'unknown',
  };
}

function rejectedEvent(event, reason) {
  return {
    reason,
    date_iso: event?.date_iso || null,
    ticker: event?.ticker || null,
    type: event?.type || null,
    event: cleanEventText(event?.event || ''),
    raw_title: cleanEventText(event?.raw_title || ''),
    origin: event?.origin || 'unknown',
  };
}

function inEventWindow(dateIso, reportDate) {
  return dateIso >= shiftDate(reportDate, -6) && dateIso <= reportDate;
}

function inRecentDays(dateIso, reportDate, days) {
  return dateIso >= shiftDate(reportDate, -(days - 1)) && dateIso <= reportDate;
}

function shiftDate(dateIso, delta) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function mmdd(dateIso) {
  return `${dateIso.slice(5, 7)}/${dateIso.slice(8, 10)}`;
}

function tickerKey(value = '') {
  return String(value || '').toUpperCase().replace(/\.(O|N|US|DF)$/i, '').replace(/[^A-Z0-9]/g, '');
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
