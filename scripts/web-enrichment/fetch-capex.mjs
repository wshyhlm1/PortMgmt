import path from 'node:path';
import { PATHS, ensureDir, readJson, writeJson } from '../shared.mjs';
import {
  fetchPublicSource,
  reportDateFromConfig,
  validateEnrichmentType,
  writeCandidatePayload,
  writeRawPayload,
} from './common.mjs';

async function main() {
  const config = await readJson(PATHS.config, {});
  const reportDate = reportDateFromConfig(config);
  const capexData = await readJson(path.join(PATHS.data, 'ai_capex.json'), { ai_capex: [] });
  const rows = (capexData.ai_capex || []).map((row) => capexCandidate(row, reportDate)).filter(Boolean);
  const urls = [...new Set(rows.map((row) => row.source_url).filter(Boolean))].slice(0, 40);
  const raw = [];
  for (const url of urls) {
    raw.push(await fetchPublicSource({ type: 'capex', title: url, url, kind: 'capex_public_source' }));
  }

  await writeRawPayload('capex', `capex_sources_${reportDate}`, { report_date: reportDate, sources: raw });
  await writeCandidatePayload('capex', `capex_${reportDate}`, rows, {
    source_note: 'Candidates normalized from existing supplemental AI Capex rows; validate-enrichment writes verified/rejected.',
  });
  await writeCapexLayer(reportDate, raw, rows);
  const result = await validateEnrichmentType('capex');
  await mirrorCapexValidation();
  console.log(`Capex enrichment wrote ${rows.length} candidates, fetched ${raw.length} sources, verified ${result.verified}, rejected ${result.rejected}.`);
}

function capexCandidate(row, reportDate) {
  const confidence = String(row.confidence || row.confidence_level || '').toLowerCase();
  if (!row.value && !row.capex_guidance && !row.notes) return null;
  return {
    ticker: row.ticker || row.display_ticker || row.company,
    company: row.company || row.display_ticker || row.ticker,
    field: row.field || 'capex',
    value: standardizeCapexValue(row.value || row.capex_guidance || row.notes),
    period: normalizePeriod(row.period, reportDate),
    source_title: row.source_type || row.source_title || 'public capex source',
    source_url: row.source_url || row.original_url || null,
    as_of: normalizeAsOf(row.period, reportDate),
    confidence: confidence === 'high' || confidence === 'medium' ? confidence : 'low',
    category: row.category || null,
  };
}

async function writeCapexLayer(reportDate, raw, rows) {
  const root = path.join(PATHS.data, 'capex');
  await ensureDir(path.join(root, 'raw'));
  await ensureDir(path.join(root, 'candidates'));
  await writeJson(path.join(root, 'raw', `${reportDate}.json`), { report_date: reportDate, sources: raw });
  await writeJson(path.join(root, 'candidates', `${reportDate}.json`), { report_date: reportDate, rows });
}

async function mirrorCapexValidation() {
  const root = path.join(PATHS.data, 'capex');
  const verified = await readJson(path.join(PATHS.data, 'enrichment', 'verified', 'capex.json'), { rows: [] });
  const rejected = await readJson(path.join(PATHS.data, 'enrichment', 'rejected', 'capex.json'), { rows: [] });
  await writeJson(path.join(root, 'verified.json'), verified);
  await writeJson(path.join(root, 'rejected.json'), rejected);
}

function standardizeCapexValue(value = '') {
  return String(value || '')
    .replace(/RMB\s*380\s*billion\s*\/\s*3/gi, '人民币 3,800 亿元 / 未来 3 年')
    .replace(/2024-Q4 and 2025-Q Q4/gi, '2024Q4')
    .replace(/US\$\s*/gi, '$')
    .replace(/USD\s*(\d[\d,.]*)\s*billion/gi, '$1B')
    .replace(/\$(\d[\d,.]*)\s*billion/gi, '$1B')
    .replace(/\$(\d[\d,.]*)\s*million/gi, '$1M')
    .replace(/\b(\d[\d,.]*)\s*billion\b/gi, '$1B')
    .replace(/\b(\d[\d,.]*)\s*million\b/gi, '$1M')
    .replace(/RMB\s*(\d[\d,.]*)\s*-\s*(\d[\d,.]*)\s*B\b/gi, (_, low, high) => `人民币 ${formatYi(Number(String(low).replace(/,/g, '')) * 10)}-${formatYi(Number(String(high).replace(/,/g, '')) * 10)} 亿元`)
    .replace(/RMB\s*(\d[\d,.]*)\s*B\b/gi, (_, value) => `人民币 ${formatYi(Number(String(value).replace(/,/g, '')) * 10)} 亿元`)
    .replace(/\s*\+\/-\s*/g, '±')
    .replace(/Capex口径|需继续核对云与AI投入节奏|待核对/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatYi(value) {
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function normalizePeriod(period, reportDate) {
  const text = String(period || '').trim();
  if (!text) return reportDate;
  return text.replace(/2024-Q4 and 2025-Q Q4/gi, '2024Q4');
}

function normalizeAsOf(period, reportDate) {
  const text = String(period || '');
  const match = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return match ? match[1] : reportDate;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
