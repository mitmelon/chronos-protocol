'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { db } = require('../db/client');
const contract = require('../services/contract');
const guards = require('../agent/guards');
const jobs = require('../queues/jobs');
const { requireAuth } = require('../auth/session');

const FINAL = new Set(['Resolved', 'Refundable', 'Settled']);
const ACTIVE_MS = 30 * 60 * 1000;

async function loadMarket(id) {
  const chain = await contract.getMarket(id);
  const doc = await db().collection('predictions').findOne({ marketId: id });
  const window = guards.resolutionWindow({ ...(doc || {}), tradingDeadline: chain.tradingDeadline, resolutionDeadline: chain.resolutionDeadline }, Date.now(), guards.settings(config));
  return { chain, doc, window };
}

module.exports = async function resolveRoutes(app) {
  /**
   * The Resolve button. Anyone signed in can ask, but this never resolves anything by itself:
   * it queues the same agent run the scheduler uses, which re-checks the chain, takes a per-market
   * lock, and can only finalise a market once.
   */
  app.post('/api/markets/:id/resolve', { preHandler: requireAuth, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: true, message: 'Invalid market id' });

    let ctx;
    try { ctx = await loadMarket(id); } catch { return reply.code(404).send({ error: true, code: 'NOT_FOUND', message: 'Market not found on-chain' }); }
    const { chain, window } = ctx;

    if (FINAL.has(chain.state)) return { status: 'already_final', state: chain.state, outcome: chain.outcome, message: `This market is already ${chain.state.toLowerCase()}.` };
    if (!window.eligible) return reply.code(409).send({ error: true, code: 'NOT_DUE', dueAt: window.dueAt || null, message: `${window.reason}. It can be resolved after ${window.dueAt ? new Date(window.dueAt).toUTCString() : 'the event'}.` });

    const jobsCol = db().collection('resolutionJobs');
    const active = await jobsCol.findOne({ marketId: id, status: { $in: ['queued', 'running'] }, createdAt: { $gt: new Date(Date.now() - ACTIVE_MS) } });
    if (active) return reply.code(202).send({ status: 'in_progress', jobId: active.jobId, message: 'The oracle is already working on this market.' });

    const cooldownMs = config.agent.manualResolveCooldownMinutes * 60 * 1000;
    const recent = await jobsCol.findOne({ marketId: id, status: { $in: ['deferred', 'unresolved', 'failed', 'not_due'] }, updatedAt: { $gt: new Date(Date.now() - cooldownMs) } }, { sort: { updatedAt: -1 } });
    if (recent && !window.pastDeadline) {
      const retryAfterSec = Math.ceil((new Date(recent.updatedAt).getTime() + cooldownMs - Date.now()) / 1000);
      return reply.code(429).send({ error: true, code: 'COOLDOWN', retryAfterSec, message: `The oracle checked this market a moment ago and needs more time. Try again in ${Math.ceil(retryAfterSec / 60)} min.` });
    }

    const jobId = uuidv4();
    await jobsCol.insertOne({ jobId, marketId: id, status: 'queued', trigger: 'manual', requestedBy: request.user.address, createdAt: new Date(), updatedAt: new Date() });
    try { await jobs.enqueueManualResolution(id, request.user.address, jobId); }
    catch (err) {
      await jobsCol.updateOne({ jobId }, { $set: { status: 'failed', error: 'Could not queue: ' + err.message, updatedAt: new Date() } });
      return reply.code(503).send({ error: true, message: 'The oracle queue is unavailable. Try again shortly.' });
    }
    return reply.code(202).send({ status: 'queued', jobId, message: 'The oracle is checking the result now.' });
  });

  /** Public status for the market page: can it be resolved, and what did the oracle last do? */
  app.get('/api/markets/:id/resolution', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: true, message: 'Invalid market id' });
    let ctx;
    try { ctx = await loadMarket(id); } catch { return reply.code(404).send({ error: true, message: 'Market not found' }); }
    const { chain, doc, window } = ctx;
    const last = await db().collection('resolutionJobs').findOne({ marketId: id }, { sort: { updatedAt: -1 } });
    return {
      marketId: id, state: chain.state, outcome: chain.outcome,
      eligible: !FINAL.has(chain.state) && window.eligible, dueAt: window.dueAt || null, pastDeadline: !!window.pastDeadline, reason: window.reason || null,
      nextAttemptAt: doc?.resolutionNextAttemptAt || null,
      job: last ? { status: last.status, trigger: last.trigger, reason: last.reason || null, updatedAt: last.updatedAt, txHash: last.txHash || null } : null,
    };
  });
};
