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
const config                = require('./src/config');

async function main() {
  // The worker signs transactions: refuse to start without the oracle key or with unsafe mainnet/production settings.
  config.validate({ requireOracleKey: true });
  console.log(`[worker] Network: ${config.arc.networkName} (chain ${config.arc.chainId}, ${config.arc.network})`);

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

// A rejected promise must never silently kill a long-running oracle process.
process.on('unhandledRejection', (err) => console.error('[worker] Unhandled rejection:', err));

// Graceful shutdown: let in-flight agent runs and transactions finish
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received — shutting down gracefully`);
  try {
    const { closeWorkers } = require('./src/queues/workers');
    await closeWorkers();
    const { close } = require('./src/db/client');
    await close();
  } catch (err) { console.error('[worker] Error during shutdown:', err.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
