import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { PATHS, ensureDir, readJson, writeJson } from '../shared.mjs';
import { MODEL_VERIFIED_SEEDS } from './model-official-seeds.mjs';

const __filename = fileURLToPath(import.meta.url);

export async function normalizeModels() {
  const verifiedPath = path.join(PATHS.data, 'enrichment', 'verified', 'models.json');
  const rejectedPath = path.join(PATHS.data, 'enrichment', 'rejected', 'models.json');
  await ensureDir(path.dirname(verifiedPath));
  const current = await readJson(verifiedPath, { rows: [] });
  const rejected = await readJson(rejectedPath, { rows: [] });
  const officialPricing = await loadOfficialPricingAdapters();
  const merged = new Map();
  for (const row of current.rows || []) addModel(merged, normalizeModel(row, officialPricing));
  for (const row of MODEL_VERIFIED_SEEDS) addModel(merged, normalizeModel(row, officialPricing));

  const rows = [...merged.values()]
    .filter((row) => row.status !== 'candidate_only')
    .sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || String(b.release_date || '').localeCompare(String(a.release_date || '')) || a.model.localeCompare(b.model));
  const candidateOnly = MODEL_VERIFIED_SEEDS
    .filter((row) => row.status === 'candidate_only')
    .map((row) => ({
      ...normalizeModel(row, officialPricing),
      reason: row.release_date ? 'candidate_only' : 'missing_official_release_date',
      next_action: '补充 official exact/month 发布时间后再进入 verified renderable model。',
    }));

  await writeJson(verifiedPath, {
    generated_at: new Date().toISOString(),
    type: 'models',
    rows,
  });
  await writeJson(rejectedPath, {
    generated_at: new Date().toISOString(),
    type: 'models',
    rows: dedupeRejected([...(rejected.rows || []), ...candidateOnly]),
  });
  console.log(`Normalized ${rows.length} verified model rows; candidate-only rows ${candidateOnly.length}.`);
  return { verified: rows.length, candidateOnly: candidateOnly.length };
}

function normalizeModel(row = {}, officialPricing = new Map()) {
  const provider = providerLabel(row.provider || '');
  const model = row.model || row.model_name;
  const pricing = normalizePricing(row.api_pricing, provider, officialPricing.get(pricingKey(provider, model)));
  return {
    provider,
    model,
    release_date: normalizeDate(row.release_date),
    date_confidence: row.date_confidence || dateConfidence(row.release_date),
    context_window: row.context_window || null,
    modalities: normalizeModalities(row.modalities || row.multimodal || row.key_capabilities),
    key_capabilities: row.key_capabilities || null,
    api_pricing: pricing,
    status: row.status || 'active',
    next_model_info: cleanModelNextText(row.next_model_info || row.next_generation || ''),
    source_title: row.source_title || row.source_type || `${provider} official source`,
    source_url: row.source_url || row.original_url || row.source || pricing.pricing_url || null,
    confidence: normalizeConfidence(row.confidence || row.confidence_level),
  };
}

function cleanModelNextText(value = '') {
  const text = String(value || '').trim();
  if (!text || /Debuted|preview shown|shown July|后续信息待官方确认|待官方确认|third.party|Date approximate/i.test(text)) return null;
  return text;
}

function normalizePricing(value = null, provider = '', adapter = null) {
  if (!value || typeof value === 'string') {
    return adapter || {
      input_per_1m: null,
      cached_input_per_1m: null,
      output_per_1m: null,
      currency: /Moonshot|Kimi|Alibaba|Qwen|通义/i.test(provider) ? 'CNY' : 'USD',
      pricing_url: pricingUrl(provider),
      pricing_status: value ? 'official_text_unparsed' : 'official_page_found_unparsed',
      as_of: '2026-06-06',
    };
  }
  const normalized = {
    input_per_1m: value.input_per_1m ?? null,
    cached_input_per_1m: value.cached_input_per_1m ?? value.cache_hit_per_1m ?? value.cached_per_1m ?? null,
    output_per_1m: value.output_per_1m ?? null,
    currency: value.currency || (/Moonshot|Kimi|Alibaba|Qwen|通义/i.test(provider) ? 'CNY' : 'USD'),
    pricing_url: value.pricing_url || pricingUrl(provider),
    pricing_status: value.pricing_status || (value.input_per_1m && value.output_per_1m ? 'official_pricing_value' : 'official_page_found_unparsed'),
    as_of: value.as_of || '2026-06-06',
  };
  if (adapter && (!normalized.input_per_1m || !normalized.output_per_1m || normalized.pricing_status === 'official_page_found_unparsed' || normalized.pricing_status === 'official_text_unparsed')) {
    return {
      ...normalized,
      ...adapter,
      cached_input_per_1m: adapter.cached_input_per_1m ?? normalized.cached_input_per_1m,
      pricing_note: adapter.pricing_note || normalized.pricing_note || null,
    };
  }
  return normalized;
}

async function loadOfficialPricingAdapters() {
  const rawDir = path.join(PATHS.data, 'enrichment', 'raw', 'models');
  let files = [];
  try {
    files = (await fs.readdir(rawDir)).filter((file) => /^official_sources_.*\.json$/.test(file)).sort();
  } catch {
    return new Map();
  }
  const latest = files.at(-1);
  if (!latest) return new Map();
  const payload = await readJson(path.join(rawDir, latest), { sources: [] });
  const adapters = new Map();
  for (const source of payload.sources || []) {
    const text = source.text_full || source.text || source.text_excerpt || '';
    if (!text) continue;
    const asOf = String(source.fetched_at || payload.report_date || '2026-06-06').slice(0, 10);
    if (/Alibaba|Qwen|通义/i.test(`${source.provider || ''} ${source.source_title || ''}`)) {
      for (const entry of parseQwenPricing(text, source.source_url, asOf)) addPricingAdapter(adapters, 'Alibaba/通义千问', entry);
    }
    if (/Moonshot|Kimi/i.test(`${source.provider || ''} ${source.source_title || ''}`)) {
      for (const entry of parseKimiPricing(text, source.source_url, asOf)) addPricingAdapter(adapters, 'Moonshot', entry);
    }
  }
  return adapters;
}

function addPricingAdapter(map, provider, entry) {
  for (const alias of entry.aliases || [entry.model]) {
    map.set(pricingKey(provider, alias), {
      input_per_1m: entry.input_per_1m,
      cached_input_per_1m: entry.cached_input_per_1m ?? null,
      output_per_1m: entry.output_per_1m,
      currency: entry.currency || 'CNY',
      pricing_url: entry.pricing_url,
      pricing_status: 'official_pricing_value',
      as_of: entry.as_of || '2026-06-06',
      pricing_note: entry.pricing_note || null,
    });
  }
}

function parseQwenPricing(text = '', pricingUrl = '', asOf = '2026-06-06') {
  const ids = ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus', 'qwen3-max', 'qwen-plus', 'qwen-max'];
  const rows = [];
  for (const id of ids) {
    const rowText = qwenRowText(text, id);
    if (!rowText) continue;
    const prices = rowText.match(/(?:无阶梯计价|0\s*<\s*Token\s*≤\s*[0-9KM]+)\s+(\d+(?:\.\d+)?)\s*元\s+(\d+(?:\.\d+)?)\s*元(?:\s+(\d+(?:\.\d+)?)\s*元)?/i);
    if (!prices) continue;
    const input = Number(prices[1]);
    const output = Number(prices[3] || prices[2]);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    rows.push({
      model: id,
      aliases: [id, id.replace(/^qwen/, 'Qwen'), id.replace(/-/g, ' ')],
      input_per_1m: input,
      cached_input_per_1m: null,
      output_per_1m: output,
      currency: 'CNY',
      pricing_url: pricingUrl || pricingUrlForQwen(),
      as_of: asOf,
      pricing_note: /上下文缓存\s*享有折扣/i.test(rowText) ? 'context_cache_discount_available_no_exact_hit_price' : null,
    });
  }
  return rows;
}

function qwenRowText(text = '', id = '') {
  const lower = text.toLowerCase();
  const start = lower.indexOf(id.toLowerCase());
  if (start === -1) return '';
  return text.slice(start, start + 520);
}

function pricingUrlForQwen() {
  return 'https://help.aliyun.com/zh/model-studio/model-pricing';
}

function parseKimiPricing(text = '', pricingUrl = '', asOf = '2026-06-06') {
  const rows = [];
  const modelPattern = /(K2\.6|kimi-k2\.6|K2\.5|kimi-k2\.5|Moonshot V1)/gi;
  for (const match of text.matchAll(modelPattern)) {
    const model = match[1];
    const snippet = text.slice(match.index, match.index + 420);
    const full = snippet.match(/缓存命中\s*¥\s*(\d+(?:\.\d+)?)\s*\/\s*MTok\s*输入\s*¥\s*(\d+(?:\.\d+)?)\s*\/\s*MTok\s*输出\s*¥\s*(\d+(?:\.\d+)?)\s*\/\s*MTok/i);
    const simple = snippet.match(/输入\s*¥\s*(\d+(?:\.\d+)?)\s*\/\s*MTok\s*输出\s*¥\s*(\d+(?:\.\d+)?)\s*\/\s*MTok/i);
    const normalized = kimiModelId(model);
    if (full) {
      rows.push({
        model: normalized,
        aliases: kimiAliases(normalized),
        input_per_1m: Number(full[2]),
        cached_input_per_1m: Number(full[1]),
        output_per_1m: Number(full[3]),
        currency: 'CNY',
        pricing_url: pricingUrl || 'https://www.kimi.com/help/kimi-api/api-pricing',
        as_of: asOf,
      });
    } else if (simple) {
      rows.push({
        model: normalized,
        aliases: kimiAliases(normalized),
        input_per_1m: Number(simple[1]),
        cached_input_per_1m: null,
        output_per_1m: Number(simple[2]),
        currency: 'CNY',
        pricing_url: pricingUrl || 'https://www.kimi.com/help/kimi-api/api-pricing',
        as_of: asOf,
      });
    }
  }
  return rows.filter((row, index, arr) => arr.findIndex((item) => item.model === row.model) === index);
}

function kimiModelId(value = '') {
  if (/2\.6/i.test(value)) return 'kimi-k2.6';
  if (/2\.5/i.test(value)) return 'kimi-k2.5';
  if (/moonshot\s*v1/i.test(value)) return 'moonshot-v1';
  return String(value || '').toLowerCase().replace(/\s+/g, '-');
}

function kimiAliases(model = '') {
  if (model === 'kimi-k2.6') return ['kimi-k2.6', 'Kimi K2.6', 'K2.6'];
  if (model === 'kimi-k2.5') return ['kimi-k2.5', 'Kimi K2.5', 'K2.5'];
  if (model === 'moonshot-v1') return ['moonshot-v1', 'Moonshot V1'];
  return [model];
}

function pricingKey(provider = '', model = '') {
  return `${providerLabel(provider)}|${normalizePricingModelName(model)}`;
}

function normalizePricingModelName(model = '') {
  return String(model || '')
    .toLowerCase()
    .replace(/\s*\/.*$/, '')
    .replace(/^qwen\s*/, 'qwen')
    .replace(/^kimi\s*/, 'kimi-')
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/--+/g, '-')
    .replace(/^kimi-kimi-/, 'kimi-')
    .trim();
}

function pricingUrl(provider = '') {
  if (/OpenAI/i.test(provider)) return 'https://openai.com/api/pricing/';
  if (/Anthropic/i.test(provider)) return 'https://platform.claude.com/docs/en/about-claude/pricing';
  if (/Google|Gemini/i.test(provider)) return 'https://ai.google.dev/gemini-api/docs/pricing';
  if (/xAI/i.test(provider)) return 'https://docs.x.ai/developers/models/grok-4.3';
  if (/Alibaba|Qwen|通义/i.test(provider)) return 'https://help.aliyun.com/zh/model-studio/model-pricing';
  if (/DeepSeek/i.test(provider)) return 'https://api-docs.deepseek.com/quick_start/pricing-details-usd/';
  if (/Moonshot|Kimi/i.test(provider)) return 'https://www.kimi.com/help/kimi-api/api-pricing';
  return null;
}

function normalizeDate(value = '') {
  const text = String(value || '');
  const exact = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (exact) return exact[1];
  const month = text.match(/\b(20\d{2}-\d{2})\b/);
  if (month) return month[1];
  const year = text.match(/\b(20\d{2})\b/);
  return year ? year[1] : null;
}

function dateConfidence(value = '') {
  if (/\b20\d{2}-\d{2}-\d{2}\b/.test(String(value || ''))) return 'exact';
  if (/\b20\d{2}-\d{2}\b/.test(String(value || ''))) return 'month';
  return 'estimated';
}

function normalizeModalities(value = []) {
  const text = Array.isArray(value) ? value.join(' ') : String(value || '');
  const out = [];
  if (/text|文本|language|语言/i.test(text) || !text) out.push('text');
  if (/image|vision|图像|视觉|multimodal|多模态/i.test(text)) out.push('image');
  if (/audio|speech|语音|音频/i.test(text)) out.push('audio');
  if (/video|视频/i.test(text)) out.push('video');
  return [...new Set(out)];
}

function normalizeConfidence(value = '') {
  const text = String(value || '').toLowerCase();
  if (text === 'high' || text === 'medium') return text;
  return 'medium';
}

function providerLabel(provider = '') {
  if (/Alibaba|Qwen|通义/i.test(provider)) return 'Alibaba/通义千问';
  if (/Google|Gemini/i.test(provider)) return 'Google';
  if (/Moonshot|Kimi/i.test(provider)) return 'Moonshot';
  return provider;
}

function providerRank(provider = '') {
  const order = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'Alibaba/通义千问', 'DeepSeek', 'Moonshot'];
  const index = order.findIndex((item) => item === provider);
  return index === -1 ? order.length : index;
}

function addModel(map, row) {
  if (!row.provider || !row.model) return;
  const key = `${row.provider}|${row.model}`;
  const existing = map.get(key);
  map.set(key, existing ? richerModel(existing, row) : row);
}

function richerModel(left, right) {
  const score = (row) => [
    row.release_date,
    row.context_window,
    row.modalities?.length,
    row.key_capabilities,
    row.api_pricing?.input_per_1m,
    row.api_pricing?.pricing_url,
    row.status,
    row.next_model_info,
  ].filter(Boolean).length;
  return score(right) >= score(left) ? { ...left, ...right } : { ...right, ...left };
}

function dedupeRejected(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.provider || row.row?.provider || ''}|${row.model || row.row?.model || ''}|${row.reason || ''}`;
    map.set(key, row);
  }
  return [...map.values()];
}

if (process.argv[1] === __filename) {
  normalizeModels().catch((error) => {
    console.error(error.message);
    process.exitCode = 0;
  });
}
