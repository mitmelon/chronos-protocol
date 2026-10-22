'use strict';
/**
 * src/queues/workers.js
 *
 * Instantiates one BullMQ Worker per queue. Each worker calls the
 * corresponding agent function (runDiscovery, runResolution, runKeeper)
 * and handles concurrency, retries, and stalled-job detection.
 *
 * startWorkers() is called once by worker.js at startup.
 * closeWorkers() drains in-flight jobs before the process exits.
 */

const { Worker } = require('bullmq');
const { CONNECTION } = require('./client');
const { runDiscovery } = require('../agent/discover');
const { runResolution } = require('../agent/resolve');
const { runKeeper }    = require('../agent/keeper');

const CONCURRENCY = 1; // each job type runs serially to avoid race conditions

let _workers = [];

async function startWorkers() {
  const discoveryWorker = new Worker(
    'chronos:discovery',
    async (job) => {
      console.log(`[worker:discovery] Starting job ${job.id}`);
      const result = await runDiscovery();
      console.log(`[worker:discovery] Job ${job.id} done — published: ${result.marketsPublished}, rejected: ${result.marketsRejected}`);
      return result;
    },
    {
      connection:  CONNECTION,
      concurrency: CONCURRENCY,
      // Stalled jobs (worker crash mid-job) are re-queued after 30s
      stalledInterval: 30_000,
    },
  );

  const resolutionWorker = new Worker(
    'chronos:resolution',
    async (job) => {
      console.log(`[worker:resolution] Starting job ${job.id}`);
      const result = await runResolution();
      console.log(`[worker:resolution] Job ${job.id} done — resolved: ${result.marketsResolved}, refunded: ${result.marketsRefunded}`);
      return result;
    },
    {
      connection:  CONNECTION,
      concurrency: CONCURRENCY,
      stalledInterval: 30_000,
    },
  );

  const keeperWorker = new Worker(
    'chronos:keeper',
    async (job) => {
      console.log(`[worker:keeper] Starting job ${job.id}`);
      const result = await runKeeper();
      console.log(`[worker:keeper] Job ${job.id} done — closed: ${result.tradingClosed}, synced: ${result.dbSynced}`);
      return result;
    },
    {
      connection:  CONNECTION,
      concurrency: CONCURRENCY,
      stalledInterval: 30_000,
    },
  );

  // Shared error logging
  for (const w of [discoveryWorker, resolutionWorker, keeperWorker]) {
    w.on('failed', (job, err) => {
      console.error(`[worker:${w.name}] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
    });
    w.on('error', (err) => {
      console.error(`[worker:${w.name}] Worker error:`, err.message);
    });
  }

  _workers = [discoveryWorker, resolutionWorker, keeperWorker];
  console.log('[worker] BullMQ workers started: discovery, resolution, keeper');
}

async function closeWorkers() {
  await Promise.all(_workers.map(w => w.close()));
  _workers = [];
  console.log('[worker] All BullMQ workers closed');
}

module.exports = { startWorkers, closeWorkers };
