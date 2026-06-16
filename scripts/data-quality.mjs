import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PATHS,
  ensureDir,
  readJson,
  todayInZone,
  writeJson,
} from './shared.mjs';

async function main() {
  const config = await readJson(PATHS.config, {});
  const reportDate = process.argv[2] || todayInZone(config.report_timezone || process.env.REPORT_TZ || 'Asia/Shanghai');
  const reportPath = path.join(PATHS.reports, reportDate, `${reportDate}.json`);
  const report = await readJson(reportPath, null);
  if (!report) throw new Error(`Missing report JSON: ${reportPath}`);
  await ensureDir(PATHS.dataQuality);
  await ensureDir(path.join(PATHS.data, '..', 'data_quality'));
  const missingPath = path.join(PATHS.dataQuality, `missing_info_prompt_${reportDate}.md`);
  const auditPath = path.join(PATHS.dataQuality, `audit_${reportDate}.md`);
  const rootAuditPath = path.join(PATHS.data, '..', 'data_quality', `audit_${reportDate}.md`);
  const missingMarkdown = renderMissingPrompt(report);
  const auditMarkdown = renderAudit(report);
  await fs.writeFile(missingPath, missingMarkdown, 'utf8');
  await fs.writeFile(auditPath, auditMarkdown, 'utf8');
  await fs.writeFile(rootAuditPath, auditMarkdown, 'utf8');
  await writeJson(path.join(PATHS.dataQuality, `quality_${reportDate}.json`), report.data_quality || {});
  console.log(`Audit written: ${path.relative(PATHS.data, auditPath)}`);
  console.log(`Missing prompt written: ${path.relative(PATHS.data, missingPath)}`);
}

function renderAudit(report) {
  const q = report.data_quality || {};
  const issues = [
    ['原始 Markdown 表格泄漏', 'parser/schema/renderer', '历史版本把 Markdown table 压进 raw_excerpt/raw_tables，再由 renderer 当普通字段显示。', '导入层删除 raw_*，表格转 headers/rows/metric facts；validate-report 检查 HTML 泄漏。'],
    ['财务字段错配重复', 'parser/schema', '旧 parser 用整段文本 regex 抽取，收入/利润/毛利率/FCF 可能命中同一表格。', '财务表按 metric + period + value 归一，无法识别的行进入 extraction_warnings。'],
    ['AI Capex 大段塞单元格', 'parser/renderer', '旧 ai_capex 把模块7全文或整张表压成 capex_guidance。', '拆成 hyperscaler/china/supply_chain_mapping 三类结构化表。'],
    ['模型 Provider 错误', 'schema/renderer', '旧逻辑把持仓公司作为 fallback provider。', '引入模型厂商白名单；持仓只作为 impacted_holdings。'],
    ['行情/市值缺失', '缺少外部数据', '旧 renderer 只显示 price_performance stub。', '新增 Yahoo chart market cache；估值字段拿不到则 partial/missing，不编造。'],
    ['Obsidian 未有效提取', 'source mapping', '旧版本没有 vault scanner。', `当前状态：${q.obsidian_status || 'unknown'}；配置后只提取摘要/路径/URL/验证状态。`],
    ['L1/L2/L3 边界不清', 'schema/renderer', 'profile 事件以前直接进入页面事件流。', 'profile 候选默认 needs_source；缺原始链接的事件转入 missing_info_prompt。'],
    ['页面内容过长', 'renderer', '长段落和表格没有长度门槛。', '渲染 helper 截短摘要；validate-report 对 td 长度设置 warning/fail。'],
    ['缺失信息无闭环', 'data quality', '旧版本只有“待补充”展示，没有结构化追问。', '生成 missing_info_prompt，按模块/公司列字段、格式、来源偏好。'],
    ['质量门槛缺失', 'validation', '旧 test 只校验数组存在和 L1 source。', '新增 validate-report，覆盖 raw table、长单元格、模型白名单、事件来源、市场缺口。'],
  ];
  return `# PortMgmt Data Quality Audit / ${report.meta.report_date}

## 审计范围

- PortMgmt.docx：已抽取 PRD 核心要求，重点是 L1/L2/L3、Obsidian、本地静态报告。
- dailybrief_ui_web_prompts.md：确认 UI 只作为输出层，renderer 不应消费原始 Markdown。
- initial/*_profile.md：${report.library?.imports?.filter((item) => item.source_type === 'initial_profile').length || 0} 个 profile。
- data/*.json 与当前 HTML：已按结构化链路重新生成。
- portfolio.config.json：已补 benchmark/yfinance ticker mapping。

## 最严重 10 类问题

${issues.map((item, index) => `### ${index + 1}. ${item[0]}

- 根因分类：${item[1]}
- 根因：${item[2]}
- 修复方案：${item[3]}
`).join('\n')}

## 当前质量摘要

- 缺失字段公司数：${q.missing_required_fields_by_company?.length || 0}
- extraction warnings：${q.extraction_warnings?.length || 0}
- missing info prompt：${q.missing_info_prompt_count || 0}
- 事件来源完整度：${q.event_source_completeness?.renderable || 0}/${q.event_source_completeness?.total || 0} 可渲染
- 模型 provider 校验：${q.model_provider_validation?.status || 'pending'}
- Obsidian 状态：${q.obsidian_status || 'not_configured'}
`;
}

function renderMissingPrompt(report) {
  const grouped = groupBy(report.missing_info_prompt || [], (item) => item.module || '其他缺口');
  const sections = [
    '公司基础信息缺口',
    '财务与估值缺口',
    '管理层指引缺口',
    'CAPEX/产能缺口',
    'AI Capex 专项缺口',
    '模型发布缺口',
    '催化事件原始来源缺口',
    'Obsidian 验证缺口',
  ];
  const body = sections.map((section) => renderPromptSection(section, grouped[section] || [])).join('\n');
  return `# PortMgmt 缺失信息汇总 Prompt / ${report.meta.report_date}

请基于专业知识库、公司 IR、SEC/交易所公告、财报电话会、Reuters/Bloomberg/权威行业媒体或已归档 Obsidian 原文，补充以下缺口。不要编造；无法确认请返回 null，并说明原因。

返回格式优先使用 JSON 数组；如用 Markdown 表格，列必须包含：ticker/company、field、value、period/date、original_url、source_type、confidence、notes。

${body}

## 返回要求

请用 JSON 或 Markdown 表格返回，便于 Codex 再导入。公开行情可由 Yahoo/yfinance 获取的价格、市值、1D/5D/20D/YTD 不需要人工补；只补需要专业判断或原始来源验证的信息。
`;
}

function renderPromptSection(title, items) {
  if (!items.length) return `## ${title}\n\n- 暂无。\n`;
  const grouped = groupBy(items, (item) => item.ticker || item.company || item.provider || item.field || 'General');
  const blocks = Object.entries(grouped).map(([key, prompts]) => {
    const lines = prompts.slice(0, 40).map((item) => `- ${item.question || '请补充缺失字段'}  
  - field: \`${item.field || 'unknown'}\`  
  - expected answer format: ${item.expected_answer_format || 'ticker, field, value, date, original_url, confidence'}  
  - preferred source: ${item.preferred_source || 'company_ir/sec/earnings_call/reuters/bloomberg'}  
  - date range: ${item.date_range || '2024-01-01 至今'}  
  - confidence level: ${item.confidence_level || 'needs_source'}`);
    return `### ${key}\n\n${lines.join('\n')}`;
  });
  return `## ${title}\n\n${blocks.join('\n\n')}\n`;
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
