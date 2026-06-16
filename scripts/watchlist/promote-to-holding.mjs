import { parseArgs, updateWatchlistItem } from './common.mjs';

async function main() {
  const { ticker } = parseArgs();
  if (!ticker) throw new Error('Usage: npm run watchlist:promote -- TICKER');
  const item = await updateWatchlistItem(ticker, () => ({
    status: 'holding',
    is_holding: true,
    updated_at: new Date().toISOString().slice(0, 10),
  }));
  console.log(`Watchlist ticker promoted to holding: ${item.ticker}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
