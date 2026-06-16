import path from 'node:path';
import { PATHS, containsMarkdownTable, pathExists, readJson } from './shared.mjs';

async function main() {
  const required = [
    'companies.json',
    'events.json',
    'reminders.json',
    'ai_capex.json',
    'ai_models.json',
  ];
  const errors = [];
  for (const file of required) {
    const full = path.join(PATHS.data, file);
    if (!(await pathExists(full))) errors.push(`Missing data/${file}`);
  }
  if (errors.length) fail(errors);

  const companies = await readJson(path.join(PATHS.data, 'companies.json'), {});
  const events = await readJson(path.join(PATHS.data, 'events.json'), {});
  const reminders = await readJson(path.join(PATHS.data, 'reminders.json'), {});
  const aiCapex = await readJson(path.join(PATHS.data, 'ai_capex.json'), {});
  const aiModels = await readJson(path.join(PATHS.data, 'ai_models.json'), {});

  if (!Array.isArray(companies.companies)) errors.push('data/companies.json must contain companies[]');
  if (!Array.isArray(events.events)) errors.push('data/events.json must contain events[]');
  if (!Array.isArray(reminders.reminders)) errors.push('data/reminders.json must contain reminders[]');
  if (!Array.isArray(aiCapex.ai_capex)) errors.push('data/ai_capex.json must contain ai_capex[]');
  if (!Array.isArray(aiModels.ai_models)) errors.push('data/ai_models.json must contain ai_models[]');

  for (const event of events.events || []) {
    if (!['L1', 'L2', 'L3', 'draft'].includes(event.level)) errors.push(`Invalid event level for ${event.id}`);
    if (event.level === 'L1' && (!event.source_url || (!event.obsidian_path && !event.bosidian_path))) {
      errors.push(`L1 event missing source_url or Obsidian/Bosidian path: ${event.id}`);
    }
    if (!event.source_url && !event.source_file && !['L3', 'draft'].includes(event.level)) {
      errors.push(`Event without source must be L3 or draft: ${event.id}`);
    }
  }

  for (const company of companies.companies || []) {
    if (!Array.isArray(company.financials?.annual)) errors.push(`Company financials.annual must be structured array: ${company.ticker}`);
    if (!Array.isArray(company.guidance)) errors.push(`Company guidance must be structured array: ${company.ticker}`);
    if (!Array.isArray(company.capex_capacity)) errors.push(`Company capex_capacity must be structured array: ${company.ticker}`);
  }

  const providerWhitelist = new Set(['OpenAI', 'Anthropic', 'Google', 'xAI', 'Meta', 'DeepSeek', 'Alibaba/通义千问', 'Tencent', 'Baidu', 'Mistral', 'Microsoft', 'Amazon', 'Moonshot', 'IBM']);
  for (const model of aiModels.ai_models || []) {
    if (model.provider && !providerWhitelist.has(model.provider) && !model.provider_override) {
      errors.push(`Invalid AI model provider: ${model.provider}`);
    }
  }

  checkRawLeak(companies, errors, 'data/companies.json');
  checkRawLeak(events, errors, 'data/events.json');
  checkRawLeak(aiCapex, errors, 'data/ai_capex.json');
  checkRawLeak(aiModels, errors, 'data/ai_models.json');

  const indexPath = path.join(PATHS.reports, 'index.html');
  if (!(await pathExists(indexPath))) errors.push('Missing portfolio_reports/index.html');

  if (errors.length) fail(errors);
  console.log(`Validation passed: ${companies.companies.length} companies, ${events.events.length} events.`);
}

function checkRawLeak(value, errors, location) {
  visit(value, [], (pathParts, current) => {
    const key = pathParts.at(-1) || '';
    if (/^raw(_|$)/i.test(key)) errors.push(`${location} contains raw field: ${pathParts.join('.')}`);
    if (typeof current === 'string' && containsMarkdownTable(current)) {
      errors.push(`${location} contains raw Markdown table string at ${pathParts.join('.')}`);
    }
  });
}

function visit(value, pathParts, callback) {
  callback(pathParts, value);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, [...pathParts, String(index)], callback));
    return;
  }
  for (const [key, child] of Object.entries(value)) visit(child, [...pathParts, key], callback);
}

function fail(errors) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
