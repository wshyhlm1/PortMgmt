import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDir, readJson, writeJson } from '../shared.mjs';
import { ensureLlmDirs, loadLatestReport } from './client.mjs';

const VALUATION_FIELDS = new Set(['Forward PE', 'EV/EBITDA', 'FCF Yield', 'FY2026E EPS', 'FY2027E EPS', 'FY2026E PE', 'FY2027E PE', 'FY2026E EV/EBITDA', 'FY2027E EV/EBITDA', 'FY2026E FCF Yield', 'FY2027E FCF Yield']);

async function main() {
  await ensureLlmDirs();
  const { reportDate } = await loadLatestReport(process.argv[2]);
  const valuationDir = path.join(PATHS.data, 'llm_candidates', 'valuation');
  await ensureDir(valuationDir);
  const files = (await fs.readdir(valuationDir).catch(() => []))
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.join(valuationDir, file));
  const verified = [];
  const rejected = [];
  for (const file of files) {
    const payload = await readJson(file, null);
    const rows = Array.isArray(payload) ? payload : payload?.rows || payload?.candidates || [];
    for (const row of rows) {
      const reason = valuationRejectReason(row);
      if (reason) rejected.push({ file: path.relative(PATHS.data, file), row, reason });
      else verified.push(normalizeValuationRow(row));
    }
  }
  await writeJson(path.join(PATHS.data, 'valuation_verified.json'), {
    report_date: reportDate,
    rows: verified,
    rejected,
  });
  console.log(`Valuation LLM candidates validated: ${verified.length} verified, ${rejected.length} rejected.`);
}

function valuationRejectReason(row = {}) {
  if (!row || typeof row !== 'object') return 'not_object';
  if (!row.ticker || !row.field || !row.value) return 'missing_required_field';
  if (!VALUATION_FIELDS.has(row.field)) return 'field_not_allowed';
  if (!row.period) return 'period_missing';
  if (!row.as_of || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.as_of))) return 'as_of_missing_or_invalid';
  if (!row.source_title && !row.source_url) return 'source_missing';
  if (row.confidence === 'low') return 'low_confidence';
  if (!valuationValueMatchesField(row)) return 'value_missing_unit_or_multiple';
  const visible = `${row.field} ${row.value} ${row.period} ${row.source_title || ''}`;
  if (/https?:\/\/|weixin\.qq\.com|com\/s\/|[a-f0-9]{10,}_|null|undefined/i.test(visible)) return 'visible_noise';
  if (/[A-Za-z]{5,}(?:\s+[A-Za-z]{4,}){5,}/.test(visible)) return 'english_long_sentence';
  return null;
}

function valuationValueMatchesField(row = {}) {
  const field = String(row.field || '');
  const value = String(row.value || '');
  if (/EPS/i.test(field)) return /(\$|USD|美元|EUR|€|RMB|CNY|¥|KRW|₩|TWD|NT\$|新台币)/i.test(value);
  if (/FCF Yield/i.test(field)) return /%|N\/A/i.test(value);
  if (/PE|EV\/EBITDA/i.test(field)) return /(x|倍|N\/A)/i.test(value);
  return /(x|倍|%|\$|USD|美元|EUR|€|RMB|CNY|¥|KRW|₩|TWD|NT\$|新台币)/i.test(value);
}

function normalizeValuationRow(row) {
  return {
    ticker: row.ticker,
    field: row.field,
    value: row.value,
    period: row.period,
    source_title: row.source_title || null,
    source_url: row.source_url || null,
    as_of: row.as_of,
    confidence: row.confidence || 'medium',
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
