'use strict';
/**
 * worker.js — Chronos Protocol background job worker entry point.
 *
 * Start with:  node worker.js
 * Dev mode:    node --watch worker.js
 *
 * This process ONLY runs BullMQ workers for the three job types:
 *   - discovery   (find events, validate, publish markets)
 *   - resolution  (gather evidence, propose outcome, submit on-chain)
 *   - keeper      (close trading, sync DB state)
 *
 * It does NOT serve HTTP requests. Run server.js separately for that.
 * Both processes can run on the same machine or in separate containers.
 * They communicate exclusively through Redis (BullMQ) and MongoDB.
 */

require('dotenv').config();

const { connect }            = require('./src/db/client');
const { ensureIndexes }      = require('./src/db/indexes');
const { startWorkers }       = require('./src/queues/workers');
const { scheduleRepeatJobs } = require('./src/queues/scheduler');

async function main() {
  console.log('[worker] Connecting to MongoDB...');
  await connect();
  await ensureIndexes();

  console.log('[worker] Starting BullMQ workers...');
  await startWorkers();

  console.log('[worker] Scheduling repeating jobs...');
  await scheduleRepeatJobs();

  console.log('[worker] All workers running. Ctrl+C to stop.');
}

main().catch(err => { console.error('[worker] Fatal startup error:', err); process.exit(1); });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[worker] SIGTERM received — shutting down gracefully');
  const { closeWorkers } = require('./src/queues/workers');
  await closeWorkers();
  process.exit(0);
});
