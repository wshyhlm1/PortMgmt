import path from 'node:path';
import { PATHS, readJson } from '../shared.mjs';
import {
  appendEnrichmentError,
  reportDateFromConfig,
  writeCandidatePayload,
  writeRawPayload,
} from './common.mjs';

const SEC_CIKS = {
  'ASML.O': '0000937966',
  'AVGO.O': '0001730168',
  'BABA.N': '0001577552',
  'BB.N': '0001070235',
  'CIEN.N': '0000936395',
  'GFS.O': '0001709048',
  'GOOGL.O': '0001652044',
  'IBM.N': '0000051143',
  'NOK.N': '0000924613',
  'QCOM.O': '0000804328',
  'TSM.N': '0001046179',
};

const FINANCIAL_TAGS = [
  { field: 'revenue', tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'] },
  { field: 'net_income', tags: ['NetIncomeLoss', 'ProfitLoss'] },
  { field: 'EPS', tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'] },
  { field: 'FCF', tags: ['NetCashProvidedByUsedInOperatingActivities'] },
  { field: 'capex', tags: ['PaymentsToAcquirePropertyPlantAndEquipment', 'CapitalExpenditures'] },
  { field: 'cash', tags: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'] },
  { field: 'debt', tags: ['LongTermDebtAndFinanceLeaseObligationsCurrent', 'LongTermDebtCurrent', 'LongTermDebtNoncurrent'] },
  { field: 'shares_outstanding', tags: ['CommonStocksIncludingAdditionalPaidInCapital', 'EntityCommonStockSharesOutstanding'] },
];

async function main() {
  const config = await readJson(PATHS.config, {});
  const reportDate = reportDateFromConfig(config);
  const rows = [];
  const raw = [];
  for (const item of config.tracked || []) {
    const cik = SEC_CIKS[item.ticker];
    if (!cik) continue;
    const result = await fetchSecCompanyFacts(item, cik);
    raw.push(result.rawMeta);
    rows.push(...result.rows);
  }
  await writeRawPayload('financials', `sec_companyfacts_${reportDate}`, {
    report_date: reportDate,
    sources: raw,
  });
  await writeCandidatePayload('financials', `financials_${reportDate}`, rows, {
    source_note: 'SEC companyfacts candidates; non-SEC markets stay as gaps until official local filings adapters are added.',
  });
  console.log(`Financial enrichment wrote ${rows.length} SEC candidates.`);
}

async function fetchSecCompanyFacts(company, cik) {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'PortMgmt enrichment/0.1 aimee@example.local',
        accept: 'application/json',
      },
    });
    const payload = await response.json();
    const rows = extractFinancialRows(company, cik, payload, url);
    return {
      rawMeta: {
        ticker: company.ticker,
        cik,
        source_url: url,
        status: response.status,
        ok: response.ok,
        fetched_at: new Date().toISOString(),
        facts: rows.length,
      },
      rows,
    };
  } catch (error) {
    await appendEnrichmentError({ type: 'financials', ticker: company.ticker, source_url: url, message: error.message });
    return {
      rawMeta: { ticker: company.ticker, cik, source_url: url, ok: false, error: error.message },
      rows: [],
    };
  }
}

function extractFinancialRows(company, cik, payload, sourceUrl) {
  const facts = payload?.facts?.['us-gaap'] || {};
  const rows = [];
  for (const metric of FINANCIAL_TAGS) {
    const tag = metric.tags.find((candidate) => facts[candidate]?.units);
    if (!tag) continue;
    const units = facts[tag].units || {};
    const unitName = Object.keys(units)[0];
    const filings = (units[unitName] || [])
      .filter((item) => item.val !== undefined && item.end && item.form)
      .filter((item) => /10-K|10-Q|20-F|40-F|6-K/.test(item.form))
      .sort((a, b) => String(b.filed || b.end).localeCompare(String(a.filed || a.end)))
      .slice(0, 4);
    for (const filing of filings) {
      rows.push({
        ticker: company.ticker,
        company: company.company_name,
        field: metric.field,
        period: filing.end,
        fiscal_year: filing.fy || null,
        fiscal_quarter: filing.fp || null,
        value: String(filing.val),
        unit: normalizeUnit(unitName),
        source_title: `SEC companyfacts ${tag}`,
        source_url: sourceUrl,
        as_of: filing.filed || filing.end,
        confidence: 'high',
        cik,
        form: filing.form,
      });
    }
  }
  return rows;
}

function normalizeUnit(unit = '') {
  if (unit === 'USD') return 'USD';
  if (unit === 'USD/shares') return 'USD/share';
  if (unit === 'shares') return 'shares';
  return unit || 'unit';
}

main().catch(async (error) => {
  await appendEnrichmentError({ type: 'financials', message: error.message });
  console.error(error.message);
  process.exitCode = 0;
});
