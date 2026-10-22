'use strict';

const { db } = require('../db/client');
const { getBlockNumber, getProtocolSettings } = require('../services/contract');
const config = require('../config');

async function healthRoutes(fastify) {
  fastify.get('/health', async (request, reply) => {
    const result = { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
    try { await db().admin().ping(); result.db = 'ok'; }
    catch (err) { result.db = 'error'; result.dbError = err.message; }
    try { result.blockNumber = (await getBlockNumber()).toString(); result.chain = 'ok'; result.chainId = config.arc.chainId; }
    catch (err) { result.chain = 'error'; result.chainError = err.message; }
    return reply.status(result.db === 'ok' ? 200 : 503).send(result);
  });

  fastify.get('/api/protocol/status', async (request, reply) => {
    try {
      const settings = await getProtocolSettings();
      const database = db();
      const [openCount, resolvedCount, totalVolumeResult] = await Promise.all([
        database.collection('predictions').countDocuments({ state: 'Open' }),
        database.collection('predictions').countDocuments({ state: 'Resolved' }),
        database.collection('predictions').aggregate([{ $group: { _id: null, total: { $sum: { $toLong: '$totalPool' } } } }]).toArray(),
      ]);
      return { ...settings, openMarkets: openCount, resolvedMarkets: resolvedCount, totalVolumeUsdc: totalVolumeResult[0]?.total?.toString() || '0' };
    } catch (err) {
      return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' });
    }
  });
}

module.exports = healthRoutes;
