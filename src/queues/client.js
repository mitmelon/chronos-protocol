'use strict';
/**
 * src/queues/client.js
 *
 * Shared BullMQ Queue instances and Redis connection used by both the
 * server (to enqueue jobs via API) and the worker (to process them).
 *
 * Import { discoveryQueue, resolutionQueue, keeperQueue } wherever you
 * need to add or inspect jobs.
 */

const { Queue } = require('bullmq');
const config    = require('../config');

const CONNECTION = {
  host:     config.redis.host,
  port:     config.redis.port,
  password: config.redis.password || undefined,
  db:       config.redis.db,
};

const defaultJobOptions = {
  removeOnComplete: { count: 200 },
  removeOnFail:     { count: 500 },
  attempts:         3,
  backoff: { type: 'exponential', delay: 15_000 },
};

const discoveryQueue  = new Queue('chronos-discovery',  { connection: CONNECTION, defaultJobOptions });
const resolutionQueue = new Queue('chronos-resolution', { connection: CONNECTION, defaultJobOptions });
const keeperQueue     = new Queue('chronos-keeper',     { connection: CONNECTION, defaultJobOptions });

module.exports = { discoveryQueue, resolutionQueue, keeperQueue, CONNECTION };
