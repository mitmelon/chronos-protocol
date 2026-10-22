'use strict';

const { db } = require('../db/client');

async function resolutionRoutes(fastify) {
  fastify.get('/api/resolutions', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['YES','NO','UNRESOLVED','all'] },
          category: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          search: { type: 'string', maxLength: 200 },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { outcome = 'all', category, from, to, search, page = 1, limit = 20 } = request.query;
      const skip = (page - 1) * limit;
      const filter = { state: { $in: ['Resolved','Refundable','Settled'] } };
      if (outcome !== 'all') filter.outcome = outcome;
      if (category && category !== 'all') filter.category = category;
      if (from || to) { filter.resolvedAt = {}; if (from) filter.resolvedAt.$gte = new Date(from); if (to) filter.resolvedAt.$lte = new Date(to); }
      if (search) filter.$text = { $search: search };
      const [resolutions, total] = await Promise.all([
        db().collection('predictions').find(filter).sort({ resolvedAt: -1 }).skip(skip).limit(limit).toArray(),
        db().collection('predictions').countDocuments(filter),
      ]);
      const enriched = await Promise.all(resolutions.map(async (r) => {
        const evidence = await db().collection('evidence').findOne({ marketId: r.marketId }, { projection: { proposedOutcome: 1, confidence: 1, sources: { $slice: 2 } } });
        return { ...r, evidenceSummary: evidence };
      }));
      return { resolutions: enriched, total, page, limit };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });
}

module.exports = resolutionRoutes;
