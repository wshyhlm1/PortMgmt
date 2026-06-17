import path from 'node:path';
import { PATHS, readJson } from '../shared.mjs';

async function main() {
  const verified = await readJson(path.join(PATHS.data, 'enrichment', 'verified', 'models.json'), { rows: [] });
  const timeline = await readJson(path.join(PATHS.data, 'enrichment', 'verified', 'model_release_timeline.json'), { rows: [] });
  const errors = [];
  validateVerifiedModels(verified.rows || [], errors);
  validateTimeline(timeline.rows || [], errors, timeline.range || {});
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Model validation ok: verified ${verified.rows?.length || 0}, timeline ${timeline.rows?.length || 0}.`);
}

function validateVerifiedModels(rows, errors) {
  const seen = new Set();
  for (const row of rows) {
    const label = `${row.provider || ''} ${row.model || ''}`.trim();
    for (const field of ['provider', 'model', 'source_url', 'source_title', 'confidence']) {
      if (!row[field]) errors.push(`Model missing ${field}: ${label}`);
    }
    if (!['high', 'medium'].includes(row.confidence)) errors.push(`Model confidence not renderable: ${label}`);
    const filled = ['release_date', 'date_label', 'context_window', 'modalities', 'key_capabilities', 'api_pricing', 'status', 'next_model_info', 'source_url']
      .filter((field) => isFilled(row[field])).length;
    if (filled < 5) errors.push(`Model has fewer than 5 useful fields: ${label}`);
    if (/见官方定价页/.test(JSON.stringify(row.api_pricing || {}))) errors.push(`Model pricing uses forbidden phrase: ${label}`);
    if (/Alibaba|Qwen|通义/i.test(label) && /Qwen3\.7-(Plus|Max)/i.test(row.model || '')) {
      if (!hasParsedInputOutput(row.api_pricing)) errors.push(`Qwen pricing adapter failed to parse input/output per 1M: ${label}`);
      if (!row.api_pricing?.cached_input_per_1m && !/cache|缓存/i.test(String(row.api_pricing?.pricing_note || ''))) {
        errors.push(`Qwen pricing adapter missing cache note or value: ${label}`);
      }
    }
    if (/Moonshot|Kimi/i.test(label) && /K2\.[56]/i.test(row.model || '')) {
      if (!hasParsedInputOutput(row.api_pricing) || !row.api_pricing?.cached_input_per_1m) {
        errors.push(`Kimi pricing adapter failed to parse input/cache/output per 1M: ${label}`);
      }
    }
    if (/2025-2026|2026年持续/.test(String(row.release_date || ''))) errors.push(`Model release_date invalid: ${label} ${row.release_date}`);
    const key = `${row.provider}|${row.model}`;
    if (seen.has(key)) errors.push(`Duplicate provider/model: ${key}`);
    seen.add(key);
  }
}

function validateTimeline(rows, errors, range = {}) {
  const renderable = rows.filter((row) => ['high', 'medium'].includes(row.confidence));
  const rangeStart = range.start || '2025-06-06';
  const rangeEnd = range.end || '2026-06-06';
  if (renderable.length < 5) errors.push(`Timeline has fewer than 5 high/medium rows: ${renderable.length}`);
  if (rows.length > 12) errors.push(`Timeline exceeds 12 rows: ${rows.length}`);
  const seen = new Set();
  const allowedTypes = new Set(['旗舰模型', '推理模型', '速度模型', '多模态模型', '编码模型', '开源/开放权重模型', '价格调整', '生命周期变更']);
  const allowedStatuses = new Set(['verified', 'candidate', 'date_estimated', 'pricing_missing', 'source_unparsed']);
  for (const row of rows) {
    const label = `${row.provider || ''} ${row.model || ''}`.trim();
    for (const field of ['provider', 'model', 'summary', 'confidence']) {
      if (!row[field]) errors.push(`Timeline row missing ${field}: ${label}`);
    }
    if (!row.release_type && !row.type) errors.push(`Timeline row missing release_type: ${label}`);
    if ((row.release_type || row.type) && !allowedTypes.has(row.release_type || row.type)) errors.push(`Timeline invalid release_type: ${label} ${row.release_type || row.type}`);
    if (!row.date && !row.date_label) errors.push(`Timeline row missing date/date_label: ${label}`);
    if (row.date && (row.date < rangeStart || row.date > rangeEnd)) errors.push(`Timeline date outside range: ${label} ${row.date}`);
    if (!row.api_pricing) errors.push(`Timeline missing api_pricing: ${label}`);
    if (/见官方定价页/.test(JSON.stringify(row.api_pricing || {}))) errors.push(`Timeline pricing uses forbidden phrase: ${label}`);
    if (!row.api_pricing?.input_per_1m && !['official_page_found_unparsed', 'official_text_unparsed'].includes(row.api_pricing?.pricing_status)) {
      errors.push(`Timeline pricing missing parsed values without unparsed status: ${label}`);
    }
    if (row.data_status && !allowedStatuses.has(row.data_status)) errors.push(`Timeline invalid data_status: ${label} ${row.data_status}`);
    if (/2025-2026|2026年持续|预计2026年6月|前后/.test(`${row.date || ''} ${row.date_label || ''}`)) errors.push(`Timeline invalid date wording: ${label}`);
    const key = `${row.provider}|${row.model}`;
    if (seen.has(key)) errors.push(`Duplicate timeline row: ${key}`);
    seen.add(key);
  }
}

function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some((item) => item !== null && item !== undefined && item !== '');
  return String(value).trim() !== '';
}

function hasParsedInputOutput(pricing = {}) {
  return pricing?.input_per_1m !== null && pricing?.input_per_1m !== undefined && pricing?.output_per_1m !== null && pricing?.output_per_1m !== undefined;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
