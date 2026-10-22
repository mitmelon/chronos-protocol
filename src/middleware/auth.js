'use strict';

const config = require('../config');

async function workerAuth(request, reply) {
  const authHeader = request.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: true, message: 'Unauthorized', code: 'UNAUTHORIZED' });
  }
  const token = authHeader.slice(7);
  if (token !== config.worker.secret) {
    return reply.status(401).send({ error: true, message: 'Unauthorized', code: 'UNAUTHORIZED' });
  }
}

module.exports = { workerAuth };
