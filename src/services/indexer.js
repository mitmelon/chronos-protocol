'use strict';
/**
 * src/services/indexer.js
 *
 * The contract is the source of truth for who staked what. This module copies that truth into MongoDB so the
 * dashboard, "My positions", per-question stats and the home page all have data to show.
 *
 *   recordTransaction(txHash)   called right after a user's buy: the dashboard updates in the same second
 *   runIndexer()                background catch-up from a saved block cursor: finds everything else, from any app
 *
 * Both go through ingest(), which is idempotent (keyed by txHash + logIndex), so an event is never counted twice.
 * After ingesting, positions and market pools are re-read FROM THE CHAIN, never computed from the events, so they cannot drift.
 */

const { acquireLock, releaseLock, pushCapped, shortMessage } = require('../agent/lib');

/** Only what the indexer needs (so it never pulls in the queue or AI modules). */
function resolveDeps(o = {}) {
  return { db: o.db || require('../db/client').db, contract: o.contract || require('./contract'), now: o.now || (() => Date.now()) };
}

const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const lower = (a) => String(a).toLowerCase();
const CHUNK = 5000;
const MAX_CHUNKS_PER_RUN = 20;

/** A position id a person can quote: market id plus the first bytes of the transaction (a market can have many). */
const positionId = (e) => `${e.marketId}-${e.txHash.slice(2, 10).toUpperCase()}${e.logIndex ? '-' + e.logIndex : ''}`;

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/** Re-read one market from the chain and store pools, state and live stake statistics. */
async function refreshMarket(deps, marketId) {
  const database = deps.db();
  const m = await deps.contract.getMarket(marketId);
  const trades = await database.collection('trades').find({ marketId, type: 'buy' }, { projection: { user: 1 } }).toArray();
  const deadline = m.tradingDeadline.getTime();
  const state = m.state === 'Open' && deps.now() >= deadline + 5000 ? 'TradingClosed' : m.state;
  await database.collection('predictions').updateOne({ marketId }, {
    $set: { yesPool: m.yesPool, noPool: m.noPool, totalPool: m.totalPool, state, chainState: m.state, outcome: m.outcome, tradeCount: trades.length, stakerCount: new Set(trades.map((t) => t.user)).size, statsUpdatedAt: new Date(deps.now()) },
    $setOnInsert: { question: m.question, resolutionCriteria: m.resolutionCriteria, tradingDeadline: m.tradingDeadline, resolutionDeadline: m.resolutionDeadline, createdAt: new Date(deps.now()), category: 'Other', tags: [] },
  }, { upsert: true });
  return m;
}

/** Re-read one participant's position in one market from the chain. */
async function refreshPosition(deps, marketId, user) {
  const database = deps.db();
  const [shares, claimed, market] = await Promise.all([deps.contract.getShares(marketId, user), deps.contract.isClaimed(marketId, user), database.collection('predictions').findOne({ marketId })]);
  const yes = BigInt(shares.yesAmt), no = BigInt(shares.noAmt);
  await database.collection('positions').updateOne({ address: lower(user), marketId }, {
    $set: { yesShares: yes.toString(), noShares: no.toString(), totalStaked: (yes + no).toString(), claimed: !!claimed, question: market?.question || null, category: market?.category || null, updatedAt: new Date(deps.now()) },
    $setOnInsert: { createdAt: new Date(deps.now()) },
  }, { upsert: true });
}

/** Store events, then refresh every position and market they touched. Returns the NEW buy trades. */
async function ingest(deps, events) {
  const trades = deps.db().collection('trades');
  const fresh = [];
  for (const e of events) {
    const doc = { type: e.type, marketId: e.marketId, user: lower(e.user), amount: e.amount, outcome: e.outcome ?? null, stake: e.stake ?? null, profit: e.profit ?? null, fee: e.fee ?? null, txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, positionId: e.type === 'buy' ? positionId(e) : null };
    const r = await trades.updateOne({ txHash: e.txHash, logIndex: e.logIndex }, { $setOnInsert: { ...doc, createdAt: new Date(deps.now()) } }, { upsert: true });
    if (r.upsertedCount === 1 || r.upsertedId) fresh.push(doc);
  }
  const markets = new Set(events.map((e) => e.marketId));
  const pairs = new Map(events.map((e) => [`${e.marketId}:${lower(e.user)}`, e]));
  await mapLimit([...pairs.values()], 6, (e) => refreshPosition(deps, e.marketId, e.user));
  await mapLimit([...markets], 4, (id) => refreshMarket(deps, id));
  return fresh;
}

/** Called by the API right after a user's transaction. Safe to call repeatedly and for any hash. */
async function recordTransaction(txHash, overrides = {}) {
  if (!TX_RE.test(String(txHash))) throw Object.assign(new Error('Invalid transaction hash'), { statusCode: 400 });
  const deps = resolveDeps(overrides);
  const events = await deps.contract.getPositionEventsForTx(txHash);
  if (!events.length) return { positions: [], note: 'No Chronos position found in that transaction' };
  await ingest(deps, events);
  const database = deps.db();
  const out = [];
  for (const e of events.filter((x) => x.type === 'buy')) {
    const m = await database.collection('predictions').findOne({ marketId: e.marketId });
    out.push({ positionId: positionId(e), marketId: e.marketId, outcome: e.outcome === 1 ? 'YES' : 'NO', amount: e.amount, address: lower(e.user), txHash: e.txHash, question: m?.question || null });
  }
  return { positions: out };
}

/** Background catch-up. Resumes from a saved cursor; the first run starts near the oldest known market. */
async function runIndexer(overrides = {}) {
  const deps = resolveDeps(overrides);
  const database = deps.db();
  const state = database.collection('indexerState');
  const owner = await acquireLock(database, 'indexer', 10 * 60 * 1000);
  if (!owner) return { status: 'in_progress', events: 0 };
  const out = { status: 'ok', events: 0, fresh: 0, from: null, to: null, errors: [] };
  try {
    const latest = Number(await deps.contract.getBlockNumber());
    const cursor = await state.findOne({ _id: 'positions' });
    let from;
    if (cursor) from = cursor.block + 1;
    else {
      const oldest = await database.collection('predictions').find({ createBlock: { $gt: 0 } }).toArray();
      from = oldest.length ? Math.min(...oldest.map((p) => p.createBlock)) : Math.max(0, latest - 50000);
    }
    out.from = from;
    let chunk = CHUNK;
    for (let n = 0; from <= latest && n < MAX_CHUNKS_PER_RUN;) {
      const to = Math.min(latest, from + chunk - 1);
      try {
        const events = await deps.contract.getPositionEvents(from, to);
        if (events.length) { out.events += events.length; out.fresh += (await ingest(deps, events)).length; }
        await state.updateOne({ _id: 'positions' }, { $set: { block: to, updatedAt: new Date(deps.now()) } }, { upsert: true });
        out.to = to; from = to + 1; n++;
      } catch (err) {
        if (chunk > 200) { chunk = Math.floor(chunk / 2); continue; } // the RPC rejected the range: try a smaller one
        pushCapped(out.errors, shortMessage(err)); out.status = 'failed'; break;
      }
    }
    return out;
  } finally { await releaseLock(database, 'indexer', owner); }
}

module.exports = { recordTransaction, runIndexer, ingest, refreshMarket, refreshPosition, positionId };
