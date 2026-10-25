'use strict';
/**
 * src/agent/keeper.js
 *
 * Housekeeping (no LLM): sync on-chain markets into MongoDB, close trading when the deadline passes,
 * adopt agent-created documents whose on-chain confirmation was lost, and make sure every active
 * market has its due-time resolution job in the queue.
 *
 * The chain is the source of truth for state, pools and outcome. A failure on one market never aborts the run.
 */

const { v4: uuidv4 } = require('uuid');
const { withTimeout, retry, toDate, pushCapped, acquireLock, releaseLock, failStaleRuns, finishRun, ensureAgentIndexes } = require('./lib');
const { resolveDeps } = require('./tools');
const guards = require('./guards');

const LOCK_TTL_MS = 10 * 60 * 1000;
const BATCH = 10;
const DEADLINE_BUFFER_SECS = 5; // our clock can run ahead of the block timestamp
const TERMINAL = new Set(['Resolved', 'Refundable', 'Settled']);
const RESYNC_TERMINAL_MS = 60 * 60 * 1000;

async function runKeeper(overrides = {}) {
  const deps = resolveDeps(overrides);
  const { config, contract, jobs } = deps;
  const database = deps.db();
  const agentRuns = database.collection('agentRuns');
  const predictions = database.collection('predictions');
  const s = guards.settings(config);

  const runId = uuidv4();
  const owner = await acquireLock(database, 'keeper', LOCK_TTL_MS);
  if (!owner) return { runId, type: 'keeper', status: 'skipped', skipReason: 'Another keeper run is in progress' };

  const run = { runId, type: 'keeper', startedAt: new Date(), status: 'running', marketsScanned: 0, marketsSkipped: 0, tradingClosed: 0, dbSynced: 0, jobsScheduled: 0, errors: [] };

  try {
    await ensureAgentIndexes(database);
    await failStaleRuns(agentRuns, 'keeper', LOCK_TTL_MS);
    await agentRuns.insertOne(run);

    if (!config.arc.factoryAddress) { run.status = 'skipped'; run.skipReason = 'VITE_FACTORY_ADDRESS not configured'; run.completedAt = new Date(); return run; }

    const count = Number(await retry(() => withTimeout(contract.getMarketCount(), 30000, 'getMarketCount'), { tries: 3, label: 'getMarketCount' }));
    if (!Number.isFinite(count) || count < 0) throw new Error(`Invalid market count from chain: ${count}`);
    run.marketsScanned = count;

    const known = new Map();
    for (const d of await predictions.find({ marketId: { $ne: null } }, { projection: { marketId: 1, state: 1, updatedAt: 1 } }).toArray()) known.set(String(d.marketId), d);

    for (let i = 0; i < count; i += BATCH) {
      const ids = [];
      for (let j = i; j < Math.min(i + BATCH, count); j++) {
        const d = known.get(String(j));
        const fresh = d && d.updatedAt && deps.now() - new Date(d.updatedAt).getTime() < RESYNC_TERMINAL_MS;
        if (d && TERMINAL.has(d.state) && fresh) { run.marketsSkipped++; continue; }
        ids.push(j);
      }
      if (!ids.length) continue;
      const results = await Promise.allSettled(ids.map((id) => retry(() => withTimeout(contract.getMarket(id), 30000, `getMarket(${id})`), { tries: 3, label: `getMarket(${id})` })));

      for (let k = 0; k < results.length; k++) {
        const result = results[k];
        if (result.status === 'rejected') { pushCapped(run.errors, { marketId: ids[k], step: 'fetch', error: result.reason?.message || 'fetch failed' }); continue; }
        const market = result.value;
        try {
          await syncMarket(predictions, database.collection('marketProposals'), market, known.has(String(market.marketId)));
          run.dbSynced++;
          if (market.state === 'Open' || market.state === 'TradingClosed') await ensureJob(predictions, jobs, market, s, run);

          if (market.state === 'Open') {
            const deadline = toDate(market.tradingDeadline);
            if (!deadline) throw new Error(`Market ${market.marketId} has an invalid trading deadline`);
            if (Math.floor(deps.now() / 1000) >= Math.floor(deadline.getTime() / 1000) + DEADLINE_BUFFER_SECS) {
              try {
                const { txHash } = await withTimeout(contract.closeTrading(market.marketId), 180000, `closeTrading(${market.marketId})`);
                await predictions.updateOne({ marketId: market.marketId }, { $set: { state: 'TradingClosed', closeTradingTxHash: txHash, updatedAt: new Date() } });
                run.tradingClosed++;
              } catch (err) {
                if (!['InvalidMarketState', 'TradingOpen'].includes(err.errorName) && !/InvalidMarketState|TradingOpen/.test(err.message || '')) {
                  pushCapped(run.errors, { marketId: market.marketId, step: 'closeTrading', error: err.message });
                }
              }
            }
          }
        } catch (err) { pushCapped(run.errors, { marketId: ids[k], step: 'sync', error: err.message }); }
      }
    }
    // Safety net for push payouts: any settled market that is not fully paid gets a payout job (deduped per market).
    if (config.agent.autoPayout !== false) {
      const unpaid = await predictions.find({ marketId: { $ne: null }, state: { $in: ['Resolved', 'Refundable'] }, payoutStatus: { $nin: ['complete', 'stuck'] } }).sort({ updatedAt: -1 }).limit(20).toArray();
      for (const d of unpaid) { try { await jobs.schedulePayout(d.marketId, 0); run.payoutsQueued = (run.payoutsQueued || 0) + 1; } catch (err) { pushCapped(run.errors, { marketId: d.marketId, step: 'queuePayout', error: err.message }); } }
    }

    // Proposals that never reached the chain within 2 hours are dead: stop them blocking similar questions.
    await database.collection('marketProposals').updateMany({ state: { $in: ['pending', 'unconfirmed'] }, createdAt: { $lt: new Date(deps.now() - 2 * 3600 * 1000) } }, { $set: { state: 'expired', updatedAt: new Date() } }).catch(() => {});
    run.status = 'completed'; run.completedAt = new Date();
  } catch (err) {
    console.error('[keeper] Fatal error:', err);
    run.status = 'failed'; run.error = err.message; run.completedAt = new Date();
  } finally {
    await finishRun(agentRuns, run);
    await releaseLock(database, 'keeper', owner);
  }
  return run;
}

/** Make sure the due-time job exists (Redis can be flushed; markets can predate the queue). */
async function ensureJob(predictions, jobs, market, s, run) {
  try {
    if (await jobs.hasScheduledJob(market.marketId)) return;
    const doc = await predictions.findOne({ marketId: market.marketId }, { projection: { eventDate: 1 } });
    const base = toDate(doc?.eventDate) || toDate(market.tradingDeadline);
    if (!base) return;
    await jobs.scheduleResolution(market.marketId, { dueAt: base.getTime() + s.settleDelay, deadlineAt: market.resolutionDeadline.getTime() });
    run.jobsScheduled++;
  } catch (err) { pushCapped(run.errors, { marketId: market.marketId, step: 'schedule', error: err.message }); }
}

/**
 * Write the chain's view of a market. If the market has no document yet, first look for the agent's own
 * proposal (same question) so category, authority source and event date are kept.
 */
async function syncMarket(predictions, proposals, market, alreadyKnown) {
  const fields = {
    marketId: market.marketId, question: market.question, resolutionCriteria: market.resolutionCriteria,
    tradingDeadline: market.tradingDeadline, resolutionDeadline: market.resolutionDeadline,
    yesPool: market.yesPool, noPool: market.noPool, totalPool: market.totalPool,
    state: market.state, outcome: market.outcome, resolvedAt: market.resolvedAt, evidenceURI: market.evidenceURI,
    swept: market.swept, creator: market.creator, feeBps: market.feeBps, updatedAt: new Date(),
  };
  let meta = {};
  if (!alreadyKnown) {
    // A market the agent broadcast but never got confirmation for: pick its metadata up from the proposal.
    const proposal = await proposals.findOne({ question: market.question, state: { $in: ['pending', 'unconfirmed'] } });
    if (proposal) {
      const { _id, state, createTxHash, createdAt, updatedAt, ...rest } = proposal;
      meta = { ...rest, createTxHash };
      await proposals.updateOne({ _id }, { $set: { state: 'created', marketId: market.marketId, updatedAt: new Date() } });
    }
  }
  await predictions.updateOne({ marketId: market.marketId }, { $set: { ...meta, ...fields }, $setOnInsert: { createdAt: new Date(), category: meta.category || 'Other', tags: meta.tags || [] } }, { upsert: true });
}

module.exports = { runKeeper };
