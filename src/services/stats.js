'use strict';
/** Protocol-wide numbers for the home page and dashboard. TVL is read from the chain; everything else from the indexed database. */
const sum = (rows, f) => rows.reduce((t, r) => t + BigInt(f(r) || '0'), 0n);

async function computeStats(deps) {
  const database = deps.db();
  const markets = await database.collection('predictions').find({ marketId: { $ne: null } }, { projection: { state: 1, totalPool: 1 } }).toArray();
  const trades = await database.collection('trades').find({}, { projection: { type: 1, user: 1, amount: 1 } }).toArray();
  const by = (states) => markets.filter((m) => states.includes(m.state));
  let tvl = null;
  try { tvl = await deps.contract.getTvl(); } catch { /* chain briefly unreachable: leave TVL out rather than guess */ }
  return {
    tvlUsdc: tvl,                                                              // USDC held by the contract right now
    totalStakedUsdc: sum(markets, (m) => m.totalPool).toString(),              // all-time staked across every market
    activeStakedUsdc: sum(by(['Open', 'TradingClosed']), (m) => m.totalPool).toString(), // staked in markets not yet settled
    resolvedStakedUsdc: sum(by(['Resolved']), (m) => m.totalPool).toString(),
    paidToWinnersUsdc: sum(trades.filter((t) => t.type === 'winnings'), (t) => t.amount).toString(),
    refundedUsdc: sum(trades.filter((t) => t.type === 'refund'), (t) => t.amount).toString(),
    markets: markets.length, openMarkets: by(['Open']).length, awaitingResolution: by(['TradingClosed']).length,
    resolvedMarkets: by(['Resolved']).length, refundedMarkets: by(['Refundable']).length,
    stakers: new Set(trades.filter((t) => t.type === 'buy').map((t) => t.user)).size,
    positions: trades.filter((t) => t.type === 'buy').length,
    updatedAt: new Date().toISOString(),
  };
}

let cache = { at: 0, value: null };
/** 15-second cache so a busy home page does not hammer the database and the RPC. */
async function getStats(deps, ttlMs = 15000) {
  if (cache.value && Date.now() - cache.at < ttlMs) return cache.value;
  cache = { at: Date.now(), value: await computeStats(deps) };
  return cache.value;
}
const clearStatsCache = () => { cache = { at: 0, value: null }; };

module.exports = { computeStats, getStats, clearStatsCache };
