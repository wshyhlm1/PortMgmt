import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { PATHS, compactWhitespace, ensureDir, listFilesRecursive, parseMarkdownTables, readJson, relativeToRoot, writeJson } from '../shared.mjs';

const __filename = fileURLToPath(import.meta.url);

export const METRICS = [
  { key: 'revenue', label: '收入', type: 'amount' },
  { key: 'gross_margin', label: '毛利率', type: 'percent' },
  { key: 'operating_income', label: '营业利润', type: 'amount' },
  { key: 'operating_margin', label: '营业利润率', type: 'percent' },
  { key: 'net_income', label: '净利润', type: 'amount' },
  { key: 'diluted_eps', label: 'EPS diluted', type: 'per_share' },
  { key: 'operating_cash_flow', label: 'OCF', type: 'amount' },
  { key: 'capex', label: 'Capex', type: 'amount' },
  { key: 'free_cash_flow', label: 'FCF', type: 'amount' },
  { key: 'cash', label: '现金', type: 'amount' },
  { key: 'debt', label: '债务', type: 'amount' },
  { key: 'net_cash_or_debt', label: '净现金/净债务', type: 'amount' },
];

export async function normalizeFinancialHistory() {
  const sourceRegistry = await readJson(path.join(PATHS.data, 'source_registry', 'company_financial_sources.json'), { companies: [] });
  const oldVerified = await readJson(path.join(PATHS.data, 'enrichment', 'verified', 'financials.json'), { rows: [] });
  const outputRoot = path.join(PATHS.data, 'financials');
  await ensureDir(outputRoot);
  await ensureDir(path.join(outputRoot, 'raw'));
  await ensureDir(path.join(outputRoot, 'candidates'));
  await ensureDir(path.join(outputRoot, 'verified'));
  await ensureDir(path.join(outputRoot, 'rejected'));

  const rows = [];
  const rejected = [];
  for (const row of oldVerified.rows || []) {
    const normalized = normalizeCandidate(row);
    if (!normalized) {
      rejected.push({ row, reason: 'unsupported_or_invalid_financial_row' });
      continue;
    }
    rows.push(normalized);
  }
  const profileRows = await profileFinancialRows(sourceRegistry.companies || []);
  await writeJson(path.join(outputRoot, 'candidates', 'from_profiles.json'), {
    generated_at: new Date().toISOString(),
    type: 'financial_history_profile_candidates',
    source_note: 'Parsed from initial profile Markdown tables; merged into verified only when period, metric, display, unit and source_file are clear.',
    rows: profileRows,
  });
  rows.push(...profileRows);
  rows.push(...computedRows(rows));
  const deduped = dedupeRows(rows)
    .filter((row) => row.display && row.display !== '—' && row.source_title && row.source_url);
  const coverage = coverageRows(sourceRegistry.companies || [], deduped);
  const coverageSummary = coverage.map((item) => ({
    ticker: item.ticker,
    company: item.company,
    annual_periods_verified: item.annual_count,
    quarter_periods_verified: item.quarter_count,
    required_metrics_verified_pct: item.required_metrics_verified_pct,
    missing_metrics: item.missing_metrics,
    source_mix: item.source_mix,
  }));

  const payload = {
    generated_at: new Date().toISOString(),
    type: 'financial_history',
    metrics: METRICS.map(({ key, label, type }) => ({ key, label, type })),
    rows: deduped.sort(sortFinancialRows),
    coverage,
  };
  await writeJson(path.join(outputRoot, 'financial_history_verified.json'), payload);
  await writeJson(path.join(outputRoot, 'financial_coverage_summary.json'), {
    generated_at: new Date().toISOString(),
    type: 'financial_coverage_summary',
    rows: coverageSummary,
  });
  await writeJson(path.join(outputRoot, 'financial_history_rejected.json'), {
    generated_at: new Date().toISOString(),
    type: 'financial_history',
    rows: rejected,
  });
  await writeJson(path.join(outputRoot, 'errors.json'), { generated_at: new Date().toISOString(), errors: [] });
  await writeJson(path.join(outputRoot, 'verified', 'financial_history.json'), payload);
  await writeJson(path.join(outputRoot, 'rejected', 'financial_history.json'), { rows: rejected });
  console.log(`Normalized financial history rows: ${deduped.length}; coverage tickers: ${coverage.length}.`);
  return payload;
}

async function profileFinancialRows(registryCompanies = []) {
  const files = await listFilesRecursive(PATHS.initial, ['.md', '.markdown']);
  const registryByKey = new Map(registryCompanies.map((item) => [tickerKey(item.ticker), item]));
  const out = [];
  for (const file of files) {
    const markdown = await fs.readFile(file, 'utf8');
    const sourceFile = relativeToRoot(file);
    const ticker = tickerFromProfileFile(file, registryByKey);
    const registry = registryByKey.get(tickerKey(ticker)) || {};
    const currency = registry.preferred_currency || profileCurrency(markdown, ticker);
    for (const table of parseMarkdownTables(markdown)) {
      const header = table.header.map((cell) => compactWhitespace(cell));
      const periodIndexes = header
        .map((cell, index) => ({ cell, index }))
        .filter(({ cell }) => /^FY?20\d{2}$|^20\d{2}$/.test(cell));
      if (!periodIndexes.length) continue;
      const metricIndex = header.findIndex((cell) => /指标|metric|项目/i.test(cell));
      if (metricIndex === -1) continue;
      for (const row of table.rows) {
        const label = compactWhitespace(row[metricIndex] || '');
        const metric = profileMetricKey(label);
        if (!metric) continue;
        for (const { cell: period, index } of periodIndexes) {
          const raw = compactWhitespace(row[index] || '');
          const candidate = profileRowFromValue({ ticker, company: registry.company || ticker, metric, label, period, raw, currency, sourceFile, header });
          if (candidate) out.push(candidate);
        }
      }
    }
  }
  return dedupeRows(out);
}

function tickerFromProfileFile(file, registryByKey) {
  const base = path.basename(file).replace(/_profile\.md$/i, '').replace(/\.md$/i, '');
  const key = tickerKey(base);
  const exact = [...registryByKey.values()].find((item) => tickerKey(item.ticker) === key || tickerKey(item.ticker).startsWith(key) || tickerKey(item.company).includes(key));
  return exact?.ticker || base;
}

function profileMetricKey(label = '') {
  const text = compactWhitespace(label);
  if (/增速|增长率|growth|YoY|同比|环比|QoQ/i.test(text)) return null;
  if (/营业收入|收入（|收入\(|营收|Revenue/i.test(text)) return 'revenue';
  if (/毛利率|Gross Margin/i.test(text)) return 'gross_margin';
  if (/运营利润率|营业利润率|Operating Margin/i.test(text)) return 'operating_margin';
  if (/运营利润|营业利润|Operating Income/i.test(text)) return 'operating_income';
  if (/净利润|Net Income/i.test(text)) return 'net_income';
  if (/摊薄EPS|Diluted EPS|EPS/i.test(text)) return 'diluted_eps';
  if (/经营活动现金流|经营现金流|Operating Cash Flow|OCF|NetCashProvided/i.test(text)) return 'operating_cash_flow';
  if (/自由现金流|FCF|Free Cash Flow/i.test(text)) return 'free_cash_flow';
  if (/净负债|净现金|Net Debt|Net Cash/i.test(text)) return 'net_cash_or_debt';
  if (/总债务|债务|Debt/i.test(text)) return 'debt';
  if (/资本支出|Capex|CAPEX/i.test(text)) {
    if (/机械设备|厂房设施|厂房|设施|equipment|facility|building/i.test(text)) return null;
    return 'capex';
  }
  if (/现金流|Cash Flow/i.test(text)) return null;
  if (/现金及(?:等价物|短期投资)|现金储备|现金余额|Cash(?: and cash equivalents| balance| & short-term investments)?/i.test(text)) return 'cash';
  return null;
}

function profileRowFromValue({ ticker, company, metric, label, period, raw, currency, sourceFile, header = [] }) {
  if (!raw || raw === '—' || raw === '-') return null;
  const metricDef = METRICS.find((item) => item.key === metric);
  if (!metricDef) return null;
  const parsed = parseProfileValue({ raw, label, metricDef, currency, header });
  if (!parsed) return null;
  const number = parsed.number;
  if (!Number.isFinite(number)) return null;
  let unit = parsed.unit || currency;
  let value = parsed.value;
  let display = null;
  if (metricDef.type === 'percent') {
    unit = 'percent';
    display = `${number.toFixed(1).replace(/\.0$/, '')}%`;
  } else if (metricDef.type === 'per_share') {
    unit = `${currency}/share`;
    display = displayFor(metricDef, number, unit);
  } else {
    if (metric === 'capex') value = Math.abs(value);
    if (metric === 'net_cash_or_debt') {
      const labelPrefix = number < 0 || /净现金/.test(label) ? '净现金' : '净债务';
      display = `${labelPrefix} ${amountDisplay(Math.abs(value), currency)}`;
    } else {
      display = amountDisplay(value, currency);
    }
  }
  if (!display || isDisplayMismatch(metricDef, display)) return null;
  return {
    ticker,
    company,
    metric,
    metric_label: metricDef.label,
    period: `${String(period).replace(/^FY/i, '')}-12-31`,
    period_label: `FY${String(period).replace(/^FY/i, '')}`,
    period_type: 'annual',
    fiscal_year: String(period).replace(/^FY/i, ''),
    fiscal_quarter: null,
    value,
    unit,
    display,
    source_title: `Profile financial table ${sourceFile}`,
    source_url: sourceFile,
    source_file: sourceFile,
    source_metric_label: label,
    source_raw_value: raw,
    source_unit_scale: parsed.scale || null,
    source_unit_hint: parsed.unitHint || null,
    source_number: number,
    as_of: '2026-06-04',
    confidence: 'medium',
    source_form: 'profile_candidate',
  };
}

function parseProfileValue({ raw = '', label = '', metricDef = {}, currency = '', header = [] }) {
  const text = compactWhitespace(String(raw || '').replace(/&nbsp;/gi, ' '));
  const labelText = compactWhitespace(`${label || ''} ${(header || []).join(' ')}`);
  if (metricDef.type === 'percent') {
    const number = firstNumber(text);
    return Number.isFinite(number) ? { number, value: number, unit: 'percent', scale: null, unitHint: '%' } : null;
  }
  if (metricDef.type === 'per_share') {
    const number = firstNumber(text);
    return Number.isFinite(number) ? { number, value: number, unit: `${currency}/share`, scale: null, unitHint: 'per_share' } : null;
  }
  const amount = profileAmount(text, labelText, currency);
  return amount;
}

function profileAmount(text = '', labelText = '', currency = '') {
  const clean = compactWhitespace(text);
  const currencyRegex = currencyPattern(currency);
  const unitToken = '(?:万亿|千亿|亿|billion|bn|million|mn|百万)?';
  const amountBeforeCurrency = new RegExp(`([+-]?\\d[\\d,]*(?:\\.\\d+)?)\\s*(${unitToken})\\s*(?:${currencyRegex})`, 'i');
  const amountAfterCurrency = new RegExp(`(?:${currencyRegex})\\s*([+-]?\\d[\\d,]*(?:\\.\\d+)?)\\s*(${unitToken})`, 'i');
  const match = clean.match(amountBeforeCurrency) || clean.match(amountAfterCurrency);
  if (match) {
    const number = Number(String(match[1]).replace(/,/g, ''));
    const unitHint = match[2] || unitHintFromText(`${clean} ${labelText}`);
    const scale = scaleForUnitHint(unitHint, labelText);
    return Number.isFinite(number) ? { number, value: number * scale, unit: currency, scale, unitHint: unitHint || 'currency_amount' } : null;
  }
  const withUnit = clean.match(/([+-]?\d[\d,]*(?:\.\d+)?)\s*(万亿|千亿|亿|billion|bn|million|mn|百万)/i);
  if (withUnit) {
    const number = Number(String(withUnit[1]).replace(/,/g, ''));
    const scale = scaleForUnitHint(withUnit[2], labelText);
    return Number.isFinite(number) ? { number, value: number * scale, unit: currency, scale, unitHint: withUnit[2] } : null;
  }
  const number = firstNumber(clean);
  if (!Number.isFinite(number)) return null;
  const unitHint = unitHintFromText(`${labelText} ${clean}`);
  const scale = scaleForUnitHint(unitHint, labelText);
  return { number, value: number * scale, unit: currency, scale, unitHint: unitHint || 'default_100m' };
}

function firstNumber(value = '') {
  const match = String(value || '').match(/[+-]?\d[\d,]*(?:\.\d+)?/);
  return match ? Number(match[0].replace(/,/g, '')) : NaN;
}

function currencyPattern(currency = '') {
  const unit = normalizeUnit(currency);
  if (unit === 'USD') return '美元|USD|US\\$|\\$';
  if (unit === 'EUR') return '欧元|EUR|€';
  if (unit === 'CNY') return '人民币|CNY|RMB|元';
  if (unit === 'TWD') return '新台币|台币|TWD|NTD|NT\\$';
  if (unit === 'KRW') return '韩元|KRW|₩';
  return '美元|欧元|人民币|新台币|韩元|USD|EUR|CNY|RMB|TWD|KRW|\\$|€|¥|₩';
}

function unitHintFromText(text = '') {
  const match = String(text || '').match(/万亿|千亿|亿|billion|bn|million|mn|百万/i);
  return match ? match[0] : null;
}

function scaleForUnitHint(hint = '', context = '') {
  const text = `${hint || ''} ${context || ''}`;
  if (/万亿/i.test(text)) return 1000000000000;
  if (/千亿/i.test(text)) return 100000000000;
  if (/亿/i.test(text)) return 100000000;
  if (/billion|bn/i.test(text)) return 1000000000;
  if (/million|mn|百万/i.test(text)) return 1000000;
  return 100000000;
}

function profileCurrency(markdown = '', ticker = '') {
  if (/EUR|欧元/.test(markdown) || /ASML|IFX|NOK/i.test(ticker)) return 'EUR';
  if (/TWD|新台币/.test(markdown) || /ASX|TSM/i.test(ticker)) return 'TWD';
  if (/KRW|韩元/.test(markdown) || /Samsung|SKM/i.test(ticker)) return 'KRW';
  if (/RMB|CNY|人民币/.test(markdown) || /BABA/i.test(ticker)) return 'CNY';
  return 'USD';
}

function normalizeCandidate(row = {}) {
  const metric = metricKey(row);
  if (!metric) return null;
  const rawValue = Number(row.value);
  const value = metric === 'capex' ? Math.abs(rawValue) : rawValue;
  if (!Number.isFinite(value)) return null;
  const periodLabel = periodLabelFor(row);
  const periodType = periodTypeFor(row);
  const metricDef = METRICS.find((item) => item.key === metric);
  const display = displayFor(metricDef, value, row.unit);
  if (!display || isDisplayMismatch(metricDef, display)) return null;
  return {
    ticker: row.ticker,
    company: row.company,
    metric,
    metric_label: metricDef.label,
    period: row.period,
    period_label: periodLabel,
    period_type: periodType,
    fiscal_year: periodLabel.match(/FY(20\d{2})/)?.[1] || null,
    fiscal_quarter: periodType === 'quarter' ? periodLabel : null,
    value,
    unit: normalizeUnit(row.unit),
    display,
    source_title: row.source_title,
    source_url: row.source_url,
    as_of: row.as_of,
    confidence: row.confidence || 'medium',
    source_form: row.form || null,
    source_metric_label: row.field || null,
    source_raw_value: row.value ?? null,
  };
}

function metricKey(rowOrField = '') {
  const row = typeof rowOrField === 'object' && rowOrField !== null ? rowOrField : { field: rowOrField };
  const text = String(row.field || '');
  const source = `${row.source_title || ''} ${row.source_url || ''}`;
  if (text === 'revenue') return 'revenue';
  if (text === 'net_income') return 'net_income';
  if (text === 'EPS' || /eps/i.test(text)) return 'diluted_eps';
  if (text === 'FCF') {
    if (/NetCashProvided|OperatingCashFlow|Operating Cash Flow|经营活动现金流|经营现金流/i.test(source)) return 'operating_cash_flow';
    return 'free_cash_flow';
  }
  if (text === 'capex') return 'capex';
  if (text === 'cash') return 'cash';
  if (text === 'debt') return 'debt';
  return null;
}

function periodLabelFor(row = {}) {
  const year = String(row.period || '').match(/^(20\d{2})/)?.[1] || String(row.fiscal_year || '').match(/20\d{2}/)?.[0] || null;
  if (row.fiscal_quarter && row.fiscal_quarter !== 'FY' && year) return `FY${year}${String(row.fiscal_quarter).toUpperCase()}`;
  return year ? `FY${year}` : String(row.period || '未标注期间');
}

function periodTypeFor(row = {}) {
  if (row.fiscal_quarter && row.fiscal_quarter !== 'FY') return 'quarter';
  if (/10-Q|6-K/i.test(String(row.form || '')) && !/12-31|09-30|03-31/.test(String(row.period || ''))) return 'quarter';
  return 'annual';
}

function computedRows(rows = []) {
  const out = [];
  const byTickerPeriod = new Map();
  for (const row of rows) {
    const key = `${row.ticker}|${row.period_label}`;
    if (!byTickerPeriod.has(key)) byTickerPeriod.set(key, []);
    byTickerPeriod.get(key).push(row);
  }
  for (const group of byTickerPeriod.values()) {
    const ocf = group.find((row) => row.metric === 'operating_cash_flow');
    const capex = group.find((row) => row.metric === 'capex');
    if (ocf && capex && sameCurrency(ocf.unit, capex.unit)) {
      const value = ocf.value - Math.abs(capex.value);
      out.push(derivedRow(ocf, {
        metric: 'free_cash_flow',
        metric_label: 'FCF',
        value,
        display: displayFor({ type: 'amount' }, value, ocf.unit),
        source_title: `${ocf.source_title}; ${capex.source_title}`,
        source_url: ocf.source_url,
        source_metric_label: [ocf.source_metric_label, capex.source_metric_label].filter(Boolean).join('; ') || null,
        source_raw_value: [ocf.source_raw_value, capex.source_raw_value].filter((item) => item !== null && item !== undefined).join('; ') || null,
        source_unit_scale: null,
        source_unit_hint: null,
        source_number: null,
      }));
    }
    const cash = group.find((row) => row.metric === 'cash');
    const debt = group.find((row) => row.metric === 'debt');
    if (cash && debt && sameCurrency(cash.unit, debt.unit)) {
      const value = cash.value - Math.abs(debt.value);
      const label = value >= 0 ? '净现金' : '净债务';
      out.push(derivedRow(cash, {
        metric: 'net_cash_or_debt',
        metric_label: '净现金/净债务',
        value,
        display: `${label} ${displayFor({ type: 'amount' }, Math.abs(value), cash.unit)}`,
        source_title: `${cash.source_title}; ${debt.source_title}`,
        source_url: cash.source_url,
      }));
    }
    const revenue = group.find((row) => row.metric === 'revenue');
    const operatingIncome = group.find((row) => row.metric === 'operating_income');
    if (revenue && operatingIncome && revenue.value !== 0) {
      const value = (operatingIncome.value / revenue.value) * 100;
      out.push(derivedRow(operatingIncome, {
        metric: 'operating_margin',
        metric_label: '营业利润率',
        value,
        unit: 'percent',
        display: `${value.toFixed(1)}%`,
        source_title: `${operatingIncome.source_title}; ${revenue.source_title}`,
        source_url: operatingIncome.source_url,
      }));
    }
  }
  out.push(...yoyRows(rows));
  return out;
}

function yoyRows(rows = []) {
  const out = [];
  const annualRows = rows.filter((row) => row.period_type === 'annual');
  const groups = new Map();
  for (const row of annualRows) {
    if (!['revenue', 'net_income', 'operating_cash_flow', 'capex', 'free_cash_flow'].includes(row.metric)) continue;
    const key = `${row.ticker}|${row.metric}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    const sorted = group.sort((a, b) => String(a.period_label).localeCompare(String(b.period_label)));
    const latest = sorted.at(-1);
    const previous = sorted.at(-2);
    if (!latest || !previous || previous.value === 0) continue;
    const yoy = ((latest.value - previous.value) / Math.abs(previous.value)) * 100;
    out.push(derivedRow(latest, {
      metric: `${latest.metric}_yoy`,
      metric_label: `${latest.metric_label}同比`,
      value: yoy,
      unit: 'percent',
      display: `${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}%`,
      source_title: `${latest.source_title}; ${previous.source_title}`,
      source_url: latest.source_url,
    }));
  }
  return out;
}

function derivedRow(base, patch) {
  return {
    ...base,
    ...patch,
    unit: patch.unit || base.unit,
    confidence: 'medium',
    derived: true,
  };
}

function coverageRows(companies = [], rows = []) {
  const byTicker = new Map();
  for (const row of rows) {
    const key = tickerKey(row.ticker);
    if (!byTicker.has(key)) byTicker.set(key, []);
    byTicker.get(key).push(row);
  }
  return companies.map((company) => {
    const tickerRows = byTicker.get(tickerKey(company.ticker)) || [];
    const annual = new Set(tickerRows.filter((row) => row.period_type === 'annual').map((row) => row.period_label));
    const quarters = new Set(tickerRows.filter((row) => row.period_type === 'quarter').map((row) => row.period_label));
    const presentMetrics = new Set(tickerRows.map((row) => row.metric.replace(/_yoy$/, '')));
    const missing = METRICS.map((item) => item.key).filter((key) => !presentMetrics.has(key));
    const annualMetricPairs = new Set(tickerRows
      .filter((row) => row.period_type === 'annual')
      .map((row) => `${row.metric.replace(/_yoy$/, '')}|${row.period_label}`));
    const requiredTotal = METRICS.length * 3;
    const requiredVerified = METRICS.reduce((sum, metric) => sum + ['FY2023', 'FY2024', 'FY2025'].filter((period) => annualMetricPairs.has(`${metric.key}|${period}`)).length, 0);
    const sourceMix = [...new Set(tickerRows.map((row) => sourceFamily(row)).filter(Boolean))];
    const reasons = missingReasons(company, tickerRows);
    return {
      ticker: company.ticker,
      company: company.company,
      status: company.status,
      annual_periods: [...annual].sort(),
      annual_count: annual.size,
      quarter_periods: [...quarters].sort(),
      quarter_count: quarters.size,
      required_metrics_verified_pct: requiredTotal ? Number((requiredVerified / requiredTotal).toFixed(2)) : 0,
      missing_metrics: missing,
      source_mix: sourceMix,
      source_issues: reasons,
      adapter: company.adapter,
      next_action: company.next_action,
    };
  });
}

function sourceFamily(row = {}) {
  if (/profile/i.test(row.source_form || row.source_title || row.source_file || '')) return 'profile_candidate';
  if (/SEC|companyfacts|10-K|10-Q|20-F|6-K/i.test(`${row.source_title || ''} ${row.source_form || ''}`)) return 'SEC';
  if (/IR|annual report|investor/i.test(row.source_title || '')) return 'IR';
  return null;
}

function missingReasons(company, rows) {
  const reasons = [];
  if (!rows.length) reasons.push(company.adapter?.includes('dart') ? 'MOPS/DART 未接入或 IR PDF 未解析' : 'SEC companyfacts 无可用 verified 行或公司非 SEC filer');
  if (/company_ir_pdf|ir_pdf|annual_report/i.test(company.adapter || '')) reasons.push('IR PDF 未解析');
  if (/mops/i.test(company.adapter || '')) reasons.push('MOPS 未接入');
  if (/dart/i.test(company.adapter || '')) reasons.push('DART 未接入');
  if (rows.length && rows.some((row) => !row.unit)) reasons.push('单位/币种不明确');
  if (!rows.some((row) => /segment/i.test(row.metric))) reasons.push('segment data 缺失');
  return [...new Set(reasons)];
}

function displayFor(metric = {}, value, unit = '') {
  if (metric.type === 'percent') return `${Number(value).toFixed(1)}%`;
  if (metric.type === 'per_share') return perShare(value, unit);
  if (/shares/i.test(unit)) return `${(value / 100000000).toFixed(2)}亿股`;
  return amountDisplay(value, unit);
}

function amountDisplay(value, unit = '') {
  const currency = normalizeUnit(unit);
  const abs = Math.abs(Number(value));
  const sign = Number(value) < 0 ? '-' : '';
  if (currency === 'USD') return `${sign}${(abs / 100000000).toFixed(1)}亿美元`;
  if (currency === 'EUR') return `${sign}${(abs / 100000000).toFixed(1)}亿欧元`;
  if (currency === 'CNY') return `${sign}${(abs / 100000000).toFixed(1)}亿元人民币`;
  if (currency === 'TWD') return `${sign}${(abs / 100000000).toFixed(1)}亿新台币`;
  if (currency === 'KRW') return abs >= 1000000000000 ? `${sign}${(abs / 1000000000000).toFixed(2)}万亿韩元` : `${sign}${(abs / 100000000).toFixed(1)}亿韩元`;
  return `${sign}${abs.toLocaleString('zh-CN')} ${currency || '单位待核验'}`;
}

function perShare(value, unit = '') {
  const currency = normalizeUnit(unit).replace('/share', '');
  if (currency === 'USD') return `$${Number(value).toFixed(2)}/股`;
  if (currency === 'EUR') return `€${Number(value).toFixed(2)}/股`;
  return `${Number(value).toFixed(2)} ${currency || '单位待核验'}/股`;
}

function normalizeUnit(unit = '') {
  const text = String(unit || '').toUpperCase();
  if (text.includes('USD')) return text.includes('SHARE') ? 'USD/share' : 'USD';
  if (text.includes('EUR')) return text.includes('SHARE') ? 'EUR/share' : 'EUR';
  if (text.includes('CNY') || text.includes('RMB')) return 'CNY';
  if (text.includes('TWD') || text.includes('NTD')) return 'TWD';
  if (text.includes('KRW')) return 'KRW';
  if (text.includes('SHARE')) return 'shares';
  return text || null;
}

function sameCurrency(left, right) {
  return normalizeUnit(left) === normalizeUnit(right);
}

function isDisplayMismatch(metric = {}, display = '') {
  if (metric.type === 'amount' && /%/.test(display)) return true;
  if (metric.type === 'percent' && !/%/.test(display)) return true;
  if (metric.type !== 'percent' && /^[+-]?\d+(?:\.\d+)?$/.test(display)) return true;
  return false;
}

function dedupeRows(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = `${tickerKey(row.ticker)}|${row.metric}|${row.period_label}|${row.period_type || ''}`;
    const existing = map.get(key);
    map.set(key, existing ? betterFinancialRow(existing, row) : row);
  }
  return [...map.values()];
}

function betterFinancialRow(left, right) {
  return financialRowScore(right) > financialRowScore(left) ? right : left;
}

function financialRowScore(row = {}) {
  const source = `${row.source_title || ''} ${row.source_form || ''} ${row.source_file || ''} ${row.source_metric_label || ''}`;
  let score = 0;
  if (/SEC|companyfacts|10-K|10-Q|20-F|6-K/i.test(source)) score += 80;
  if (/IR|annual report|investor|earnings/i.test(source)) score += 60;
  if (/profile/i.test(source)) score += 30;
  if (row.derived) score += /SEC|companyfacts/i.test(source) ? 70 : 20;
  if (row.confidence === 'high') score += 10;
  if (row.confidence === 'medium') score += 5;
  if (row.metric === 'capex' && (Number(row.value) < 0 || /^-/.test(String(row.display || '')))) score -= 1000;
  if (row.metric === 'capex' && /^-/.test(String(row.source_raw_value || '').trim())) score -= 500;
  if ((row.metric === 'gross_margin' || row.metric === 'operating_margin') && Math.abs(Number(row.value)) > 100) score -= 200;
  if (row.metric === 'cash' && /(NetCashProvided|Operating Cash Flow|经营活动现金流|经营现金流|OCF)/i.test(source)) score -= 1000;
  if (row.metric === 'operating_cash_flow' && /(CashAndCashEquivalents|现金及等价物|现金及短期投资|cash equivalents)/i.test(source)) score -= 1000;
  if (row.metric === 'capex' && /机械设备|厂房设施|厂房|设施|equipment|facility|building/i.test(source)) score -= 500;
  if (!row.display || !row.source_title || !row.source_url) score -= 100;
  return score;
}

function sortFinancialRows(a, b) {
  return tickerKey(a.ticker).localeCompare(tickerKey(b.ticker)) || metricRank(a.metric) - metricRank(b.metric) || String(a.period_label).localeCompare(String(b.period_label));
}

function metricRank(metric) {
  const index = METRICS.findIndex((item) => item.key === metric);
  return index === -1 ? METRICS.length : index;
}

function tickerKey(value = '') {
  return String(value || '').toUpperCase().replace(/\.(O|N|US|DF)$/i, '').replace(/[^A-Z0-9]/g, '');
}

if (process.argv[1] === __filename) {
  normalizeFinancialHistory().catch((error) => {
    console.error(error.message);
    process.exitCode = 0;
  });
}
