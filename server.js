'use strict';
/**
 * server.js — Chronos Protocol HTTP entry point.
 *
 *   node server.js          production
 *   node --watch server.js  dev (auto-restart on file change)
 *
 * Starts the Fastify HTTP server only.
 * Background jobs live in worker.js — run that process separately.
 */

require('dotenv').config();

const { connect, close } = require('./src/db/client');
const { ensureIndexes }  = require('./src/db/indexes');
const { buildServer }    = require('./src/server');
const config             = require('./src/config');

async function main() {
  await connect();
  await ensureIndexes();

  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  process.on('SIGTERM', () => shutdown(app, 'SIGTERM'));
  process.on('SIGINT',  () => shutdown(app, 'SIGINT'));

  console.log(`\n  Chronos Protocol — HTTP server (${config.arc.networkName}, chain ${config.arc.chainId})`);
  console.log(`  Listening on http://0.0.0.0:${config.port}`);
  console.log(`  Run \`node worker.js\` separately to start background jobs\n`);
}

// Close the HTTP server and database cleanly on shutdown
async function shutdown(app, signal) {
  console.log(`[server] ${signal} received — shutting down`);
  try { await app.close(); } catch (err) { console.error('[server] Error during shutdown:', err.message); }
  process.exit(0);
}

main().catch(err => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
