'use strict';
/**
 * src/agent/payouts.js
 *
 * After a market settles (Resolved or Refundable), the agent pays every participant automatically
 * instead of waiting for each person to press Claim. It uses the contract's claimBatch, which sends
 * each payout to the participant's own address (the caller can never redirect funds).
 *
 * Safe to run any number of times:
 *   - one run per market at a time (Mongo lock)
 *   - already-paid participants are detected on-chain (claimed()) and skipped; the contract also rejects double claims
 *   - after every batch the result is verified on-chain, not trusted from the transaction
 *   - an address that can't receive funds (for example blocklisted by the token) never blocks the others; it is
 *     retried with backoff, then marked "stuck" so the person can claim it themselves
 * The oracle wallet pays the gas for these transactions.
 */

const { resolveDeps } = require('./tools');
const { acquireLock, releaseLock, retry, withTimeout } = require('./lib');

const LOCK_TTL_MS = 20 * 60 * 1000;
const READ_CONCURRENCY = 8;
const backoffMs = (attempts) => Math.min(6 * 3600 * 1000, 10 * 60 * 1000 * 2 ** Math.max(0, attempts - 1));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function payoutMarket(marketId, overrides = {}) {
  const deps = resolveDeps(overrides);
  const { config, contract, jobs } = deps;
  const A = config.agent;
  if (A.autoPayout === false) return { status: 'disabled' };

  const id = Number(marketId);
  const database = deps.db();
  const predictions = database.collection('predictions');
  const ledger = database.collection('payouts');

  const owner = await acquireLock(database, `payout:${id}`, LOCK_TTL_MS);
  if (!owner) return { status: 'in_progress' };

  try {
    const chain = await retry(() => withTimeout(contract.getMarket(id), 30000, 'getMarket'), { tries: 3, label: `getMarket(${id})` });
    if (chain.state !== 'Resolved' && chain.state !== 'Refundable') return { status: 'not_settled', state: chain.state };
    const refund = chain.state === 'Refundable';

    const doc = await predictions.findOne({ marketId: id });
    const participants = await retry(() => withTimeout(contract.getParticipants(id, doc?.createBlock || 0), 120000, 'getParticipants'), { tries: 3, label: `getParticipants(${id})` });

    // Who is still owed money? Read the chain, not our database.
    const reads = await mapLimit(participants, READ_CONCURRENCY, async (user) => {
      if (await contract.isClaimed(id, user)) return null;
      const sh = await contract.getShares(id, user);
      const yes = BigInt(sh.yesAmt), no = BigInt(sh.noAmt);
      const amount = refund ? yes + no : chain.outcome === 'YES' ? yes : chain.outcome === 'NO' ? no : 0n;
      return amount > 0n ? { user, amount: amount.toString() } : null;
    });
    const owed = reads.filter(Boolean);

    const prior = new Map((await ledger.find({ marketId: id }).toArray()).map((r) => [r.user.toLowerCase(), r]));
    const attemptsOf = (u) => prior.get(u.toLowerCase())?.attempts || 0;
    const todo = owed.filter((o) => attemptsOf(o.user) < A.payoutMaxAttempts);

    const paidSet = new Set(), failedSet = new Set();
    let paid = 0, failed = 0;
    for (let i = 0; i < todo.length; i += A.payoutBatchSize) {
      const chunk = todo.slice(i, i + A.payoutBatchSize);
      let txHash = null, batchError = null;
      try { ({ txHash } = await contract.claimBatch(id, chunk.map((c) => c.user))); }
      catch (err) { batchError = err; if (err.txHash) txHash = err.txHash; }

      // Verify every participant on-chain, whatever the transaction said.
      await mapLimit(chunk, READ_CONCURRENCY, async (c) => {
        const done = await contract.isClaimed(id, c.user).catch(() => false);
        const key = { marketId: id, user: c.user.toLowerCase() };
        if (done) {
          paid++; paidSet.add(c.user);
          await ledger.updateOne(key, { $set: { status: 'paid', amount: c.amount, mode: refund ? 'refund' : 'winnings', txHash, paidAt: new Date(deps.now()) }, $setOnInsert: { attempts: 0 } }, { upsert: true });
        } else {
          failed++; failedSet.add(c.user);
          await ledger.updateOne(key, { $set: { status: 'failed', amount: c.amount, lastError: String(batchError?.message || 'not paid by batch').slice(0, 200), lastAttemptAt: new Date(deps.now()) }, $inc: { attempts: 1 } }, { upsert: true });
        }
      });
      if (batchError) console.warn(`[payout ${id}] batch error: ${batchError.message}`);
    }

    // Anyone still unpaid after this run? Retry the ones with attempts left; the rest are "stuck" (they can claim themselves).
    const unpaidList = owed.filter((o) => !paidSet.has(o.user));
    const attemptsNow = (o) => attemptsOf(o.user) + (failedSet.has(o.user) ? 1 : 0);
    const retriable = unpaidList.some((o) => attemptsNow(o) < A.payoutMaxAttempts);
    const payoutStatus = unpaidList.length === 0 ? 'complete' : retriable ? 'partial' : 'stuck';
    await predictions.updateOne({ marketId: id }, { $set: { payoutStatus, payoutOwed: owed.length, payoutPaid: paid, payoutCheckedAt: new Date(deps.now()) } });
    if (payoutStatus === 'partial') {
      const worst = Math.max(...unpaidList.map(attemptsNow));
      try { await jobs.schedulePayout(id, backoffMs(worst)); } catch (e) { console.warn(`[payout ${id}] could not schedule retry: ${e.message}`); }
    }
    console.log(`[payout ${id}] ${refund ? 'refunds' : 'winnings'}: ${participants.length} participants, ${owed.length} owed, ${paid} paid, ${failed} failed -> ${payoutStatus}`);
    return { status: payoutStatus, participants: participants.length, owed: owed.length, paid, failed };
  } finally {
    await releaseLock(database, `payout:${id}`, owner);
  }
}

module.exports = { payoutMarket, backoffMs };
