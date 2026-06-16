import {
  defaultWatchlistItem,
  ensureWatchlist,
  loadConfig,
  normalizeTicker,
  parseArgs,
  saveConfig,
} from './common.mjs';

async function main() {
  const { ticker, flags } = parseArgs();
  if (!ticker) throw new Error('Usage: npm run watchlist:add -- TICKER --status watching --priority medium');
  const config = await loadConfig();
  const list = ensureWatchlist(config);
  const existing = list.find((item) => normalizeTicker(item.ticker) === ticker);
  if (existing) {
    Object.assign(existing, {
      ...defaultWatchlistItem(ticker, flags, config),
      ...existing,
      status: flags.status || existing.status || 'watching',
      priority: flags.priority || existing.priority || 'medium',
      updated_at: defaultWatchlistItem(ticker, flags, config).updated_at,
    });
    await saveConfig(config);
    console.log(`Watchlist ticker already exists, updated metadata: ${ticker}`);
    return;
  }
  list.push(defaultWatchlistItem(ticker, flags, config));
  await saveConfig(config);
  console.log(`Watchlist ticker added: ${ticker}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
