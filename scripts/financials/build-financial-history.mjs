import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PATHS, ensureDir, readJson } from '../shared.mjs';
import { METRICS, normalizeFinancialHistory } from './normalize-financials.mjs';

async function main() {
  const payload = await normalizeFinancialHistory();
  await writeFinancialDocs(payload);
}

async function writeFinancialDocs(payload) {
  const docsDir = path.join(PATHS.data, '..', 'docs');
  await ensureDir(docsDir);
  const sourceRegistry = await readJson(path.join(PATHS.data, 'source_registry', 'company_financial_sources.json'), { companies: [] });
  const coverage = payload.coverage || [];
  const publicDoc = [
    '# 公开财务历史数据源',
    '',
    '生成日期：2026-06-06',
    '',
    '## 数据流',
    '',
    '财务历史遵循 raw -> candidate -> verified -> rejected -> render。HTML 只读取 data/financials/financial_history_verified.json 的 display 字段。',
    '',
    '## 公开源优先级',
    '',
    '- SEC companyfacts / submissions：美国公司、ADR、20-F/10-K/10-Q 的首选入口。',
    '- 公司 IR 年报、季度报、earnings release：用于非 SEC filer、segment 与管理层口径。',
    '- 台湾 MOPS 与韩国 DART：用于 TSMC、Samsung、SK Telecom 等本地披露。',
    '- LLM/Qwen 只允许把 PDF/HTML raw text 转为 candidate，不允许直接写 verified 财务数字。',
    '',
    '## Profile Candidate 与 Coverage',
    '',
    '- `initial/*_profile.md` 中 period、metric、unit、source_file 清楚的财务表先进入 `data/financials/candidates/from_profiles.json`。',
    '- 只有 display、来源、期间、单位都合格的 profile 行才合并到 `data/financials/financial_history_verified.json`，并标记 `source_form=profile_candidate`。',
    '- `data/financials/financial_coverage_summary.json` 按标的输出年度覆盖、季度覆盖、核心字段 verified 百分比、缺失字段和 source_mix。',
    '- HTML 财务表上方展示 `财务覆盖：年度 X/3，季度 Y/2，核心字段 Z% verified`；低于 50% 会追加覆盖不足提示。',
    '- 非美/ADR 标的缺口必须明确写出 MOPS、DART、IR PDF、20-F 等 adapter，不用空白或泛化缺失替代。',
    '',
    '## 展示质量规则',
    '',
    '- 业务拆分的收入/占比必须带币种、单位和百分比，例如 `150.1亿美元 / 约68%`，不允许裸数字。',
    '- 估值缺口文本以 `financial_history_verified.display` 和 verified 估值字段为准；Forward PE、EV/EBITDA、FCF Yield 已验证时不能再提示缺失。',
    '- 页面中的 `-` 统一展示为 `—`，财务与估值上下文不展示裸 financial value。',
    '',
    '## Source Registry',
    '',
    '| Ticker | 公司 | 首选币种 | Adapter | 下一步 |',
    '|---|---|---|---|---|',
    ...(sourceRegistry.companies || []).map((item) => `| ${item.ticker} | ${item.company} | ${item.preferred_currency} | ${item.adapter} | ${item.next_action} |`),
    '',
  ].join('\n');
  await fs.writeFile(path.join(docsDir, 'public_financial_history_sources_2026-06-06.md'), `${publicDoc}\n`, 'utf8');

  const gapDoc = [
    '# 财务历史数据缺口',
    '',
    '生成日期：2026-06-06',
    '',
    '| Ticker | 已验证年度数量 | 已验证季度数量 | 缺失指标 | 缺失原因 | 下一步 |',
    '|---|---:|---:|---|---|---|',
    ...coverage.map((item) => `| ${item.ticker} | ${item.annual_count} | ${item.quarter_count} | ${metricLabels(item.missing_metrics).join('、') || '—'} | ${(item.source_issues || []).join('；') || '—'} | ${item.next_action || '继续补充 official source'} |`),
    '',
    '## 说明',
    '',
    '- SEC companyfacts 中不存在的 concept 会保留为缺口，不用 profile 或 LLM 猜测。',
    '- IR PDF、MOPS、DART 尚未解析的公司显示 `—`，并在本缺口文档中列出 adapter。',
    '- 单位、币种或来源不明确的字段进入 rejected，不进入 HTML。',
    '- Profile 表格只作为 candidate 入口；通过期间、指标、单位和来源校验后才进入 verified。',
    '- Coverage summary 写入 `data/financials/financial_coverage_summary.json`，供 HTML 财务覆盖提示和 validate 使用。',
    '- 非美公司继续按 adapter 明确补齐路径：TSM/ASX -> MOPS/20-F，Samsung/SKM -> DART/20-F，IFX/NOK/ASML -> IR PDF/20-F。',
    '',
  ].join('\n');
  await fs.writeFile(path.join(docsDir, 'financial_history_data_gap.md'), `${gapDoc}\n`, 'utf8');
}

function metricLabels(keys = []) {
  const byKey = new Map(METRICS.map((item) => [item.key, item.label]));
  return keys.map((key) => byKey.get(key) || key);
}

main().catch(async (error) => {
  const errorsPath = path.join(PATHS.data, 'financials', 'errors.json');
  await ensureDir(path.dirname(errorsPath));
  await fs.writeFile(errorsPath, `${JSON.stringify({ generated_at: new Date().toISOString(), errors: [{ message: error.message }] }, null, 2)}\n`, 'utf8');
  console.error(error.message);
  process.exitCode = 0;
});
