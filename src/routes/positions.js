'use strict';

const { db } = require('../db/client');
const { computeWinnings } = require('../services/contract');

async function positionRoutes(fastify) {
  fastify.get('/api/positions/:address', {
    schema: {
      params: { type: 'object', properties: { address: { type: 'string', minLength: 42, maxLength: 42 } }, required: ['address'] },
      querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } },
    },
  }, async (request, reply) => {
    try {
      const address = request.params.address.toLowerCase();
      const { page = 1, limit = 20 } = request.query;
      const skip = (page - 1) * limit;
      const [positions, total] = await Promise.all([
        db().collection('positions').find({ address }).sort({ updatedAt: -1 }).skip(skip).limit(limit).toArray(),
        db().collection('positions').countDocuments({ address }),
      ]);
      return { positions, total, page, limit };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });

  fastify.get('/api/positions/:address/claimable', {
    schema: { params: { type: 'object', properties: { address: { type: 'string', minLength: 42, maxLength: 42 } }, required: ['address'] } },
  }, async (request, reply) => {
    try {
      const address = request.params.address.toLowerCase();
      const claimablePositions = await db().collection('positions').find({ address, claimed: false }).toArray();
      const enriched = await Promise.all(claimablePositions.map(async (pos) => {
        const market = await db().collection('predictions').findOne({ marketId: pos.marketId });
        if (!market || !['Resolved','Refundable'].includes(market.state)) return null;
        let netPayout = '0', feeAmount = '0';
        if (market.state === 'Resolved') {
          try { const preview = await computeWinnings(pos.marketId, address); netPayout = preview.netPayout; feeAmount = preview.feeAmount; } catch {}
        } else {
          netPayout = (BigInt(pos.yesShares || '0') + BigInt(pos.noShares || '0')).toString();
        }
        return { ...pos, marketState: market.state, netPayout, feeAmount, question: market.question };
      }));
      const claimable = enriched.filter(Boolean).filter(p => BigInt(p.netPayout) > 0n);
      return { claimable, count: claimable.length };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });
}

module.exports = positionRoutes;
