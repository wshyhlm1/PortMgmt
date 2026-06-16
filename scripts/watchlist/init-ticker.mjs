import path from 'node:path';
import { PATHS } from '../shared.mjs';
import {
  aaoiResearchPrompt,
  normalizeTicker,
  parseArgs,
  updateWatchlistItem,
  writeTextFile,
} from './common.mjs';

async function main() {
  const { ticker } = parseArgs();
  if (!ticker) throw new Error('Usage: npm run watchlist:init -- TICKER');
  const taskDir = path.join(PATHS.data, 'watchlist_tasks');
  const researchPrompt = ticker === 'AAOI' ? aaoiResearchPrompt() : genericResearchPrompt(ticker);
  await writeTextFile(path.join(taskDir, `${ticker}_research_prompt.md`), researchPrompt);
  await writeTextFile(path.join(taskDir, `${ticker}_init_task.md`), initTaskText(ticker));
  await updateWatchlistItem(ticker, (item, config) => ({
    init_status: item.init_status === 'verified' ? 'verified' : 'pending',
    updated_at: new Date().toISOString().slice(0, 10),
    notes: item.notes || '已生成初始化任务，等待 profile candidate。',
  }));
  console.log(`Watchlist init task written for ${ticker}: data/watchlist_tasks/${ticker}_research_prompt.md`);
}

function genericResearchPrompt(ticker) {
  const clean = normalizeTicker(ticker);
  return `你是资料库研究 AI。请为 PortMgmt 新增关注标的 ${clean} 搜集基础资料，并只输出严格 JSON。必须包含 ticker、company_name、exchange、sector_tags、source_url 或 IR URL、recent_filings、core_positioning、missing_fields、sources。无法确认的数据填 null，不要编造。`;
}

function initTaskText(ticker) {
  return `# ${ticker} 初始化任务

1. 将研究结果保存为 data/watchlist_candidates/${ticker}_profile_candidate.json。
2. 运行 npm run watchlist:validate -- ${ticker}。
3. 校验通过后可运行 npm run watchlist:promote -- ${ticker} 纳入持仓。
`;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
