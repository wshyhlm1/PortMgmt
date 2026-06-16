import { ensureEnrichmentDirs, ENRICHMENT_TYPES } from './common.mjs';

async function main() {
  await ensureEnrichmentDirs();
  console.log(`Enrichment directories ready for: ${ENRICHMENT_TYPES.join(', ')}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
