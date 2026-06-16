import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir, readJson, todayInZone, writeJson } from '../shared.mjs';

export const AAOI_DEFAULTS = {
  ticker: 'AAOI',
  company_name: 'Applied Optoelectronics',
  exchange: 'NASDAQ',
  sector_tags: ['光通信', '数据中心', '光模块'],
};

export function parseArgs(argv = process.argv.slice(2)) {
  const [tickerRaw, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { ticker: normalizeTicker(tickerRaw), flags };
}

export async function loadConfig() {
  return readJson(PATHS.config, {});
}

export async function saveConfig(config) {
  await writeJson(PATHS.config, config);
}

export function ensureWatchlist(config) {
  config.watchlist = Array.isArray(config.watchlist) ? config.watchlist : [];
  return config.watchlist;
}

export function normalizeTicker(value = '') {
  return String(value || '').trim().toUpperCase();
}

export function defaultWatchlistItem(ticker, flags = {}, config = {}) {
  const known = ticker === 'AAOI' ? AAOI_DEFAULTS : { ticker, company_name: flags.companyName || ticker, sector_tags: [] };
  const today = todayInZone(config.report_timezone || process.env.REPORT_TZ || 'Asia/Shanghai');
  return {
    ticker,
    company_name: flags.companyName || known.company_name || ticker,
    status: flags.status || 'watching',
    is_holding: false,
    priority: flags.priority || 'medium',
    sector_tags: parseTags(flags.sectorTags) || known.sector_tags || [],
    init_status: 'pending',
    added_at: today,
    updated_at: today,
    notes: flags.notes || '新增观察标的，先建档，不进入组合收益计算。',
  };
}

export function parseTags(value) {
  if (!value) return null;
  return String(value).split(/[,，、/]/).map((item) => item.trim()).filter(Boolean);
}

export async function updateWatchlistItem(ticker, updater) {
  const config = await loadConfig();
  const list = ensureWatchlist(config);
  const index = list.findIndex((item) => normalizeTicker(item.ticker) === ticker);
  if (index === -1) throw new Error(`Watchlist ticker not found: ${ticker}`);
  list[index] = { ...list[index], ...updater(list[index], config) };
  await saveConfig(config);
  return list[index];
}

export async function writeTextFile(file, text) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, text, 'utf8');
}

export function aaoiResearchPrompt() {
  return `你是资料库研究 AI。请为 PortMgmt 新增关注标的 AAOI（Applied Optoelectronics）搜集基础资料，并输出严格 JSON，不要自由发挥。

目标：
为 AAOI 建立初始 profile candidate。AAOI 暂为 watching，不进入组合收益计算。

请搜集并结构化以下信息：

1. 基础信息
- ticker
- 交易所
- 公司中英文名
- 官网
- IR 页面
- 最近 10-K / 10-Q / 8-K 链接
- 所属行业与子行业
- 业务标签：光通信、光模块、数据中心、AI基础设施、CATV、Telecom 等

2. 核心卡位
- 1-2 句中文说明 AAOI 在产业链中的位置
- 主要客户类型
- 是否受益 AI 数据中心光互联需求

3. 业务拆分
- 数据中心
- CATV
- Telecom
- 其他
每个板块尽量给收入、占比、同比；没有公开数据则填 null。

4. 最近财务指标
至少最近一个全年和最近两个季度：
- 收入
- 毛利率
- 营业利润率
- 净利润
- EPS
- FCF
- Capex
- 现金
- 债务
- 净现金/净债务
每项必须有 period、value、unit、source_url、as_of。

5. 管理层指引
- 最近半年收入指引
- 毛利率指引
- EPS 指引
- Capex / 产能 / 产线扩张指引
- 数据中心业务指引
- 客户需求或订单指引
每条必须有日期、期间、指标、指引值、来源。

6. 估值
- 当前市值
- PE
- Forward PE
- PS
- EV/EBITDA
- FCF Yield
- FY2026E EPS
- FY2027E EPS
没有可靠公开来源则填 null，不要编造。

7. 近期事件
只搜集最近 30 日：
- 公司公告
- 财报
- 客户/订单
- 分析师评级
- 行业事件
每条注明日期、方向、重要性、source_url。

8. 风险要素
最多 5 条：
- 客户集中度
- 毛利率波动
- 数据中心需求不及预期
- 融资/现金流压力
- 竞争加剧
每条必须有触发条件和潜在影响。

输出要求：
- 只输出 JSON。
- 不要 Markdown。
- 不要长段英文。
- 不要 URL 以外的原文粘贴。
- 所有数值必须带单位。
- 所有事实必须有 source_url 或 source_title。
- 无法确认的数据填 null，并在 missing_fields 中解释。
- confidence 只能为 high、medium、low。
- low confidence 不应进入 verified 数据。

JSON schema：

{
  "ticker": "AAOI",
  "company_name": "Applied Optoelectronics",
  "status": "watching",
  "basic_info": {},
  "core_positioning": "",
  "business_segments": [],
  "financials": [],
  "guidance": [],
  "valuation": [],
  "recent_events": [],
  "risks": [],
  "missing_fields": [],
  "sources": []
}
`;
}
