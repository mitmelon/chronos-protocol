'use strict';

const { db } = require('../db/client');
const { getMarket } = require('../services/contract');

async function marketRoutes(fastify) {
  fastify.get('/api/markets', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['Open','TradingClosed','Resolved','Refundable','Settled','all'] },
          category: { type: 'string' },
          search: { type: 'string', maxLength: 200 },
          sort: { type: 'string', enum: ['newest','deadline','staked','yesPercent','noPercent'] },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { state = 'all', category, search, sort = 'newest', page = 1, limit = 20 } = request.query;
      const skip = (page - 1) * limit;
      const filter = {};
      if (state !== 'all') filter.state = state;
      if (category && category !== 'all') filter.category = category;
      if (search) filter.$text = { $search: search };
      const sortMap = { newest: { createdAt: -1 }, deadline: { tradingDeadline: 1 }, staked: { totalPool: -1 }, yesPercent: { yesPool: -1 }, noPercent: { noPool: -1 } };
      const database = db();
      const [markets, total] = await Promise.all([
        database.collection('predictions').find(filter).sort(sortMap[sort] || { createdAt: -1 }).skip(skip).limit(limit).toArray(),
        database.collection('predictions').countDocuments(filter),
      ]);
      return { markets, total, page, limit, pages: Math.ceil(total / limit) };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });

  fastify.get('/api/markets/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 0 } }, required: ['id'] } },
  }, async (request, reply) => {
    try {
      const marketId = parseInt(request.params.id);
      let market = await db().collection('predictions').findOne({ marketId });
      if (!market) {
        try { return reply.send({ market: await getMarket(marketId), source: 'chain' }); }
        catch { return reply.status(404).send({ error: true, message: 'Market not found', code: 'NOT_FOUND' }); }
      }
      const evidenceSummary = await db().collection('evidence').findOne({ marketId }, { projection: { proposedOutcome: 1, confidence: 1, geminiReasoning: 1, sources: { $slice: 3 } } });
      return { market, evidence: evidenceSummary || null, source: 'db' };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });

  fastify.get('/api/markets/:id/evidence', {
    schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 0 } }, required: ['id'] } },
  }, async (request, reply) => {
    try {
      const marketId = parseInt(request.params.id);
      const evidence = await db().collection('evidence').findOne({ marketId });
      if (!evidence) return reply.status(404).send({ error: true, message: 'No evidence found', code: 'NOT_FOUND' });
      return { evidence };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });

  fastify.get('/api/markets/:id/trades', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'integer', minimum: 0 } }, required: ['id'] },
      querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } },
    },
  }, async (request, reply) => {
    try {
      const marketId = parseInt(request.params.id);
      const { page = 1, limit = 50 } = request.query;
      const skip = (page - 1) * limit;
      const [trades, total] = await Promise.all([
        db().collection('positions').find({ marketId }).sort({ updatedAt: -1 }).skip(skip).limit(limit).toArray(),
        db().collection('positions').countDocuments({ marketId }),
      ]);
      return { trades, total, page, limit };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });
}

module.exports = marketRoutes;
