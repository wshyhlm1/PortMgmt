import path from 'node:path';
import {
  PATHS,
  ensureDir,
  pathExists,
  readJson,
  todayInZone,
  writeJson,
} from './shared.mjs';

const EASTMONEY_FIELDS = 'f43,f57,f58,f60,f116,f162,f167,f170,f171,f152';
const EASTMONEY_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

async function main() {
  const config = await readJson(PATHS.config, {});
  const args = parseArgs(process.argv.slice(2));
  const reportDate = args.date || todayInZone(config.report_timezone || process.env.REPORT_TZ || 'Asia/Shanghai');
  const runStartedAt = new Date().toISOString();
  const tracked = config.tracked || config.tickers || [];
  const marketConfig = config.market || {};
  const benchmarkTickers = marketConfig.benchmarks || config.benchmark_tickers || config.benchmarkTickers || ['QQQ'];
  const mag7Tickers = marketConfig.mag7 || config.mag7_tickers || config.mag7Tickers || ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA'];
  const requests = [
    ...tracked.map((item) => ({
      displayTicker: item.display_ticker || item.displayTicker || item.ticker,
      portfolioTicker: item.ticker,
      symbol: item.yfinance_ticker || item.yfinanceTicker || item.display_ticker || item.ticker,
    })),
    ...benchmarkTickers.map((symbol) => ({ displayTicker: symbol, portfolioTicker: symbol, symbol, role: 'benchmark' })),
    ...mag7Tickers.map((symbol) => ({ displayTicker: symbol, portfolioTicker: symbol, symbol, role: 'mag7' })),
  ];
  const unique = dedupeBy(requests.filter((item) => item.symbol), (item) => item.symbol);
  const fetched = {};
  const warnings = [];
  for (const item of unique) {
    try {
      fetched[item.symbol] = await fetchMarketQuote(item.symbol, reportDate);
      fetched[item.symbol].updatedAt = runStartedAt;
    } catch (error) {
      warnings.push(`${item.symbol}: ${error.message}`);
      fetched[item.symbol] = missingQuote(item.symbol, error.message);
      fetched[item.symbol].updatedAt = runStartedAt;
    }
  }

  const qqq = fetched.QQQ;
  const mag7Average = {
    return1d: average(mag7Tickers.map((symbol) => fetched[symbol]?.return1d)),
    return5d: average(mag7Tickers.map((symbol) => fetched[symbol]?.return5d)),
    return20d: average(mag7Tickers.map((symbol) => fetched[symbol]?.return20d)),
  };
  const tickers = {};
  for (const item of requests) {
    const quote = enrichRelative({ ...(fetched[item.symbol] || missingQuote(item.symbol, 'not fetched')) }, qqq, mag7Average);
    quote.displayTicker = item.displayTicker;
    quote.portfolioTicker = item.portfolioTicker;
    quote.role = item.role || 'holding';
    tickers[item.symbol] = quote;
    if (item.displayTicker) tickers[item.displayTicker] = quote;
    if (item.portfolioTicker) tickers[item.portfolioTicker] = quote;
  }
  const out = {
    asOf: reportDate,
    updatedAt: runStartedAt,
    source: 'eastmoney_push2+yahoo_stooq_fallback',
    provider: 'Eastmoney push2 quote/kline with Yahoo Finance and Stooq fallback',
    benchmarks: {
      qqq: qqq || null,
      mag7_average: mag7Average,
      mag7_tickers: mag7Tickers,
    },
    tickers,
    warnings,
    notes: [
      'Eastmoney push2 stock/get and push2his kline are attempted first for quote, market cap and returns.',
      'Yahoo chart/page fallback is used when Eastmoney cannot resolve a ticker or lacks market coverage.',
      'Stooq daily CSV fallback is used for price returns when Yahoo is unavailable.',
      'Forward valuation fields are left blank unless a reliable public endpoint returns them.',
      'Renderer reads this cache only and never calls the network.',
    ],
  };
  await Promise.all([ensureDir(PATHS.marketCache), ensureDir(PATHS.market)]);
  await writeJson(path.join(PATHS.marketCache, `${reportDate}.json`), out);
  await writeJson(path.join(PATHS.market, `${reportDate}.json`), out);
  if (args.live) {
    await writeLiveMarketJson({
      reportDate,
      runStartedAt,
      requests,
      tracked,
      benchmarkTickers,
      mag7Tickers,
      market: out,
      warnings,
    });
  }
  await writeJson(path.join(PATHS.data, 'adapters.json'), {
    updated_at: new Date().toISOString(),
    price: {
      status: warnings.length ? 'partial' : 'ok',
      provider: 'eastmoney_push2+yahoo_stooq_fallback',
      message: warnings.length ? `行情缓存生成完成，但有 ${warnings.length} 个缺口。` : '行情缓存生成完成。',
    },
    news: {
      status: 'local_event_builder',
      provider: 'profile+obsidian+supplemental_json',
      message: '新闻/公告由本地结构化事件构建器生成，缺原始来源的候选不进入页面事件表。',
    },
    event_classification: {
      status: 'active',
      message: '事件必须匹配股票池且落在报告日前 7 日窗口。',
    },
  });
  console.log(`Market cache written: data/market_cache/${reportDate}.json (${Object.keys(tickers).length} keys)`);
  if (args.live) console.log('Live market JSON written: data/market_live/latest.json and portfolio_reports/market_live.json');
}

async function fetchMarketQuote(symbol, reportDate) {
  const attempts = [];
  try {
    const quote = await fetchEastmoneyQuote(symbol, reportDate);
    return quote;
  } catch (error) {
    attempts.push(`eastmoney_push2: ${error.message}`);
  }
  try {
    const chartQuote = await fetchYahooChart(symbol, reportDate);
    const pageQuote = await fetchYahooQuotePage(symbol);
    let merged = mergeQuoteData(chartQuote, pageQuote);
    if (!merged.marketCap && /^\d{6}\.KS$/i.test(symbol)) {
      try {
        const naverQuote = await fetchNaverKoreaQuote(symbol);
        merged = mergeQuoteData(merged, naverQuote);
      } catch (naverError) {
        merged.source_attempts = [...(merged.source_attempts || []), `naver_stock: ${naverError.message}`];
        merged.warnings = [...(merged.warnings || []), `Naver stock fallback failed: ${naverError.message}`];
      }
    }
    merged.source_attempts = [...attempts, ...(merged.source_attempts || [])];
    return merged;
  } catch (error) {
    attempts.push(`yahoo_fallback: ${error.message}`);
  }
  try {
    const stooqQuote = await fetchStooqQuote(symbol, reportDate);
    stooqQuote.source_attempts = [...attempts, ...(stooqQuote.source_attempts || [])];
    return stooqQuote;
  } catch (error) {
    throw new Error([...attempts, `stooq_fallback: ${error.message}`].join('; '));
  }
}

async function fetchNaverKoreaQuote(symbol) {
  const code = String(symbol || '').match(/^(\d{6})\.KS$/i)?.[1];
  if (!code) return { source_attempts: ['naver_stock: unsupported symbol'], warnings: [] };
  const url = `https://m.stock.naver.com/api/stock/${code}/integration`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 PortMgmt/0.1',
      'accept': 'application/json,text/plain,*/*',
    },
  });
  if (!response.ok) return { source: 'naver_stock', source_attempts: [`naver_stock: HTTP ${response.status}`], warnings: [`Naver stock HTTP ${response.status}`] };
  const payload = await response.json();
  const totalInfos = Array.isArray(payload.totalInfos) ? payload.totalInfos : [];
  const marketValueText = totalInfos.find((item) => item.code === 'marketValue' || item.key === '시총')?.value || null;
  const marketCap = parseKoreanMarketCap(marketValueText);
  return {
    marketCap,
    marketCapDisplay: marketCap ? `${formatMarketCap(marketCap)} KRW` : null,
    source: 'naver_stock',
    source_attempts: ['naver_stock: ok'],
    warnings: marketCap ? [] : ['marketCap missing from Naver stock endpoint'],
  };
}

async function fetchEastmoneyQuote(symbol, reportDate) {
  const secidCandidates = eastmoneySecidCandidates(symbol);
  const errors = [];
  for (const secid of secidCandidates) {
    try {
      const realtime = await fetchEastmoneyRealtime(secid);
      const kline = await fetchEastmoneyKline(secid, reportDate);
      const closes = kline.map((row) => row.close).filter((value) => typeof value === 'number' && Number.isFinite(value));
      if (!realtime || !closes.length) throw new Error('empty Eastmoney quote/kline');
      const price = realtime.price ?? closes.at(-1);
      const ytdIndex = firstTradingIndexOfYear(kline.map((row) => row.date), reportDate);
      return {
        symbol,
        eastmoneySecid: secid,
        price: round(price),
        previousClose: realtime.previousClose ?? (closes.length > 1 ? round(closes.at(-2)) : null),
        currency: null,
        marketCap: realtime.marketCap,
        marketCapDisplay: formatMarketCap(realtime.marketCap),
        peTrailing: realtime.peTrailing,
        peForward: null,
        psTrailing: null,
        beta: null,
        fiftyTwoWeekHigh: round(max(closes)),
        fiftyTwoWeekLow: round(min(closes)),
        return1d: returnAt(closes, 1),
        return5d: returnAt(closes, 5),
        return20d: returnAt(closes, 20),
        returnYtd: ytdIndex === null ? null : pct(closes.at(-1), closes[ytdIndex]),
        relativeToQQQ1d: null,
        relativeToQQQ5d: null,
        relativeToQQQ20d: null,
        relativeToMAG71d: null,
        relativeToMAG75d: null,
        source: 'eastmoney_push2',
        dataQuality: price ? 'ok' : 'missing',
        source_attempts: [`eastmoney_push2 ${secid}: ok`],
        warnings: [],
      };
    } catch (error) {
      errors.push(`${secid}: ${error.message}`);
    }
  }
  throw new Error(errors.join('; ') || 'no Eastmoney secid candidates');
}

async function fetchEastmoneyRealtime(secid) {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=${EASTMONEY_FIELDS}&ut=${EASTMONEY_UT}&fltt=2`;
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 PortMgmt/0.1' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const data = payload.data;
  if (!data || data.f43 === '-' || data.f43 == null) throw new Error('empty realtime data');
  return {
    price: normalizeEastmoneyNumber(data.f43),
    previousClose: normalizeEastmoneyNumber(data.f60),
    marketCap: normalizeEastmoneyNumber(data.f116),
    peTrailing: normalizeEastmoneyNumber(data.f162),
    pb: normalizeEastmoneyNumber(data.f167),
    pctChange: normalizeEastmoneyNumber(data.f170),
    name: data.f58 || null,
  };
}

async function fetchEastmoneyKline(secid, reportDate) {
  const beg = `${String(Number(reportDate.slice(0, 4)) - 1)}0101`;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=${beg}&end=20500101&ut=${EASTMONEY_UT}`;
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 PortMgmt/0.1' } });
  if (!response.ok) throw new Error(`kline HTTP ${response.status}`);
  const payload = await response.json();
  const rows = payload.data?.klines || [];
  const parsed = rows.map((line) => {
    const parts = String(line).split(',');
    return { date: parts[0], close: Number(parts[2]) };
  }).filter((row) => row.date && Number.isFinite(row.close));
  if (!parsed.length) throw new Error('empty kline data');
  return parsed;
}

function eastmoneySecidCandidates(symbol = '') {
  const clean = String(symbol || '').trim();
  const base = clean.replace(/\.(O|N|US|DF)$/i, '').toUpperCase();
  const candidates = [];
  if (/^\d{6}\.KS$/i.test(clean)) return [];
  if (/\.DE$/i.test(clean)) return [];
  if (/\.HK$/i.test(clean) || /^\d{4,5}$/.test(clean)) candidates.push(`116.${base.padStart(5, '0')}`);
  if (/\.SS$|\.SH$/i.test(clean) || /^6\d{5}$/.test(base)) candidates.push(`1.${base.replace(/\.(SS|SH)$/i, '')}`);
  if (/\.SZ$/i.test(clean) || /^[03]\d{5}$/.test(base)) candidates.push(`0.${base.replace(/\.SZ$/i, '')}`);
  if (/^[A-Z][A-Z0-9.-]{0,8}$/.test(base)) candidates.push(`105.${base}`);
  return [...new Set(candidates)];
}

async function fetchYahooChart(symbol, reportDate) {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=1y&interval=1d&events=history&includeAdjustedClose=true`;
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 PortMgmt/0.1' } });
  if (!response.ok) throw new Error(`Yahoo chart HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const error = payload.chart?.error;
  if (!result || error) throw new Error(error?.description || 'empty chart response');
  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
  const closes = (adj.length ? adj : quote.close || []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!closes.length) throw new Error('no close prices');
  const price = meta.regularMarketPrice ?? closes.at(-1);
  const previousClose = closes.length > 1 ? closes.at(-2) : (meta.previousClose ?? null);
  const timestamp = result.timestamp || [];
  const ytdIndex = firstTradingIndexOfYear(timestamp.map((item) => new Date(item * 1000).toISOString().slice(0, 10)), reportDate);
  return {
    symbol,
    price: round(price),
    previousClose: previousClose === null ? null : round(previousClose),
    currency: meta.currency || null,
    marketCap: null,
    marketCapDisplay: null,
    peTrailing: null,
    peForward: null,
    psTrailing: null,
    beta: null,
    fiftyTwoWeekHigh: round(max(closes)),
    fiftyTwoWeekLow: round(min(closes)),
    return1d: returnAt(closes, 1),
    return5d: returnAt(closes, 5),
    return20d: returnAt(closes, 20),
    returnYtd: ytdIndex === null ? null : pct(closes.at(-1), closes[ytdIndex]),
    relativeToQQQ1d: null,
    relativeToQQQ5d: null,
    relativeToQQQ20d: null,
    relativeToMAG71d: null,
    relativeToMAG75d: null,
    source: 'yahoo_chart',
    dataQuality: price ? 'partial' : 'missing',
    source_attempts: ['yahoo_chart: ok'],
    warnings: ['marketCap/PE/PS/beta unavailable from chart endpoint; quote page attempted separately'],
  };
}

async function fetchYahooQuotePage(symbol) {
  const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 PortMgmt/0.1' } });
  if (!response.ok) return { source_attempts: [`yahoo_quote_page: HTTP ${response.status}`], warnings: [`Yahoo quote page HTTP ${response.status}`] };
  const html = await response.text();
  const marketCapDisplay = extractDataField(html, 'marketCap');
  const marketCap = marketCapDisplay ? parseMarketCap(marketCapDisplay) : null;
  const peTrailing = parseNumber(extractDataField(html, 'trailingPE') || extractValueAfterTitle(html, 'PE Ratio (TTM)'));
  const beta = parseNumber(extractValueAfterTitle(html, 'Beta (5Y Monthly)'));
  return {
    marketCap,
    marketCapDisplay,
    peTrailing,
    beta,
    source_attempts: ['yahoo_quote_page: ok'],
    warnings: [
      !marketCapDisplay && 'marketCap missing from Yahoo quote page',
      !peTrailing && 'trailing PE missing from Yahoo quote page',
      !beta && 'beta missing from Yahoo quote page',
      'forward PE and PS unavailable from public quote page',
    ].filter(Boolean),
  };
}

async function fetchStooqQuote(symbol, reportDate) {
  const stooqSymbol = stooqTicker(symbol);
  if (!stooqSymbol) throw new Error('unsupported Stooq symbol');
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 PortMgmt/0.1' } });
  if (!response.ok) throw new Error(`Stooq HTTP ${response.status}`);
  const csv = await response.text();
  const rows = csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const [date, open, high, low, close] = line.split(',');
    return { date, close: Number(close) };
  }).filter((row) => row.date && Number.isFinite(row.close) && row.date <= reportDate);
  if (!rows.length) throw new Error('empty Stooq data');
  const closes = rows.map((row) => row.close);
  const ytdIndex = firstTradingIndexOfYear(rows.map((row) => row.date), reportDate);
  return {
    symbol,
    price: round(closes.at(-1)),
    previousClose: closes.length > 1 ? round(closes.at(-2)) : null,
    currency: null,
    marketCap: null,
    marketCapDisplay: null,
    peTrailing: null,
    peForward: null,
    psTrailing: null,
    beta: null,
    fiftyTwoWeekHigh: round(max(closes)),
    fiftyTwoWeekLow: round(min(closes)),
    return1d: returnAt(closes, 1),
    return5d: returnAt(closes, 5),
    return20d: returnAt(closes, 20),
    returnYtd: ytdIndex === null ? null : pct(closes.at(-1), closes[ytdIndex]),
    relativeToQQQ1d: null,
    relativeToQQQ5d: null,
    relativeToQQQ20d: null,
    relativeToMAG71d: null,
    relativeToMAG75d: null,
    source: 'stooq_daily_csv',
    dataQuality: 'partial',
    source_attempts: [`stooq_daily_csv ${stooqSymbol}: ok`],
    warnings: ['Stooq fallback does not provide market cap or valuation fields'],
  };
}

function mergeQuoteData(chartQuote, pageQuote) {
  const merged = {
    ...chartQuote,
    marketCap: pageQuote.marketCap ?? chartQuote.marketCap,
    marketCapDisplay: pageQuote.marketCapDisplay ?? chartQuote.marketCapDisplay,
    peTrailing: pageQuote.peTrailing ?? chartQuote.peTrailing,
    beta: pageQuote.beta ?? chartQuote.beta,
    source: [chartQuote.source, pageQuote.source || 'yahoo_quote_page'].filter(Boolean).join('+'),
    source_attempts: [...(chartQuote.source_attempts || []), ...(pageQuote.source_attempts || [])],
    warnings: [...(chartQuote.warnings || []), ...(pageQuote.warnings || [])],
  };
  const required = ['price', 'return1d', 'return20d', 'returnYtd', 'marketCap'];
  merged.dataQuality = required.every((field) => merged[field] !== null && merged[field] !== undefined) ? 'ok' : (merged.price ? 'partial' : 'missing');
  return merged;
}

async function writeLiveMarketJson({ reportDate, runStartedAt, requests, tracked, benchmarkTickers, mag7Tickers, market, warnings }) {
  const liveDataDir = path.join(PATHS.data, 'market_live');
  const liveDataPath = path.join(liveDataDir, 'latest.json');
  const liveReportPath = path.join(PATHS.reports, 'market_live.json');
  const quotes = dedupeBy(requests, (item) => item.portfolioTicker || item.displayTicker || item.symbol)
    .map((item) => liveQuoteFor(item, market.tickers?.[item.symbol] || market.tickers?.[item.portfolioTicker] || market.tickers?.[item.displayTicker]))
    .filter(Boolean);
  const holdingQuotes = tracked.map((item) => (
    market.tickers?.[item.yfinance_ticker || item.yfinanceTicker]
    || market.tickers?.[item.ticker]
    || market.tickers?.[item.display_ticker]
  )).filter(Boolean);
  const qqq = market.tickers?.QQQ || {};
  const mag7Average = market.benchmarks?.mag7_average || {};
  const portfolio1d = average(holdingQuotes.map((quote) => quote.return1d));
  const portfolio5d = average(holdingQuotes.map((quote) => quote.return5d));
  const payload = {
    as_of: runStartedAt,
    report_date: reportDate,
    source: market.source || 'eastmoney_push2+yahoo_stooq_fallback',
    portfolio: {
      return_1d_avg: portfolio1d,
      return_5d_avg: portfolio5d,
      qqq_return_1d: qqq.return1d ?? null,
      qqq_return_5d: qqq.return5d ?? null,
      mag7_return_1d_avg: mag7Average.return1d ?? null,
      mag7_return_5d_avg: mag7Average.return5d ?? null,
      relative_qqq_1d: diff(portfolio1d, qqq.return1d),
      relative_qqq_5d: diff(portfolio5d, qqq.return5d),
      relative_mag7_1d: diff(portfolio1d, mag7Average.return1d),
      relative_mag7_5d: diff(portfolio5d, mag7Average.return5d),
      benchmark_tickers: benchmarkTickers,
      mag7_tickers: mag7Tickers,
    },
    quotes,
    tickers: market.tickers || {},
    warnings,
    errors: warnings.map((message) => ({ message })),
  };
  const validQuotes = payload.quotes.filter((quote) => quote.price !== null && quote.price !== undefined);
  const previous = await readJson(liveDataPath, null);
  const finalPayload = validQuotes.length || !previous ? payload : {
    ...previous,
    as_of: runStartedAt,
    stale: true,
    errors: [
      ...(previous.errors || []),
      { message: '实时行情源全部失败，保留上一版缓存。' },
      ...payload.errors,
    ],
  };
  await Promise.all([ensureDir(liveDataDir), ensureDir(PATHS.reports)]);
  await writeJson(liveDataPath, finalPayload);
  await writeJson(liveReportPath, finalPayload);
}

function liveQuoteFor(item, quote = {}) {
  const ticker = item.portfolioTicker || item.displayTicker || item.symbol;
  if (!ticker) return null;
  return {
    ticker,
    display_ticker: item.displayTicker || ticker,
    symbol: item.symbol,
    role: item.role || 'holding',
    price: quote.price ?? null,
    market_cap: quote.marketCapDisplay ?? formatMarketCap(quote.marketCap),
    market_cap_value: quote.marketCap ?? null,
    return_1d: quote.return1d ?? null,
    return_5d: quote.return5d ?? null,
    return_20d: quote.return20d ?? null,
    return_ytd: quote.returnYtd ?? null,
    vs_qqq_1d: quote.relativeToQQQ1d ?? null,
    currency: quote.currency ?? null,
    source: quote.source || 'fallback',
    updated_at: quote.updatedAt || new Date().toISOString(),
    errors: quote.dataQuality === 'missing' ? quote.warnings || [] : [],
  };
}

function enrichRelative(quote, qqq, mag7Average) {
  if (typeof quote.return1d === 'number' && typeof qqq?.return1d === 'number') quote.relativeToQQQ1d = round(quote.return1d - qqq.return1d);
  if (typeof quote.return5d === 'number' && typeof qqq?.return5d === 'number') quote.relativeToQQQ5d = round(quote.return5d - qqq.return5d);
  if (typeof quote.return20d === 'number' && typeof qqq?.return20d === 'number') quote.relativeToQQQ20d = round(quote.return20d - qqq.return20d);
  if (typeof quote.return1d === 'number' && typeof mag7Average.return1d === 'number') quote.relativeToMAG71d = round(quote.return1d - mag7Average.return1d);
  if (typeof quote.return5d === 'number' && typeof mag7Average.return5d === 'number') quote.relativeToMAG75d = round(quote.return5d - mag7Average.return5d);
  return quote;
}

function extractDataField(html, field) {
  const match = html.match(new RegExp(`data-field="${field}"[^>]*>([^<]+)<`, 'i'));
  return match ? cleanHtmlText(match[1]) : null;
}

function extractValueAfterTitle(html, title) {
  const index = html.indexOf(`title="${title}"`);
  if (index === -1) return null;
  const snippet = html.slice(index, index + 800);
  const match = snippet.match(/<span class="value[^"]*">(?:<[^>]+>)*([^<]+)</i);
  return match ? cleanHtmlText(match[1]) : null;
}

function cleanHtmlText(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseNumber(value) {
  const clean = String(value || '').replace(/,/g, '');
  const match = clean.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseMarketCap(value) {
  const clean = String(value || '').replace(/,/g, '').trim();
  const match = clean.match(/^(-?\d+(?:\.\d+)?)([TMBK])?/i);
  if (!match) return null;
  const unit = (match[2] || '').toUpperCase();
  const factor = unit === 'T' ? 1e12 : unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
  return Math.round(Number(match[1]) * factor);
}

function parseKoreanMarketCap(value) {
  const clean = String(value || '').replace(/,/g, '').trim();
  if (!clean) return null;
  let total = 0;
  const trillion = clean.match(/(-?\d+(?:\.\d+)?)\s*조/);
  const hundredMillion = clean.match(/(-?\d+(?:\.\d+)?)\s*억/);
  const tenThousand = clean.match(/(-?\d+(?:\.\d+)?)\s*만/);
  if (trillion) total += Number(trillion[1]) * 1e12;
  if (hundredMillion) total += Number(hundredMillion[1]) * 1e8;
  if (tenThousand && !hundredMillion && !trillion) total += Number(tenThousand[1]) * 1e4;
  if (total) return Math.round(total);
  const numeric = Number(clean);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstTradingIndexOfYear(dates, reportDate) {
  const year = Number(String(reportDate).slice(0, 4));
  for (let index = 0; index < dates.length; index += 1) {
    if (String(dates[index]).slice(0, 4) === String(year)) return index;
  }
  return null;
}

function returnAt(values, periods) {
  if (values.length <= periods) return null;
  return pct(values.at(-1), values.at(-1 - periods));
}

function pct(current, previous) {
  if (!current || !previous) return null;
  return round(((current - previous) / previous) * 100);
}

function average(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!valid.length) return null;
  return round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

function round(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(2));
}

function normalizeEastmoneyNumber(value) {
  if (value === '-' || value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? round(number) : null;
}

function max(values) {
  return values.length ? Math.max(...values) : null;
}

function min(values) {
  return values.length ? Math.min(...values) : null;
}

function formatMarketCap(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const abs = Math.abs(Number(value));
  if (abs >= 1e12) return `${(Number(value) / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(Number(value) / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(Number(value) / 1e6).toFixed(2)}M`;
  return String(Math.round(Number(value)));
}

function missingQuote(symbol, message) {
  return {
    symbol,
    price: null,
    previousClose: null,
    currency: null,
    marketCap: null,
    marketCapDisplay: null,
    peTrailing: null,
    peForward: null,
    psTrailing: null,
    beta: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    return1d: null,
    return5d: null,
    return20d: null,
    returnYtd: null,
    relativeToQQQ1d: null,
    relativeToQQQ5d: null,
    relativeToQQQ20d: null,
    relativeToMAG71d: null,
    relativeToMAG75d: null,
    source: 'eastmoney_push2+yahoo_stooq_fallback',
    dataQuality: 'missing',
    source_attempts: [message],
    warnings: [message],
  };
}

function parseArgs(args = []) {
  const parsed = { live: false, date: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--live') {
      parsed.live = true;
      continue;
    }
    if (arg === '--date') {
      parsed.date = args[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg.startsWith('--date=')) {
      parsed.date = arg.slice('--date='.length);
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) parsed.date = arg;
  }
  return parsed;
}

function stooqTicker(symbol = '') {
  const clean = String(symbol || '').trim();
  if (!clean) return null;
  if (/^\d{6}\.KS$/i.test(clean)) return `${clean.slice(0, 6)}.kr`.toLowerCase();
  if (/\.DE$/i.test(clean)) return clean.toLowerCase();
  const base = clean.replace(/\.(O|N|US)$/i, '').toLowerCase();
  if (/^[a-z][a-z0-9.-]{0,8}$/i.test(base)) return `${base}.us`;
  return null;
}

function diff(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return round(a - b);
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
