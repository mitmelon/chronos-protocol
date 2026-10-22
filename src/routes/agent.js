'use strict';

const { db } = require('../db/client');
const { workerAuth } = require('../middleware/auth');
const { runDiscovery } = require('../agent/discover');
const { runResolution } = require('../agent/resolve');
const { runKeeper } = require('../agent/keeper');

async function agentRoutes(fastify) {
  fastify.get('/api/agent/runs', {
    schema: { querystring: { type: 'object', properties: { type: { type: 'string', enum: ['discovery','resolution','keeper','all'] }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 30 } } } },
  }, async (request, reply) => {
    try {
      const { type = 'all', limit = 30 } = request.query;
      const filter = type !== 'all' ? { type } : {};
      const runs = await db().collection('agentRuns').find(filter).sort({ startedAt: -1 }).limit(limit).toArray();
      return { runs };
    } catch (err) { return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' }); }
  });

  fastify.get('/api/agent/runs/:runId', {
    schema: { params: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] } },
  }, async (request, reply) => {
    try {
      const run = await db().collection('agentRuns').findOne({ runId: request.params.runId });
      if (!run) return reply.status(404).send({ error: true, message: 'Run not found', code: 'NOT_FOUND' });
      return { run };
    } catch (err) { return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' }); }
  });

  fastify.get('/api/agent/daily-report', async (request, reply) => {
    try {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const [todayRuns, publishedToday, resolvedToday] = await Promise.all([
        db().collection('agentRuns').find({ startedAt: { $gte: today } }).toArray(),
        db().collection('predictions').countDocuments({ createdAt: { $gte: today } }),
        db().collection('predictions').countDocuments({ resolvedAt: { $gte: today } }),
      ]);
      const running = todayRuns.find(r => r.status === 'running');
      return {
        date: today.toISOString(), runsToday: todayRuns.length,
        marketsPublishedToday: publishedToday, marketsResolvedToday: resolvedToday,
        currentStatus: running ? 'running' : 'idle', currentRunType: running?.type || null,
        lastRun: todayRuns.sort((a, b) => b.startedAt - a.startedAt)[0] || null,
      };
    } catch (err) { return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' }); }
  });

  fastify.post('/internal/agent/trigger-discovery', { preHandler: workerAuth }, async (request, reply) => {
    setImmediate(() => runDiscovery().catch(err => console.error('[agent] Discovery error:', err)));
    return { triggered: true, type: 'discovery' };
  });

  fastify.post('/internal/agent/trigger-resolution', { preHandler: workerAuth }, async (request, reply) => {
    setImmediate(() => runResolution().catch(err => console.error('[agent] Resolution error:', err)));
    return { triggered: true, type: 'resolution' };
  });

  fastify.post('/internal/sync/markets', { preHandler: workerAuth }, async (request, reply) => {
    setImmediate(() => runKeeper().catch(err => console.error('[agent] Keeper error:', err)));
    return { triggered: true, type: 'sync' };
  });
}

module.exports = agentRoutes;
