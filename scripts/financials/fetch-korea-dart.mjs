import path from 'node:path';
import { PATHS, ensureDir, readJson, writeJson } from '../shared.mjs';

async function main() {
  const registry = await readJson(path.join(PATHS.data, 'source_registry', 'company_financial_sources.json'), { companies: [] });
  const rows = (registry.companies || [])
    .filter((item) => /dart|korea/i.test(item.adapter || '') || item.preferred_currency === 'KRW')
    .map((item) => ({ ticker: item.ticker, adapter: 'korea_dart', status: 'adapter_needed', next_action: item.next_action }));
  await ensureDir(path.join(PATHS.data, 'financials', 'raw'));
  await writeJson(path.join(PATHS.data, 'financials', 'raw', 'korea_dart_registry.json'), { generated_at: new Date().toISOString(), rows });
  console.log(`Korea DART registry rows: ${rows.length}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
