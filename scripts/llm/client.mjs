import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PATHS, ROOT, ensureDir, readJson, writeJson, todayInZone } from '../shared.mjs';
import { qwenJson } from './qwen.mjs';

export async function loadEnv() {
  for (const file of [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')]) {
    try {
      const text = await fs.readFile(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]] !== undefined) continue;
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return process.env;
}

export async function getLlmClient() {
  await loadEnv();
  const enabled = /^true$/i.test(process.env.LLM_ENABLED || 'false');
  const provider = process.env.LLM_PROVIDER || 'qwen';
  return {
    enabled,
    provider,
    async runJson(task) {
      if (!enabled) return { skipped: true, reason: 'LLM_ENABLED=false' };
      if (provider !== 'qwen') throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
      return qwenJson(task);
    },
  };
}

export async function loadLatestReport(reportDate = null) {
  const date = reportDate || await latestReportDate();
  if (!date) throw new Error('No report JSON found. Run npm run render first.');
  return {
    reportDate: date,
    report: await readJson(path.join(PATHS.reports, date, `${date}.json`), {}),
  };
}

export async function latestReportDate() {
  const entries = await fs.readdir(PATHS.reports, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1) || todayInZone();
}

export async function appendLlmError(errorRecord) {
  const file = path.join(PATHS.data, 'llm_candidates', 'errors.json');
  const existing = await readJson(file, { errors: [] });
  existing.errors = [...(existing.errors || []), { at: new Date().toISOString(), ...errorRecord }];
  await writeJson(file, existing);
}

export async function ensureLlmDirs() {
  await ensureDir(path.join(PATHS.data, 'llm_candidates'));
  await ensureDir(path.join(PATHS.data, 'llm_candidates', 'valuation'));
}
