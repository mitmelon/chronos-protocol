'use strict';

const { db } = require('../db/client');
const { computeWinnings } = require('../services/contract');
const { recordTransaction } = require('../services/indexer');

const sum = (rows, f) => rows.reduce((t, r) => t + BigInt(f(r) || '0'), 0n);

async function positionRoutes(fastify) {
  const addrParams = { type: 'object', properties: { address: { type: 'string', minLength: 42, maxLength: 42 } }, required: ['address'] };

  /**
   * Record a stake the moment it is confirmed. The browser calls this with the transaction hash; the server re-reads the
   * chain itself (nothing the browser says is trusted), stores the position and refreshes the market's pools.
   */
  fastify.post('/api/positions/record', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { body: { type: 'object', properties: { txHash: { type: 'string', minLength: 66, maxLength: 66 } }, required: ['txHash'] } } }, async (request, reply) => {
    try { return await recordTransaction(request.body.txHash); }
    catch (err) { return reply.status(err.statusCode || 502).send({ error: true, message: err.message, code: err.statusCode === 400 ? 'BAD_REQUEST' : 'CHAIN_UNAVAILABLE' }); }
  });

  fastify.get('/api/positions/:address', { schema: { params: addrParams, querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } } } }, async (request, reply) => {
    try {
      const address = request.params.address.toLowerCase();
      const { page = 1, limit = 20 } = request.query;
      const col = db().collection('positions');
      const [rows, total, all] = await Promise.all([
        col.find({ address }).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        col.countDocuments({ address }),
        col.find({ address }).toArray(),
      ]);
      // Join the live market (state, outcome, question) so the page never shows stale state.
      const ids = [...new Set([...rows, ...all].map((p) => p.marketId))];
      const markets = new Map((await db().collection('predictions').find({ marketId: { $in: ids } }).toArray()).map((m) => [m.marketId, m]));
      const view = (p) => { const m = markets.get(p.marketId); return { ...p, question: m?.question || p.question, marketState: m?.state, state: m?.state, outcome: m?.outcome, category: m?.category }; };
      const payouts = await db().collection('trades').find({ user: address, type: { $in: ['winnings', 'refund'] } }).toArray();
      const open = all.filter((p) => ['Open', 'TradingClosed'].includes(markets.get(p.marketId)?.state));
      const summary = {
        positions: all.length, markets: new Set(all.map((p) => p.marketId)).size,
        totalStaked: sum(all, (p) => p.totalStaked).toString(), openStaked: sum(open, (p) => p.totalStaked).toString(),
        paidOut: sum(payouts.filter((t) => t.type === 'winnings'), (t) => t.amount).toString(), refunded: sum(payouts.filter((t) => t.type === 'refund'), (t) => t.amount).toString(),
        unclaimed: all.filter((p) => !p.claimed && ['Resolved', 'Refundable'].includes(markets.get(p.marketId)?.state)).length,
      };
      return { positions: rows.map(view), total, page, limit, summary };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });

  /** Every individual stake and payout by this wallet, newest first, each with its position id and transaction. */
  fastify.get('/api/positions/:address/trades', { schema: { params: addrParams, querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } } } } }, async (request, reply) => {
    try {
      const user = request.params.address.toLowerCase();
      const { page = 1, limit = 25 } = request.query;
      const col = db().collection('trades');
      const [rows, total] = await Promise.all([col.find({ user }).sort({ blockNumber: -1, logIndex: -1 }).skip((page - 1) * limit).limit(limit).toArray(), col.countDocuments({ user })]);
      const markets = new Map((await db().collection('predictions').find({ marketId: { $in: [...new Set(rows.map((r) => r.marketId))] } }).toArray()).map((m) => [m.marketId, m]));
      return { trades: rows.map((t) => ({ ...t, question: markets.get(t.marketId)?.question || null })), total, page, limit };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });

  fastify.get('/api/positions/:address/claimable', { schema: { params: addrParams } }, async (request, reply) => {
    try {
      const address = request.params.address.toLowerCase();
      const claimablePositions = await db().collection('positions').find({ address, claimed: false }).toArray();
      const enriched = await Promise.all(claimablePositions.map(async (pos) => {
        const market = await db().collection('predictions').findOne({ marketId: pos.marketId });
        if (!market || !['Resolved', 'Refundable'].includes(market.state)) return null;
        let netPayout = '0', feeAmount = '0';
        if (market.state === 'Resolved') {
          try { const preview = await computeWinnings(pos.marketId, address); netPayout = preview.netPayout; feeAmount = preview.feeAmount; } catch {}
        } else {
          netPayout = (BigInt(pos.yesShares || '0') + BigInt(pos.noShares || '0')).toString();
        }
        return { ...pos, marketState: market.state, netPayout, feeAmount, question: market.question };
      }));
      const claimable = enriched.filter(Boolean).filter((p) => BigInt(p.netPayout) > 0n);
      return { claimable, count: claimable.length };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });
}

module.exports = positionRoutes;
