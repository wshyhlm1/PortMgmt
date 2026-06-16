import path from 'node:path';
import { PATHS, ensureDir, readJson, writeJson } from '../shared.mjs';
import { ENRICHMENT_TYPES, validateEnrichmentType } from './common.mjs';
import { normalizeModels } from './normalize-models.mjs';

async function main() {
  const results = [];
  for (const type of ENRICHMENT_TYPES) {
    results.push(await validateEnrichmentType(type));
  }
  const modelResult = await normalizeModels();
  await mirrorCapexValidation();
  console.log(`Enrichment validated: ${results.map((item) => `${item.type} ${item.verified}/${item.rejected}`).join(', ')}; models normalized ${modelResult.verified}.`);
}

async function mirrorCapexValidation() {
  const root = path.join(PATHS.data, 'capex');
  await ensureDir(root);
  const verified = await readJson(path.join(PATHS.data, 'enrichment', 'verified', 'capex.json'), { rows: [] });
  const rejected = await readJson(path.join(PATHS.data, 'enrichment', 'rejected', 'capex.json'), { rows: [] });
  await writeJson(path.join(root, 'verified.json'), verified);
  await writeJson(path.join(root, 'rejected.json'), rejected);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
