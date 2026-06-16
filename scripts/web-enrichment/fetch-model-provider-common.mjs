import { PATHS, readJson } from '../shared.mjs';
import { fetchPublicSource, reportDateFromConfig, writeCandidatePayload, writeRawPayload } from './common.mjs';
import { MODEL_OFFICIAL_SOURCES, MODEL_VERIFIED_SEEDS } from './model-official-seeds.mjs';

const PROVIDER_ALIASES = {
  openai: /OpenAI/i,
  anthropic: /Anthropic|Claude/i,
  gemini: /Google|Gemini/i,
  xai: /xAI|Grok/i,
  qwen: /Alibaba|Qwen|通义/i,
  deepseek: /DeepSeek/i,
  kimi: /Moonshot|Kimi/i,
};

export async function fetchProviderModels(providerKey) {
  const config = await readJson(PATHS.config, {});
  const reportDate = reportDateFromConfig(config);
  const pattern = PROVIDER_ALIASES[providerKey];
  if (!pattern) throw new Error(`Unknown model provider key: ${providerKey}`);
  const sources = MODEL_OFFICIAL_SOURCES.filter((source) => pattern.test(source.provider) || pattern.test(source.title));
  const raw = [];
  for (const source of sources) raw.push(await fetchPublicSource({ ...source, type: 'models' }));
  const rows = MODEL_VERIFIED_SEEDS
    .filter((seed) => pattern.test(seed.provider) || pattern.test(seed.model))
    .map((seed) => ({ ...seed, candidate_source: 'public_research_seed' }));
  await writeRawPayload('models', `${providerKey}_official_sources_${reportDate}`, {
    report_date: reportDate,
    provider: providerKey,
    sources: raw,
  });
  await writeCandidatePayload('models', `${providerKey}_models_${reportDate}`, rows, {
    provider: providerKey,
    source_note: 'Official public source seeds; rows still pass normalize-models and validate-models before rendering.',
  });
  console.log(`Fetched ${raw.length} ${providerKey} model sources and wrote ${rows.length} candidates.`);
}
