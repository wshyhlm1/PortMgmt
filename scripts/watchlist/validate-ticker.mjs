import path from 'node:path';
import { PATHS, ensureDir, pathExists, readJson, writeJson } from '../shared.mjs';
import { normalizeTicker, parseArgs, updateWatchlistItem, writeTextFile } from './common.mjs';

async function main() {
  const { ticker } = parseArgs();
  if (!ticker) throw new Error('Usage: npm run watchlist:validate -- TICKER');
  const candidatePath = path.join(PATHS.data, 'watchlist_candidates', `${ticker}_profile_candidate.json`);
  if (!(await pathExists(candidatePath))) {
    await reject(ticker, 'candidate_missing', null);
    await mark(ticker, 'pending');
    console.log(`Watchlist candidate missing for ${ticker}; wrote rejected placeholder and kept init_status=pending.`);
    return;
  }
  const candidate = await readJson(candidatePath, null);
  const reason = rejectReason(candidate);
  if (reason) {
    await reject(ticker, reason, candidate);
    await mark(ticker, 'rejected');
    console.log(`Watchlist candidate rejected for ${ticker}: ${reason}`);
    return;
  }
  await accept(ticker, candidate);
  await mark(ticker, 'verified', candidate);
  console.log(`Watchlist candidate verified for ${ticker}.`);
}

function rejectReason(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return 'not_object';
  if (!candidate.ticker) return 'ticker_missing';
  if (!candidate.company_name) return 'company_name_missing';
  const basic = candidate.basic_info || {};
  if (!basic.exchange && !candidate.exchange) return 'exchange_missing';
  if (!Array.isArray(candidate.sector_tags) && !Array.isArray(basic.sector_tags)) return 'sector_tags_missing';
  if (!basic.ir_url && !candidate.ir_url && !basic.source_url && !candidate.source_url && !basic.website) return 'source_or_ir_missing';
  if (!Array.isArray(basic.recent_filings) && !Array.isArray(candidate.recent_filings)) return 'recent_filing_missing';
  if (!candidate.core_positioning) return 'core_positioning_missing';
  if (!Array.isArray(candidate.missing_fields)) return 'missing_fields_missing';
  return null;
}

async function reject(ticker, reason, candidate) {
  const dir = path.join(PATHS.data, 'watchlist_rejected');
  await ensureDir(dir);
  await writeJson(path.join(dir, `${ticker}.json`), {
    ticker,
    status: 'rejected',
    reason,
    checked_at: new Date().toISOString(),
    candidate,
  });
}

async function accept(ticker, candidate) {
  const dataDir = path.join(PATHS.data, 'companies');
  await ensureDir(dataDir);
  await writeJson(path.join(dataDir, `${ticker}.json`), candidate);
  const profile = profileMarkdown(candidate);
  await writeTextFile(path.join(PATHS.initial, `${ticker}_profile.md`), profile);
}

async function mark(ticker, initStatus, candidate = {}) {
  const basic = candidate.basic_info || {};
  await updateWatchlistItem(normalizeTicker(ticker), () => ({
    init_status: initStatus,
    updated_at: new Date().toISOString().slice(0, 10),
    exchange: candidate.exchange || basic.exchange,
    website: candidate.website || basic.website,
    ir_url: candidate.ir_url || basic.ir_url,
    source_url: candidate.source_url || basic.source_url,
    recent_filings: candidate.recent_filings || basic.recent_filings,
    core_positioning: candidate.core_positioning,
    missing_fields: candidate.missing_fields,
  }));
}

function profileMarkdown(candidate = {}) {
  return `# ${candidate.ticker} ${candidate.company_name}

## 基础信息
- 状态：watching
- 交易所：${candidate.exchange || candidate.basic_info?.exchange || '待补充'}
- 官网：${candidate.website || candidate.basic_info?.website || '待补充'}
- IR：${candidate.ir_url || candidate.basic_info?.ir_url || '待补充'}

## 核心卡位
${candidate.core_positioning || '待补充'}

## 缺失字段
${(candidate.missing_fields || []).map((item) => `- ${item}`).join('\n') || '- 待补充'}
`;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
