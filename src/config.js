'use strict';

require('dotenv').config();

function optional(name, defaultVal) {
  return process.env[name] || defaultVal;
}

// Build the Arc RPC URL from the proxy if available, otherwise fall back to public Arc Testnet RPC
function buildRpcUrl(compassChain) {
  const proxyBase = process.env.RPC_PROXY_BASE_URL;
  const proxyToken = process.env.RPC_PROXY_TOKEN;
  const proxyChains = (process.env.RPC_PROXY_CHAINS || '').split(',').map(s => s.trim());
  if (proxyBase && proxyToken && proxyChains.includes(compassChain)) {
    return `${proxyBase}/api/rpc/${compassChain}?_rpc_token=${proxyToken}`;
  }
  // Fall back to public RPC configured in .env — rate limit is unknown, measure before going to production
  return optional('ARC_RPC_URL', '');
}

module.exports = {
  port: parseInt(optional('PORT', '5173'), 10),
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:8080').split(',').map(s => s.trim()),

  mongodb: {
    uri: optional('MONGODB_URI', 'mongodb://localhost:27017/chronos'),
  },

  arc: {
    rpcUrl:         buildRpcUrl('Arc_Testnet'),
    chainId:        parseInt(optional('ARC_CHAIN_ID', '5042002'), 10),
    usdcAddress:    optional('VITE_ARC_USDC_ADDRESS', ''),
    factoryAddress: optional('VITE_FACTORY_ADDRESS', ''),
    explorerUrl:    optional('ARC_EXPLORER_URL', 'https://explorer.testnet.arc.io'),
    networkName:    optional('ARC_NETWORK_NAME', 'Arc Testnet'),
  },

  protocol: {
    treasury: optional('PROTOCOL_TREASURY', ''),
    feeBps: parseInt(optional('PROTOCOL_FEE_BPS', '500'), 10),
    gracePeriodSeconds: parseInt(optional('GRACE_PERIOD_SECONDS', '15552000'), 10),
  },

  oracle: {
    // NEVER log or return this value in any API response
    privateKey: optional('ORACLE_PRIVATE_KEY', ''),
  },

  worker: {
    secret: optional('WORKER_SECRET', 'dev-worker-secret'),
  },

  gemini: {
    apiKey: optional('GEMINI_API_KEY', ''),
    model: optional('GEMINI_MODEL', 'gemini-1.5-pro'),
  },

  parallel: {
    apiKey: optional('PARALLEL_API_KEY', ''),
  },

  agent: {
    maxMarketsPerDay:        parseInt(optional('AGENT_MAX_MARKETS_PER_DAY', '3'), 10),
    minConfidence:           parseFloat(optional('AGENT_MIN_CONFIDENCE', '0.85')),
    resolutionLookbackHours: parseInt(optional('AGENT_RESOLUTION_LOOKBACK_HOURS', '48'), 10),
    discoverySchedule:       optional('AGENT_DISCOVERY_SCHEDULE', '0 9 * * *'),
    resolutionSchedule:      optional('AGENT_RESOLUTION_SCHEDULE', '*/30 * * * *'),
    keeperSchedule:          optional('AGENT_KEEPER_SCHEDULE', '*/15 * * * *'),
  },

  redis: {
    host:     optional('REDIS_HOST', '127.0.0.1'),
    port:     parseInt(optional('REDIS_PORT', '6379'), 10),
    password: optional('REDIS_PASSWORD', ''),
    db:       parseInt(optional('REDIS_DB', '0'), 10),
  },
};
