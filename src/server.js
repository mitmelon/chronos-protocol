'use strict';
/**
 * src/server.js
 *
 * Exports buildServer() — a factory that configures and returns a Fastify
 * instance with all plugins, routes, and view/static-asset serving.
 *
 * Entry point: root /server.js calls buildServer() and app.listen().
 * This file should never call listen() itself.
 */

const path    = require('path');
const Fastify = require('fastify');
const cors    = require('@fastify/cors');
const rl      = require('@fastify/rate-limit');
const statics = require('@fastify/static');
const view    = require('@fastify/view');
const ejs     = require('ejs');

const config             = require('./config');
const healthRoutes     = require('./routes/health');
const marketRoutes     = require('./routes/markets');
const positionRoutes   = require('./routes/positions');
const resolutionRoutes = require('./routes/resolutions');
const agentRoutes      = require('./routes/agent');
const settingsRoutes   = require('./routes/settings');
const rateLimitConfig  = require('./middleware/rateLimit');

/**
 * Returns only public, non-secret values the EJS template may use.
 * NEVER include API keys, private keys, DB URIs, or worker secrets here.
 */
function publicViewData() {
  return {
    apiUrl:          '/api',
    contractAddress: config.arc.factoryAddress || '',
    usdcAddress:     config.arc.usdcAddress    || '',
    chainId:         config.arc.chainId,
    explorerUrl:     config.arc.explorerUrl,
    networkName:     config.arc.networkName    || 'Arc Testnet',
    feePct:          (config.protocol.feeBps / 100).toFixed(0),
  };
}

async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  // ── Static assets — served from /public via /assets/* ─────────────────────
  // root server.js is at project root; __dirname here is src/, so go up one.
  await fastify.register(statics, {
    root:          path.join(__dirname, '..', 'public'),
    prefix:        '/assets/',
    decorateReply: false,
  });

  // ── EJS view engine ────────────────────────────────────────────────────────
  await fastify.register(view, {
    engine: { ejs },
    root:   path.join(__dirname, 'views'),
    layout: false,
  });

  // ── Landing + app shell ────────────────────────────────────────────────────
  fastify.get('/', async (_req, reply) => reply.view('index.ejs', publicViewData()));

  // ── CORS ───────────────────────────────────────────────────────────────────
  await fastify.register(cors, {
    origin:         config.corsOrigins,
    methods:        ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────
  await fastify.register(rl, rateLimitConfig.global);

  // ── API routes ─────────────────────────────────────────────────────────────
  await fastify.register(healthRoutes);
  await fastify.register(marketRoutes);
  await fastify.register(positionRoutes);
  await fastify.register(resolutionRoutes);
  await fastify.register(agentRoutes);
  await fastify.register(settingsRoutes);

  // ── Error handler ──────────────────────────────────────────────────────────
  fastify.setErrorHandler(async (err, _req, reply) => {
    fastify.log.error(err);
    if (err.statusCode === 429)
      return reply.status(429).send({ error: true, message: 'Too many requests', code: 'RATE_LIMITED' });
    if (err.validation)
      return reply.status(400).send({ error: true, message: 'Validation error', code: 'VALIDATION_ERROR', details: err.validation });
    return reply.status(500).send({ error: true, message: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  fastify.addHook('onClose', async () => {
    const { close } = require('./db/client');
    await close();
  });

  return fastify;
}

module.exports = { buildServer };
