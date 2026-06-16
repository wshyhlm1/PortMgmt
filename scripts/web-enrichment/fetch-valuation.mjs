import { PATHS, readJson } from '../shared.mjs';
import {
  fetchPublicSource,
  reportDateFromConfig,
  writeCandidatePayload,
  writeRawPayload,
} from './common.mjs';

async function main() {
  const config = await readJson(PATHS.config, {});
  const reportDate = reportDateFromConfig(config);
  const valuation = await readJson(`${PATHS.data}/valuation_verified.json`, { rows: [] });
  const rows = (valuation.rows || []).map((row) => ({
    ticker: row.ticker,
    field: row.field,
    value: row.value,
    period: row.period,
    source_title: row.source_title,
    source_url: row.source_url,
    as_of: row.as_of,
    confidence: row.confidence,
  }));

  const urls = [...new Set(rows.map((row) => row.source_url).filter(Boolean))].slice(0, 24);
  const raw = [];
  for (const url of urls) {
    raw.push(await fetchPublicSource({ type: 'valuation', title: url, url, kind: 'valuation_public_source' }));
  }
  await writeRawPayload('valuation', `valuation_sources_${reportDate}`, {
    report_date: reportDate,
    sources: raw,
  });
  await writeCandidatePayload('valuation', `valuation_${reportDate}`, rows, {
    source_note: 'Seeded from data/valuation_verified.json; validate-enrichment rechecks source/date/period/unit before verified enrichment.',
  });
  console.log(`Valuation enrichment wrote ${rows.length} candidates and fetched ${raw.length} public source pages.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
