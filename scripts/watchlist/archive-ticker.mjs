import { parseArgs, updateWatchlistItem } from './common.mjs';

async function main() {
  const { ticker } = parseArgs();
  if (!ticker) throw new Error('Usage: npm run watchlist:archive -- TICKER');
  const item = await updateWatchlistItem(ticker, () => ({
    status: 'archived',
    is_holding: false,
    updated_at: new Date().toISOString().slice(0, 10),
  }));
  console.log(`Watchlist ticker archived: ${item.ticker}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
