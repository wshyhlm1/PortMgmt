import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PATHS, ensureDir, readJson, writeJson } from '../shared.mjs';
import {
  MODEL_REPORT_DATE,
  MODEL_TIMELINE_CANDIDATES,
  MODEL_TIMELINE_REJECTED,
  MODEL_TIMELINE_SEEDS,
} from './model-official-seeds.mjs';

const RANGE_START = shiftYear(MODEL_REPORT_DATE, -1);
const RANGE_END = MODEL_REPORT_DATE;

async function main() {
  const verifiedModels = await readJson(path.join(PATHS.data, 'enrichment', 'verified', 'models.json'), { rows: [] });
  const pricingByModel = new Map((verifiedModels.rows || [])
    .filter((row) => row.api_pricing?.input_per_1m !== null && row.api_pricing?.input_per_1m !== undefined && row.api_pricing?.output_per_1m !== null && row.api_pricing?.output_per_1m !== undefined)
    .map((row) => [timelineModelKey(row.provider, row.model), row.api_pricing]));
  const rows = MODEL_TIMELINE_SEEDS
    .filter((row) => ['high', 'medium'].includes(row.confidence))
    .filter((row) => inRange(row.date || dateFromLabel(row.date_label)))
    .map((row) => enrichTimelinePricing(row, pricingByModel))
    .sort((a, b) => sortDate(b).localeCompare(sortDate(a)))
    .slice(0, 12);

  const verifiedPath = path.join(PATHS.data, 'enrichment', 'verified', 'model_release_timeline.json');
  const candidatePath = path.join(PATHS.data, 'enrichment', 'candidates', 'model_release_timeline_candidates.json');
  const rejectedPath = path.join(PATHS.data, 'enrichment', 'rejected', 'model_release_timeline_rejected.json');
  await writeJson(verifiedPath, {
    generated_at: new Date().toISOString(),
    report_date: MODEL_REPORT_DATE,
    range: { start: RANGE_START, end: RANGE_END },
    rows,
  });
  await writeJson(candidatePath, {
    generated_at: new Date().toISOString(),
    report_date: MODEL_REPORT_DATE,
    rows: MODEL_TIMELINE_CANDIDATES,
  });
  await writeJson(rejectedPath, {
    generated_at: new Date().toISOString(),
    report_date: MODEL_REPORT_DATE,
    rows: MODEL_TIMELINE_REJECTED,
  });
  await writeModelDocs(rows, MODEL_TIMELINE_CANDIDATES);
  console.log(`Built model release timeline with ${rows.length} rows.`);
}

function enrichTimelinePricing(row = {}, pricingByModel = new Map()) {
  const pricing = pricingByModel.get(timelineModelKey(row.provider, row.model));
  if (!pricing) return row;
  return {
    ...row,
    api_pricing: pricing,
    data_status: row.data_status === 'source_unparsed' ? 'verified' : row.data_status,
  };
}

function timelineModelKey(provider = '', model = '') {
  return `${String(provider || '').toLowerCase().replace(/alibaba.*|通义|qwen/g, 'alibaba').replace(/moonshot|kimi/g, 'moonshot').replace(/google|gemini/g, 'google')}|${String(model || '').toLowerCase().replace(/\s*\/.*$/, '').replace(/\s+/g, '-')}`;
}

function sortDate(row = {}) {
  return row.date || dateFromLabel(row.date_label) || '9999-12-31';
}

function dateFromLabel(label = '') {
  const text = String(label || '');
  const exact = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (exact) return exact[1];
  const month = text.match(/\b(20\d{2}-\d{2})\b/);
  if (month) return `${month[1]}-01`;
  return null;
}

function inRange(date = '') {
  if (!date) return false;
  return date >= RANGE_START && date <= RANGE_END;
}

function shiftYear(dateIso = '', delta = 0) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '2025-06-06';
  date.setUTCFullYear(date.getUTCFullYear() + delta);
  return date.toISOString().slice(0, 10);
}

async function writeModelDocs(rows, candidates) {
  const docsDir = path.join(PATHS.data, '..', 'docs');
  await ensureDir(docsDir);
  const counts = providerCounts(rows);
  const candidateCounts = providerCounts(candidates);
  const publicDoc = [
    '# 公开模型发布数据源',
    '',
    `生成日期：${MODEL_REPORT_DATE}`,
    '',
    '## 数据流',
    '',
    '模型数据遵循 raw -> candidate -> verified -> rejected -> render。官方页面抓取失败不会让 build 失败，会写入 data/enrichment/errors.json。',
    '',
    '## 官方源优先级',
    '',
    '- 厂商官方模型文档、pricing 文档、changelog、announcement。',
    '- 已解析官方价格写入 api_pricing；官方价格页存在但尚未解析时显示 `待解析官方价格`。',
    '- LLM/Qwen 只能生成 candidate 或 parsing hint，不能直接写 verified。',
    '',
    '## 时间线生成规则',
    '',
    `- 主轴时间范围固定为 ${RANGE_START} 至 ${RANGE_END}，只取 high / medium 置信度，最多 12 条，按日期倒序展示。`,
    '- 字段固定为：日期、厂商、模型、类型、核心变化、API定价、数据状态。',
    '- 类型使用枚举：旗舰模型、推理模型、速度模型、多模态模型、编码模型、开源/开放权重模型、价格调整、生命周期变更。',
    '- 数据状态使用枚举：verified、candidate、date_estimated、pricing_missing、source_unparsed；缺精确日时显示 `约 YYYY-MM`，不写 raw English。',
    '- 官方价格页存在但未解析时只显示 `待解析官方价格`，不显示 `见官方定价页`。',
    '',
    '## 模型表质量规则',
    '',
    '- HTML 模型表只展示 high / medium 且来源明确的 verified/candidate 行。',
    '- 每行至少具备 5 个有效字段，空 provider 分组不渲染。',
    '- 重复模型按 provider + model 合并，低质量发布时间、raw English 描述和后续待确认句子进入 rejected 或缺口文档。',
    '',
    '## Provider 覆盖',
    '',
    ...[...new Set([...Object.keys(counts), ...Object.keys(candidateCounts)])].sort().map((provider) => `- ${provider}：timeline verified ${counts[provider] || 0} 条；candidate ${candidateCounts[provider] || 0} 条。`),
    '',
    '## 时间线主轴',
    '',
    '| 日期 | 厂商 | 模型 | 类型 | API定价 | 数据状态 |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.date || row.date_label} | ${row.provider} | ${row.model} | ${row.release_type || row.type} | ${pricingDisplay(row.api_pricing)} | ${row.data_status} |`),
    '',
  ].join('\n');
  await fs.writeFile(path.join(docsDir, `public_model_release_data_${MODEL_REPORT_DATE}.md`), `${publicDoc}\n`, 'utf8');

  const gapDoc = [
    '# 模型发布数据缺口',
    '',
    `生成日期：${MODEL_REPORT_DATE}`,
    '',
    '## Verified / Candidate 数量',
    '',
    '| Provider | verified timeline | candidate |',
    '|---|---:|---:|',
    ...[...new Set([...Object.keys(counts), ...Object.keys(candidateCounts)])].sort().map((provider) => `| ${provider} | ${counts[provider] || 0} | ${candidateCounts[provider] || 0} |`),
    '',
    '## 字段缺口',
    '',
    '- xAI Grok 4.3：缺 official exact/month 发布时间。',
    '- Kimi K2.5/K2.6：已有官方价格与上下文，缺 official exact/month 发布时间。',
    '- DeepSeek V3/R1/V3.2：需要解析官方 docs/news 的发布时间；pricing table 可作为价格解析入口。',
    '- Qwen pricing：DashScope pricing 表需要脚本继续解析具体模型价格、缓存折扣和阶梯区间。',
    '- OpenAI GPT-5.5：官方 seed 已补价格，context window 仍需以模型文档解析结果补齐。',
    '',
    '## 本轮质量规则',
    '',
    `- 时间线范围：${RANGE_START} 至 ${RANGE_END}；最多 12 条；日期倒序；只收 high / medium。`,
    '- 模型表字段完整度必须达到 5 个有效字段；重复、raw English、坏日期和低置信行不会进入 HTML。',
    '- API 定价缺解析时统一显示 `待解析官方价格`；缺口在本文档保留，不把定价页链接当作价格。',
    '',
    '## 下一步',
    '',
    '- 用 provider fetch 脚本抓官方页面 raw text。',
    '- 让 LLM 只生成 parsing hint 或 candidate JSON。',
    '- 人工或脚本确认 source_url/source_title/date 后再进入 verified。',
    '',
  ].join('\n');
  await fs.writeFile(path.join(docsDir, 'model_release_data_gap.md'), `${gapDoc}\n`, 'utf8');
}

function providerCounts(rows = []) {
  const counts = {};
  for (const row of rows) counts[row.provider] = (counts[row.provider] || 0) + 1;
  return counts;
}

function pricingDisplay(pricing = {}) {
  if (!pricing.input_per_1m || !pricing.output_per_1m) return '待解析官方价格';
  const symbol = pricing.currency === 'CNY' ? '¥' : '$';
  const cached = pricing.cached_input_per_1m ? `；缓存 ${symbol}${pricing.cached_input_per_1m} / 1M tokens` : '';
  return `输入 ${symbol}${pricing.input_per_1m} / 1M tokens${cached}；输出 ${symbol}${pricing.output_per_1m} / 1M tokens；截至 ${pricing.as_of || MODEL_REPORT_DATE}`;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
