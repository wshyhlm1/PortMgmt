import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS, ensureDir, readJson, writeJson } from '../shared.mjs';

const __filename = fileURLToPath(import.meta.url);

const AMOUNT_METRICS = new Set(['revenue', 'operating_income', 'net_income', 'operating_cash_flow', 'capex', 'free_cash_flow', 'cash', 'debt', 'net_cash_or_debt']);
const MARGIN_METRICS = new Set(['gross_margin', 'operating_margin']);

export async function runFinancialSanity() {
  const payload = await readJson(path.join(PATHS.data, 'financials', 'financial_history_verified.json'), { rows: [], coverage: [] });
  const coverageSummary = await readJson(path.join(PATHS.data, 'financials', 'financial_coverage_summary.json'), { rows: [] });
  const result = collectFinancialSanityIssues(payload.rows || [], coverageSummary.rows || payload.coverage || []);
  const outputPath = path.join(PATHS.data, 'financials', 'financial_sanity.json');
  await ensureDir(path.dirname(outputPath));
  await writeJson(outputPath, {
    generated_at: new Date().toISOString(),
    status: result.errors.length ? 'fail' : 'ok',
    errors: result.errors,
    warnings: result.warnings,
    high_risk_count: result.errors.length,
  });
  if (result.errors.length) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Financial sanity ok: rows ${payload.rows?.length || 0}, warnings ${result.warnings.length}.`);
  return result;
}

export function collectFinancialSanityIssues(rows = [], coverage = []) {
  const errors = [];
  const warnings = [];
  const byTickerPeriod = new Map();
  const seen = new Set();

  for (const row of rows) {
    const label = rowLabel(row);
    const key = `${tickerKey(row.ticker)}|${row.metric}|${row.period_label}|${row.period_type || ''}`;
    if (seen.has(key)) errors.push(`Duplicate financial metric/period after normalization: ${label}`);
    seen.add(key);

    if (AMOUNT_METRICS.has(row.metric) && /%/.test(String(row.display || ''))) {
      errors.push(`Amount metric displays percent: ${label} ${row.display}`);
    }
    if (MARGIN_METRICS.has(row.metric) && !/%/.test(String(row.display || ''))) {
      errors.push(`Margin metric lacks percent display: ${label} ${row.display}`);
    }
    if (row.metric === 'capex' && (Number(row.value) < 0 || /^\s*-/.test(String(row.display || '')))) {
      errors.push(`Capex displays or stores negative value: ${label} ${row.display}`);
    }
    if (row.metric === 'cash' && isOcfSource(row)) {
      errors.push(`Cash row appears mapped from operating cash flow source: ${label}`);
    }
    if (row.metric === 'operating_cash_flow' && isCashBalanceSource(row)) {
      errors.push(`OCF row appears mapped from cash balance source: ${label}`);
    }
    if (row.metric === 'free_cash_flow' && isOcfSource(row) && !isFcfSource(row)) {
      errors.push(`FCF row appears mapped from OCF-only source: ${label}`);
    }
    if (!row.derived && ['TWD', 'KRW'].includes(normalizeUnit(row.unit))) {
      checkLocalCurrencyScale(row, errors);
    }

    const periodKey = `${tickerKey(row.ticker)}|${row.period_label}|${row.period_type || ''}`;
    if (!byTickerPeriod.has(periodKey)) byTickerPeriod.set(periodKey, []);
    byTickerPeriod.get(periodKey).push(row);
  }

  for (const group of byTickerPeriod.values()) {
    const revenue = group.find((row) => row.metric === 'revenue');
    const operatingIncome = group.find((row) => row.metric === 'operating_income');
    if (revenue && operatingIncome && sameCurrency(revenue.unit, operatingIncome.unit) && Number(operatingIncome.value) > Math.abs(Number(revenue.value)) * 1.02) {
      errors.push(`Operating income exceeds revenue: ${rowLabel(operatingIncome)} > ${revenue.display}`);
    }
    for (const margin of group.filter((row) => row.metric === 'gross_margin' || row.metric === 'operating_margin')) {
      const marginValue = Number(margin.value);
      if (marginValue > 100 || (margin.metric === 'gross_margin' && marginValue < -100)) {
        errors.push(`Margin magnitude exceeds plausible bound: ${rowLabel(margin)} ${margin.display}`);
      } else if (margin.metric === 'operating_margin' && marginValue < -100) {
        warnings.push(`Operating margin below -100%; check loss-stage company scale: ${rowLabel(margin)} ${margin.display}`);
      }
    }
  }

  for (const item of coverage || []) {
    const pct = Number(item.required_metrics_verified_pct || 0);
    if (pct < 0.5) warnings.push(`Low financial coverage: ${item.ticker} ${(pct * 100).toFixed(0)}%`);
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function checkLocalCurrencyScale(row = {}, errors = []) {
  const rawText = `${row.source_raw_value || ''} ${row.source_metric_label || ''} ${row.source_unit_hint || ''}`;
  const sourceNumber = Number(row.source_number);
  const scale = Number(row.source_unit_scale);
  if (Number.isFinite(sourceNumber) && Number.isFinite(scale) && scale > 0) {
    const expected = row.metric === 'capex' ? Math.abs(sourceNumber * scale) : sourceNumber * scale;
    const actual = Number(row.value);
    const tolerance = Math.max(1, Math.abs(expected) * 0.001);
    if (Number.isFinite(actual) && Math.abs(Math.abs(actual) - Math.abs(expected)) > tolerance) {
      errors.push(`TWD/KRW source scale mismatch: ${rowLabel(row)} raw=${row.source_raw_value} scale=${scale}`);
    }
  }
  if (/(million|mn|百万)/i.test(rawText) && scale && scale !== 1000000) {
    errors.push(`TWD/KRW million-to-亿 conversion suspect: ${rowLabel(row)} hint=${row.source_unit_hint}`);
  }
  if (/(万亿|trillion)/i.test(rawText) && scale && scale < 1000000000000) {
    errors.push(`TWD/KRW trillion conversion suspect: ${rowLabel(row)} hint=${row.source_unit_hint}`);
  }
}

function isOcfSource(row = {}) {
  return /(NetCashProvided|Operating Cash Flow|经营活动现金流|经营现金流|OCF)/i.test(sourceText(row));
}

function isCashBalanceSource(row = {}) {
  return /(CashAndCashEquivalents|现金及等价物|现金及短期投资|现金余额|cash balance|cash equivalents)/i.test(sourceText(row));
}

function isFcfSource(row = {}) {
  return /(Free Cash Flow|FCF|自由现金流|PaymentsToAcquirePropertyPlantAndEquipment|capex|资本支出)/i.test(sourceText(row));
}

function sourceText(row = {}) {
  return `${row.source_title || ''} ${row.source_url || ''} ${row.source_file || ''} ${row.source_metric_label || ''}`;
}

function sameCurrency(left, right) {
  return normalizeUnit(left) === normalizeUnit(right);
}

function normalizeUnit(unit = '') {
  const text = String(unit || '').toUpperCase();
  if (text.includes('USD')) return 'USD';
  if (text.includes('EUR')) return 'EUR';
  if (text.includes('CNY') || text.includes('RMB')) return 'CNY';
  if (text.includes('TWD') || text.includes('NTD')) return 'TWD';
  if (text.includes('KRW')) return 'KRW';
  if (text.includes('PERCENT')) return 'percent';
  return text || null;
}

function tickerKey(value = '') {
  return String(value || '').toUpperCase().replace(/\.(O|N|US|DF)$/i, '').replace(/[^A-Z0-9]/g, '');
}

function rowLabel(row = {}) {
  return `${row.ticker || ''} ${row.metric || ''} ${row.period_label || ''}`.trim();
}

if (process.argv[1] === __filename) {
  runFinancialSanity().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
