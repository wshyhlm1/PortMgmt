import path from 'node:path';
import { PATHS, readJson } from '../shared.mjs';
import { METRICS } from './normalize-financials.mjs';

async function main() {
  const payload = await readJson(path.join(PATHS.data, 'financials', 'financial_history_verified.json'), { rows: [], coverage: [] });
  const coverageSummary = await readJson(path.join(PATHS.data, 'financials', 'financial_coverage_summary.json'), { rows: [] });
  const errors = [];
  validateRows(payload.rows || [], errors);
  validateCoverage(payload.coverage || [], errors);
  validateCoverageSummary(coverageSummary.rows || [], payload.coverage || [], errors);
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Financial validation ok: rows ${payload.rows?.length || 0}, tickers ${payload.coverage?.length || 0}.`);
}

function validateCoverageSummary(rows, coverage, errors) {
  if (!rows.length) errors.push('financial_coverage_summary.json missing rows');
  const expected = new Set((coverage || []).map((item) => item.ticker));
  for (const ticker of expected) {
    if (!rows.some((row) => row.ticker === ticker)) errors.push(`financial coverage summary missing ticker: ${ticker}`);
  }
  for (const row of rows) {
    if (typeof row.required_metrics_verified_pct !== 'number') errors.push(`Coverage summary missing pct: ${row.ticker}`);
    if (!Array.isArray(row.source_mix)) errors.push(`Coverage summary source_mix not array: ${row.ticker}`);
  }
}

function validateRows(rows, errors) {
  const metricTypes = new Map(METRICS.map((item) => [item.key, item.type]));
  for (const row of rows) {
    const label = `${row.ticker || ''} ${row.metric || ''} ${row.period_label || ''}`.trim();
    for (const field of ['ticker', 'metric', 'period_label', 'display', 'source_title', 'source_url', 'as_of']) {
      if (!row[field]) errors.push(`Financial row missing ${field}: ${label}`);
    }
    if (row.display === '-') errors.push(`Financial row uses hyphen: ${label}`);
    if (/^[+-]?\d+(?:\.\d+)?$/.test(String(row.display || '').trim())) errors.push(`Financial display is bare number: ${label}`);
    const type = row.metric.endsWith('_yoy') ? 'percent' : metricTypes.get(row.metric.replace(/_yoy$/, ''));
    if (type === 'amount' && /%/.test(row.display)) errors.push(`Amount field contains percent: ${label} ${row.display}`);
    if (type === 'percent' && !/%/.test(row.display)) errors.push(`Percent field lacks percent sign: ${label} ${row.display}`);
    if (['revenue', 'net_income', 'free_cash_flow', 'cash', 'debt'].includes(row.metric) && !/(美元|欧元|人民币|新台币|韩元|\$|€|¥|₩|亿|万亿)/.test(row.display)) {
      errors.push(`Amount display lacks currency/unit: ${label} ${row.display}`);
    }
  }
}

function validateCoverage(coverage, errors) {
  const seen = new Set();
  for (const item of coverage) {
    if (!item.ticker) errors.push('Coverage row missing ticker');
    if (seen.has(item.ticker)) errors.push(`Duplicate coverage ticker: ${item.ticker}`);
    seen.add(item.ticker);
    if (!Array.isArray(item.missing_metrics)) errors.push(`Coverage missing_metrics not array: ${item.ticker}`);
    if (!Array.isArray(item.source_issues)) errors.push(`Coverage source_issues not array: ${item.ticker}`);
    if (!item.next_action) errors.push(`Coverage missing next_action: ${item.ticker}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
