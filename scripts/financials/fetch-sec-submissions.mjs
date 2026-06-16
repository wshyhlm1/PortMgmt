import path from 'node:path';
import { PATHS, ensureDir, readJson, writeJson } from '../shared.mjs';

async function main() {
  const registry = await readJson(path.join(PATHS.data, 'source_registry', 'company_financial_sources.json'), { companies: [] });
  const rows = (registry.companies || [])
    .filter((item) => (item.primary_sources || []).some((source) => /sec/i.test(source.type)))
    .map((item) => ({ ticker: item.ticker, adapter: 'sec_submissions', status: 'pending', next_action: item.next_action }));
  await ensureDir(path.join(PATHS.data, 'financials', 'raw'));
  await writeJson(path.join(PATHS.data, 'financials', 'raw', 'sec_submissions_registry.json'), { generated_at: new Date().toISOString(), rows });
  console.log(`SEC submissions registry rows: ${rows.length}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
