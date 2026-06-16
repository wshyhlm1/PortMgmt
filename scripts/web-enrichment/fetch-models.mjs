import path from 'node:path';
import { PATHS, readJson } from '../shared.mjs';
import {
  fetchPublicSource,
  reportDateFromConfig,
  writeCandidatePayload,
  writeRawPayload,
} from './common.mjs';
import { MODEL_OFFICIAL_SOURCES, MODEL_VERIFIED_SEEDS } from './model-official-seeds.mjs';

async function main() {
  const config = await readJson(PATHS.config, {});
  const reportDate = reportDateFromConfig(config);
  const raw = [];
  for (const source of MODEL_OFFICIAL_SOURCES) {
    raw.push(await fetchPublicSource({ ...source, type: 'models' }));
  }
  await writeRawPayload('models', `official_sources_${reportDate}`, {
    report_date: reportDate,
    sources: raw,
  });

  const modelData = await readJson(path.join(PATHS.data, 'ai_models.json'), { ai_models: [] });
  const seededRows = MODEL_VERIFIED_SEEDS.map((row) => ({
    ...row,
    candidate_source: 'public_research_seed',
  }));
  const rows = [
    ...(modelData.ai_models || [])
    .map((model) => modelCandidate(model, reportDate))
    .filter(Boolean),
    ...seededRows,
  ];
  await writeCandidatePayload('models', `models_${reportDate}`, rows, {
    source_note: 'Candidates are seeded from existing structured model rows and backed only when an official source URL/title exists.',
  });
  console.log(`Model enrichment fetched ${raw.length} official pages and wrote ${rows.length} candidates.`);
}

function modelCandidate(model, reportDate) {
  const sourceUrl = model.source_url || model.original_url || null;
  const confidence = String(model.confidence || model.confidence_level || '').toLowerCase() || (sourceUrl ? 'medium' : 'low');
  return {
    provider: model.provider,
    model: model.model_name || model.model,
    release_date: normalizeReleaseDate(model.release_date),
    date_confidence: dateConfidence(model.release_date),
    context_window: model.context_window || null,
    modalities: modalitiesFrom(model),
    key_capabilities: model.key_capabilities || model.capabilities || null,
    api_pricing: {
      input_per_1m: pricingText(model.api_pricing, 'input') || null,
      output_per_1m: pricingText(model.api_pricing, 'output') || null,
      currency: /CNY|RMB|人民币|¥/.test(String(model.api_pricing || '')) ? 'CNY' : 'USD',
      pricing_url: pricingUrlForProvider(model.provider, sourceUrl),
      as_of: reportDate,
    },
    next_model_info: model.next_generation || model.next_model_info || null,
    source_title: model.source_title || model.source_type || `${model.provider || 'model'} public source`,
    source_url: sourceUrl,
    confidence,
  };
}

function normalizeReleaseDate(value = '') {
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

function modalitiesFrom(model = {}) {
  const text = `${model.multimodal || ''} ${model.key_capabilities || ''}`.toLowerCase();
  const out = ['text'];
  if (/image|vision|图像|视觉/.test(text)) out.push('image');
  if (/audio|speech|语音/.test(text)) out.push('audio');
  if (/video|视频/.test(text)) out.push('video');
  return [...new Set(out)];
}

function pricingText(value = '', side) {
  const text = String(value || '');
  if (!text) return null;
  const pattern = side === 'input' ? /(input|输入)[^;；,，]{0,40}/i : /(output|输出)[^;；,，]{0,40}/i;
  const match = text.match(pattern);
  return match ? match[0] : text.length <= 80 ? text : null;
}

function pricingUrlForProvider(provider = '', fallback = '') {
  if (/OpenAI/i.test(provider)) return 'https://platform.openai.com/docs/pricing';
  if (/Anthropic/i.test(provider)) return 'https://docs.anthropic.com/en/docs/about-claude/pricing';
  if (/Google|Gemini/i.test(provider)) return 'https://ai.google.dev/gemini-api/docs/pricing';
  if (/xAI/i.test(provider)) return 'https://docs.x.ai/docs/pricing';
  if (/Alibaba|Qwen|通义/i.test(provider)) return 'https://help.aliyun.com/zh/model-studio/billing-for-model-studio';
  if (/DeepSeek/i.test(provider)) return 'https://api-docs.deepseek.com/quick_start/pricing';
  if (/Moonshot|Kimi/i.test(provider)) return 'https://platform.moonshot.ai/docs/pricing/chat';
  return fallback || null;
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 0;
});
