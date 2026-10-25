'use strict';
/**
 * src/agent/lib.js
 * Shared helpers for the discovery, keeper and resolution jobs.
 *
 * RULE: retry() is for reads and LLM/search calls only. Never wrap an on-chain
 * write (closeTrading, resolveMarket, markRefundable) in retry(): a retried
 * write can be submitted twice.
 */

const { v4: uuidv4 } = require('uuid');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reject if `work` (a promise or a function returning one) takes longer than `ms`. */
function withTimeout(work, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  const promise = typeof work === 'function' ? Promise.resolve().then(work) : Promise.resolve(work);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Retry with exponential backoff and jitter. */
async function retry(fn, { tries = 3, baseMs = 1000, label = 'call', shouldRetry = () => true } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === tries || !shouldRetry(err)) break;
      const delay = baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(`[retry] ${label} failed (attempt ${attempt}/${tries}): ${err.message}. Retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Accepts Date, ISO string, unix seconds or unix milliseconds. Returns Date or null. */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value) ? null : value;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

function pushCapped(list, item, max = 100) {
  if (list.length < max) list.push(item);
}

// ── Distributed lock (Mongo). Stops overlapping runs from double-publishing,
//    double-resolving or racing on the same wallet nonce. ──────────────────────

async function acquireLock(database, name, ttlMs) {
  const locks = database.collection('agentLocks');
  const now = new Date();
  const owner = uuidv4();
  try {
    const doc = await locks.findOneAndUpdate(
      { _id: name, $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }] },
      { $set: { owner, acquiredAt: now, expiresAt: new Date(now.getTime() + ttlMs) } },
      { upsert: true, returnDocument: 'after' }
    );
    return doc && doc.owner === owner ? owner : null;
  } catch (err) {
    if (err && err.code === 11000) return null; // lock held and not expired
    throw err;
  }
}

async function releaseLock(database, name, owner) {
  try { await database.collection('agentLocks').deleteOne({ _id: name, owner }); }
  catch (err) { console.warn(`[lock] failed to release ${name}: ${err.message}`); }
}

// ── Run bookkeeping ───────────────────────────────────────────────────────────

/** Mark runs that never finished (crash, deploy) as failed. Call only while holding the lock. */
async function failStaleRuns(agentRuns, type, maxAgeMs) {
  try {
    await agentRuns.updateMany(
      { type, status: 'running', startedAt: { $lt: new Date(Date.now() - maxAgeMs) } },
      { $set: { status: 'failed', error: 'Run did not finish (process restarted or timed out)', completedAt: new Date() } }
    );
  } catch (err) { console.warn(`[${type}] could not clean stale runs: ${err.message}`); }
}

/** Persist the run document without ever throwing. Strips the immutable _id. */
async function finishRun(agentRuns, run) {
  const { _id, ...fields } = run;
  if (Array.isArray(fields.errors) && fields.errors.length > 50) fields.errors = fields.errors.slice(0, 50);
  if (Array.isArray(fields.rejectionReasons) && fields.rejectionReasons.length > 100) fields.rejectionReasons = fields.rejectionReasons.slice(0, 100);
  try { await agentRuns.updateOne({ runId: run.runId }, { $set: fields }); }
  catch (err) { console.error(`[${run.type}] could not save run ${run.runId}: ${err.message}`); }
}

let _indexesEnsured = false;
/** Idempotent, best effort. Never blocks a run. */
async function ensureAgentIndexes(database) {
  if (_indexesEnsured) return;
  _indexesEnsured = true;
  const tryIndex = async (coll, spec, opts = {}) => {
    try { await database.collection(coll).createIndex(spec, { background: true, ...opts }); }
    catch (err) { console.warn(`[indexes] ${coll} ${JSON.stringify(spec)}: ${err.message}`); }
  };
  await tryIndex('predictions', { state: 1, resolutionDeadline: 1 });
  await tryIndex('predictions', { marketId: 1 });
  await tryIndex('predictions', { discoveryRunId: 1, createdAt: -1 });
  await tryIndex('predictions', { 'source.eventUrl': 1 }, { unique: true, partialFilterExpression: { 'source.eventUrl': { $type: 'string' } } });
  await tryIndex('resolutionJobs', { marketId: 1, createdAt: -1 });
  await tryIndex('authNonces', { expiresAt: 1 }, { expireAfterSeconds: 0 });
  await tryIndex('agentRuns', { type: 1, startedAt: -1 });
}

module.exports = { sleep, withTimeout, retry, toDate, pushCapped, acquireLock, releaseLock, failStaleRuns, finishRun, ensureAgentIndexes };
