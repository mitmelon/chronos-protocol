'use strict';
/**
 * src/agent/publish.js
 *
 * The database is the source of truth for questions that are waiting to go on-chain.
 *
 *   approved by the agent -> saved as 'pending' -> published on-chain, ALL pending in ONE transaction -> 'created' (market is live)
 *
 * If the chain step fails for any reason (RPC down, gas too high, wallet empty), the questions simply stay 'pending' and
 * this function picks them up again on the next discovery run and on every keeper run, with backoff. Nothing is lost.
 *
 * Duplicate protection: a market is never created twice.
 *   - a broadcast transaction that was not confirmed is parked as 'unconfirmed' and looked up by hash before anything is resent
 *   - before sending, the most recent on-chain questions are compared with the pending ones
 *   - the keeper also adopts any market that appears on-chain with a pending question's text
 * Pending questions go stale: when too little trading time would remain, or the event has passed, they expire.
 */

const { resolveDeps } = require('./tools');
const { acquireLock, releaseLock, pushCapped, shortMessage } = require('./lib');
const guards = require('./guards');

const LOCK_TTL_MS = 10 * 60 * 1000;
const UNCONFIRMED_GRACE_MS = 30 * 60 * 1000;
const MAX_BATCH = 10; // contract limit (MAX_CREATE_BATCH)
const RECENT_ONCHAIN = 30;
const backoffMs = (attempts) => Math.min(2 * 3600 * 1000, 5 * 60 * 1000 * 2 ** Math.max(0, attempts - 1));
// Oldest first; ties (two questions approved in the same millisecond) keep the order they were saved in.
const byAge = (a, b) => new Date(a.createdAt) - new Date(b.createdAt) || (typeof a._id === 'number' ? a._id - b._id : String(a._id) < String(b._id) ? -1 : 1);
const norm = (q) => String(q).trim().toLowerCase().replace(/\s+/g, ' ');

async function publishPending(overrides = {}) {
  const deps = resolveDeps(overrides);
  const { config, contract, jobs } = deps;
  const A = config.agent;
  const s = guards.settings(config);
  const database = deps.db();
  const proposals = database.collection('marketProposals');
  const predictions = database.collection('predictions');
  const nowMs = deps.now();

  if (A.autoPublish === false) return { status: 'disabled', published: 0, pending: 0, errors: [] };
  const owner = await acquireLock(database, 'publish', LOCK_TTL_MS);
  if (!owner) return { status: 'in_progress', published: 0, pending: 0, errors: [] };

  const out = { status: 'ok', published: 0, adopted: 0, expired: 0, failed: 0, pending: 0, txHash: null, marketIds: [], errors: [] };

  /** Make a proposal a live market (idempotent: keyed by marketId). */
  async function activate(p, marketId, { txHash, blockNumber }) {
    const { _id, state, attempts, nextAttemptAt, lastError, batchTxHash, batchIndex, createdAt, updatedAt, ...meta } = p;
    await predictions.updateOne({ marketId }, { $set: { ...meta, marketId, createBlock: blockNumber ?? null, state: 'Open', outcome: 'UNRESOLVED', createTxHash: txHash, publishedAt: new Date(nowMs), updatedAt: new Date(nowMs) }, $setOnInsert: { createdAt: new Date(nowMs), yesPool: '0', noPool: '0', totalPool: '0' } }, { upsert: true });
    await proposals.updateOne({ _id }, { $set: { state: 'created', marketId, createTxHash: txHash, updatedAt: new Date(nowMs) } });
    try { await jobs.scheduleResolution(marketId, { dueAt: new Date(meta.eventDate).getTime() + s.settleDelay, deadlineAt: new Date(meta.resolutionDeadline).getTime() }); }
    catch (err) { console.warn(`[publish] could not schedule resolution for market ${marketId} (the sweeper and keeper will): ${err.message}`); }
  }

  try {
    // 1. Parked transactions: find out what actually happened before sending anything again.
    for (const p of await proposals.find({ state: 'unconfirmed' }).toArray()) {
      try {
        const r = await contract.getCreateMarketsResult(p.batchTxHash);
        if (r.status === 'success' && r.marketIds[p.batchIndex] !== undefined) { await activate(p, r.marketIds[p.batchIndex], { txHash: p.batchTxHash, blockNumber: r.blockNumber }); out.adopted++; }
        else if (r.status === 'reverted') await proposals.updateOne({ _id: p._id }, { $set: { state: 'pending', lastError: 'broadcast transaction reverted', updatedAt: new Date(nowMs) }, $inc: { attempts: 1 } });
        else if (nowMs - new Date(p.updatedAt).getTime() > UNCONFIRMED_GRACE_MS) await proposals.updateOne({ _id: p._id }, { $set: { state: 'pending', lastError: 'broadcast transaction never confirmed', updatedAt: new Date(nowMs) }, $inc: { attempts: 1 } });
      } catch (err) { pushCapped(out.errors, `unconfirmed ${p.batchTxHash}: ${shortMessage(err)}`); }
    }

    // 2. Expire what can no longer be published sensibly.
    const minLead = A.publishMinLeadHours * 3600 * 1000;
    for (const p of await proposals.find({ state: 'pending' }).toArray()) {
      const why = new Date(p.eventDate).getTime() <= nowMs ? 'the event has already passed'
        : new Date(p.tradingDeadline).getTime() - nowMs < minLead ? `less than ${A.publishMinLeadHours}h of trading time would remain`
        : (p.attempts || 0) >= A.publishMaxAttempts ? `gave up after ${p.attempts} failed attempts` : null;
      if (why) { await proposals.updateOne({ _id: p._id }, { $set: { state: 'expired', expiredReason: why, updatedAt: new Date(nowMs) } }); out.expired++; console.log(`[publish] expired "${String(p.question).slice(0, 60)}": ${why}`); }
    }

    // 3. Which pending questions are due for an attempt?
    const due = (await proposals.find({ state: 'pending' }).toArray()).sort(byAge).filter((p) => !p.nextAttemptAt || new Date(p.nextAttemptAt).getTime() <= nowMs);
    out.pending = (await proposals.countDocuments({ state: 'pending' }));
    if (!due.length) { out.status = 'nothing_to_publish'; return out; }

    // 4. Never create a market twice: skip questions that are already on-chain.
    let batch = due.slice(0, MAX_BATCH);
    try {
      const count = Number(await contract.getMarketCount());
      const ids = Array.from({ length: Math.min(count, RECENT_ONCHAIN) }, (_, i) => count - 1 - i);
      const recent = await Promise.all(ids.map((id) => contract.getMarket(id).catch(() => null)));
      const onchain = new Map(recent.filter(Boolean).map((m) => [norm(m.question), m]));
      for (const p of [...batch]) {
        const hit = onchain.get(norm(p.question));
        if (hit) { await activate(p, hit.marketId, { txHash: p.createTxHash || null, blockNumber: null }); out.adopted++; batch = batch.filter((x) => x !== p); }
      }
    } catch (err) { pushCapped(out.errors, `on-chain duplicate check skipped: ${shortMessage(err)}`); }
    if (!batch.length) return out;

    // 5. ONE transaction for the whole batch.
    try {
      const { txHash, marketIds, blockNumber } = await contract.createMarkets(batch.map((p) => ({ question: p.question, criteria: p.resolutionCriteria, tradingTs: p.tradingDeadlineTs, resolutionTs: p.resolutionDeadlineTs })));
      for (const [i, p] of batch.entries()) await activate(p, marketIds[i], { txHash, blockNumber });
      out.published = batch.length; out.txHash = txHash; out.marketIds = marketIds;
      out.pending = await proposals.countDocuments({ state: 'pending' });
      console.log(`[publish] ${batch.length} market(s) created in ONE transaction ${txHash} (ids ${marketIds.join(', ')})`);
    } catch (err) {
      if (err.unconfirmed && err.txHash) { // broadcast but not confirmed: park it, never resend blindly
        for (const [i, p] of batch.entries()) await proposals.updateOne({ _id: p._id }, { $set: { state: 'unconfirmed', batchTxHash: err.txHash, batchIndex: i, updatedAt: new Date(nowMs) } });
        out.status = 'unconfirmed'; out.txHash = err.txHash; out.published = batch.length;
        console.warn(`[publish] transaction ${err.txHash} broadcast but not confirmed yet; will check it before doing anything else`);
      } else { // not sent: keep the questions pending and retry later with backoff
        for (const p of batch) {
          const attempts = (p.attempts || 0) + 1;
          await proposals.updateOne({ _id: p._id }, { $set: { state: 'pending', attempts, lastError: shortMessage(err, 300), nextAttemptAt: new Date(nowMs + backoffMs(attempts)), updatedAt: new Date(nowMs) } });
        }
        out.status = 'failed'; out.failed = batch.length; out.error = shortMessage(err, 300);
        pushCapped(out.errors, out.error);
        console.error(`[publish] could not publish ${batch.length} market(s), kept as pending and will retry: ${out.error}`);
      }
    }
    return out;
  } finally {
    await releaseLock(database, 'publish', owner);
  }
}

module.exports = { publishPending, backoffMs };
