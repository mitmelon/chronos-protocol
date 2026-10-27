'use strict';
const { db } = require('../db/client');
const contract = require('../services/contract');
const { getStats } = require('../services/stats');

module.exports = async function statsRoutes(fastify) {
  fastify.get('/api/stats', async (_req, reply) => {
    try { return await getStats({ db, contract }); }
    catch (err) { return reply.status(500).send({ error: true, message: err.message, code: 'INTERNAL_ERROR' }); }
  });
};
