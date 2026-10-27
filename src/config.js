'use strict';

require('dotenv').config();

function optional(name, defaultVal) {
  const v = process.env[name];
  return v === undefined || v === '' ? defaultVal : v;
}
const int   = (name, def) => parseInt(optional(name, String(def)), 10);
const float = (name, def) => parseFloat(optional(name, String(def)));
const bool  = (name, def) => !['false', '0', 'no', 'off'].includes(String(optional(name, String(def))).toLowerCase());

// ── Network ──────────────────────────────────────────────────────────────────
// ARC_NETWORK=testnet|mainnet selects a preset. Every value can still be overridden individually,
// so the same code runs on either chain depending on the .env of the machine it is installed on.
// Endpoints are from Arc's official docs. Both hostnames of the primary RPC are listed because the docs use
// both (.io and .network); the client tries them in order and falls back automatically.
const ARC_PRESETS = {
  testnet: {
    chainId: 5042002, name: 'Arc Testnet',
    rpcUrls: ['https://rpc.testnet.arc.io', 'https://rpc.testnet.arc.network', 'https://rpc.drpc.testnet.arc.network'],
    explorerUrl: 'https://testnet.arcscan.app', usdc: '0x3600000000000000000000000000000000000000', proxyChain: 'Arc_Testnet',
  },
  mainnet: {
    chainId: 5042, name: 'Arc',
    rpcUrls: ['https://rpc.mainnet.arc.io', 'https://rpc.drpc.mainnet.arc.io'],
    explorerUrl: 'https://explorer.arc.io', usdc: '0x3600000000000000000000000000000000000000', proxyChain: 'Arc_Mainnet',
  },
};

const networkKey = optional('ARC_NETWORK', 'testnet').toLowerCase();
if (!ARC_PRESETS[networkKey]) throw new Error(`ARC_NETWORK must be "testnet" or "mainnet" (got "${networkKey}")`);
const preset = ARC_PRESETS[networkKey];

// RPC list: the proxy if configured for this chain, else ARC_RPC_URL (comma-separated allowed), else the presets.
function buildRpcUrls() {
  const proxyBase = process.env.RPC_PROXY_BASE_URL;
  const proxyToken = process.env.RPC_PROXY_TOKEN;
  const proxyChains = (process.env.RPC_PROXY_CHAINS || '').split(',').map((s) => s.trim());
  const chainName = optional('RPC_PROXY_CHAIN_NAME', preset.proxyChain);
  if (proxyBase && proxyToken && proxyChains.includes(chainName)) return [`${proxyBase}/api/rpc/${chainName}?_rpc_token=${proxyToken}`];
  const custom = optional('ARC_RPC_URL', '').split(',').map((s) => s.trim()).filter(Boolean);
  return custom.length ? custom : preset.rpcUrls;
}

const chainId = int('ARC_CHAIN_ID', preset.chainId);
const arc = {
  network:        networkKey,
  isMainnet:      networkKey === 'mainnet',
  rpcUrls:        buildRpcUrls(),
  rpcUrl:         buildRpcUrls()[0],
  chainId,
  usdcAddress:    optional('VITE_ARC_USDC_ADDRESS', preset.usdc),
  factoryAddress: optional('VITE_FACTORY_ADDRESS', ''),
  explorerUrl:    optional('ARC_EXPLORER_URL', preset.explorerUrl),
  networkName:    optional('ARC_NETWORK_NAME', preset.name),
};
// Arc uses USDC as the native gas token (18 decimals natively; the ERC-20 interface uses 6).
arc.nativeCurrency = { name: 'USDC', symbol: 'USDC', decimals: 18 };

/** Public chain description. Safe to expose to the browser (no proxy token: the public RPC URL is used). */
arc.publicChain = {
  id: chainId,
  hex: '0x' + chainId.toString(16),
  name: arc.networkName,
  network: networkKey,
  rpcUrl: optional('ARC_PUBLIC_RPC_URL', preset.rpcUrls[0]),
  explorerUrl: arc.explorerUrl,
  nativeCurrency: arc.nativeCurrency,
  usdcAddress: arc.usdcAddress,
};

/**
 * Accepts a private key with or without 0x, and tolerates quotes/whitespace pasted into .env.
 * Returns '' when unset; any other value is returned normalised and checked by config.validate().
 */
function normalizePrivateKey(raw) {
  let k = String(raw || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(k)) k = '0x' + k;
  return k;
}

/** Why a value is not a usable private key (never echoes the value), or null if it is fine. */
function privateKeyProblem(k) {
  if (!k) return 'ORACLE_PRIVATE_KEY is not set';
  if (/^0x[0-9a-fA-F]{64}$/.test(k)) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(k)) return 'ORACLE_PRIVATE_KEY looks like a wallet ADDRESS (42 characters). It must be the wallet\'s PRIVATE KEY (64 hex characters)';
  if (/\s/.test(k)) return 'ORACLE_PRIVATE_KEY looks like a recovery phrase. Use the private key (64 hex characters), not the seed words';
  return `ORACLE_PRIVATE_KEY is not valid: expected 64 hex characters (optionally starting with 0x), got ${k.replace(/^0x/, '').length} characters`;
}

/**
 * MongoDB settings. The connection string, the database NAME and the login database (authSource) are three
 * separate things; mixing them is the classic cause of "Authentication failed".
 *   MONGODB_URI          server (and credentials) only, e.g. mongodb://admin:password@localhost:27017
 *   MONGODB_DB_NAME      which database to use (default: the path in the URI, else "chronos")
 *   MONGODB_AUTH_SOURCE  which database holds the user (default: "admin" when the URI has credentials)
 * A "/dbname" in the URI and an ?authSource=... in the URI are still honoured.
 */
function resolveMongo(uri, env = process.env) {
  const hasCreds = /^mongodb(\+srv)?:\/\/[^/@]+@/.test(uri);
  const uriAuthSource = /[?&]authSource=/i.test(uri);
  const pathDb = (uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/) || [])[1];
  return {
    uri,
    dbName: env.MONGODB_DB_NAME || pathDb || 'chronos',
    // undefined = let the URI decide
    authSource: env.MONGODB_AUTH_SOURCE || (uriAuthSource ? undefined : hasCreds ? 'admin' : undefined),
  };
}

const config = {
  env: optional('NODE_ENV', 'development'),
  port: int('PORT', 5173),
  // Set TRUST_PROXY=true when running behind a reverse proxy / load balancer (needed for HTTPS cookie detection).
  trustProxy: bool('TRUST_PROXY', false),
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:8080').split(',').map((s) => s.trim()),

  mongodb: resolveMongo(optional('MONGODB_URI', 'mongodb://localhost:27017')),

  arc,

  protocol: {
    treasury: optional('PROTOCOL_TREASURY', ''),
    feeBps: int('PROTOCOL_FEE_BPS', 500),
    gracePeriodSeconds: int('GRACE_PERIOD_SECONDS', 15552000),
  },

  oracle: {
    // NEVER log or return this value in any API response
    privateKey: normalizePrivateKey(optional('ORACLE_PRIVATE_KEY', '')),
  },

  worker: { secret: optional('WORKER_SECRET', 'dev-worker-secret') },

  auth: {
    // HMAC key for session cookies. REQUIRED in production / on mainnet.
    sessionSecret: optional('SESSION_SECRET', ''),
    sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 3600),
    nonceTtlSeconds: 600,
    cookieName: 'chronos_session',
  },

  gemini: {
    apiKey: optional('GEMINI_API_KEY', ''),
    // The agent model. Gemini 1.5 and 2.5 are retired; gemini-3.8-flash is the current agentic Flash model.
    model: optional('GEMINI_MODEL', 'gemini-3.8-flash'),
    // Client-side rate limit (requests per minute) so the agent never trips free-tier quotas and wastes retries.
    maxRpm: int('GEMINI_MAX_RPM', 10),
    // Independent second-opinion model for market vetting and resolution verification.
    verifierModel: optional('GEMINI_VERIFIER_MODEL', optional('GEMINI_MODEL', 'gemini-3.8-flash')),
  },

  parallel: {
    apiKey: optional('PARALLEL_API_KEY', ''),
    baseUrl: optional('PARALLEL_BASE_URL', 'https://api.parallel.ai'),
  },

  agent: {
    maxMarketsPerDay:        int('AGENT_MAX_MARKETS_PER_DAY', 3),
    minConfidence:           float('AGENT_MIN_CONFIDENCE', 0.85),
    resolutionLookbackHours: int('AGENT_RESOLUTION_LOOKBACK_HOURS', 48),
    discoverySchedule:       optional('AGENT_DISCOVERY_SCHEDULE', '0 9 * * *'),
    resolutionSchedule:      optional('AGENT_RESOLUTION_SCHEDULE', '*/30 * * * *'),
    // Run discovery once when the worker starts (default off: `node --watch` restarts the worker on every file save)
    discoveryOnStart:        bool('AGENT_DISCOVERY_ON_START', false),
    keeperSchedule:          optional('AGENT_KEEPER_SCHEDULE', '*/15 * * * *'),

    // Selection: outcomes must be genuinely uncertain
    minProbability:          float('AGENT_MIN_PROBABILITY', 0.2),
    maxProbability:          float('AGENT_MAX_PROBABILITY', 0.8),
    duplicateSimilarity:     float('AGENT_DUPLICATE_SIMILARITY', 0.75),
    minTradingLeadHours:     int('AGENT_MIN_TRADING_LEAD_HOURS', 24),
    maxTradingLeadDays:      int('AGENT_MAX_TRADING_LEAD_DAYS', 120),

    // Text stored ON-CHAIN costs gas per 32 bytes, so it is kept short. Full detail lives in the database.
    maxQuestionChars:        int('AGENT_MAX_QUESTION_CHARS', 200),
    maxCriteriaChars:        int('AGENT_MAX_CRITERIA_CHARS', 500),
    // Safety cap: refuse any single transaction whose estimated gas cost exceeds this many USDC.
    maxTxCostUsdc:           float('AGENT_MAX_TX_COST_USDC', 0.25),
    // resolveMarket already closes trading itself, so a separate closeTrading transaction only burns gas.
    keeperCloseTrading:      bool('AGENT_KEEPER_CLOSE_TRADING', false),
    maxProposalsPerRun:      int('AGENT_MAX_PROPOSALS_PER_RUN', 6),
    // Approved questions wait in the database as 'pending' and are retried until they land on-chain
    autoPublish:             bool('AGENT_AUTO_PUBLISH', true),
    publishMinLeadHours:     int('AGENT_PUBLISH_MIN_LEAD_HOURS', 3),   // give up when less than this much trading time would remain
    publishMaxAttempts:      int('AGENT_PUBLISH_MAX_ATTEMPTS', 8),

    // Agent loop budgets
    maxSteps:                int('AGENT_MAX_STEPS', 16),
    finalMaxSteps:           int('AGENT_FINAL_MAX_STEPS', 28),
    maxSearchesPerRun:       int('AGENT_MAX_SEARCHES', 14),
    maxReadsPerRun:          int('AGENT_MAX_READS', 10),

    // Resolution
    minEvidenceSources:      int('AGENT_MIN_EVIDENCE_SOURCES', 2),
    eventSettleDelayMinutes: int('AGENT_EVENT_SETTLE_DELAY_MINUTES', 60),
    // Persistence: the agent keeps trying until the deadline (a refund is a last resort), but never more often than this.
    retryCapMinutes:         int('AGENT_RETRY_CAP_MINUTES', 120),
    finalAttemptLeadMinutes: int('AGENT_FINAL_ATTEMPT_LEAD_MINUTES', 90),   // one last, bigger attempt this long before the deadline
    maxResolutionsPerSweep:  int('AGENT_MAX_RESOLUTIONS_PER_SWEEP', 8),
    // Push payouts: after a market settles, the agent pays every participant (needs the push-payout contract)
    autoPayout:              bool('AGENT_AUTO_PAYOUT', true),
    payoutBatchSize:         Math.min(100, int('AGENT_PAYOUT_BATCH_SIZE', 25)),
    payoutMaxAttempts:       int('AGENT_PAYOUT_MAX_ATTEMPTS', 5),
    manualResolveCooldownMinutes: int('AGENT_MANUAL_COOLDOWN_MINUTES', 10),
  },

  redis: {
    host:     optional('REDIS_HOST', '127.0.0.1'),
    port:     int('REDIS_PORT', 6379),
    password: optional('REDIS_PASSWORD', ''),
    db:       int('REDIS_DB', 0),
  },
};

/** Fail fast on unsafe configuration. Called at server and worker startup. */
config.validate = function validate({ requireOracleKey = false } = {}) {
  const problems = [];
  const strict = config.env === 'production' || arc.isMainnet;
  if (strict) {
    if (!config.auth.sessionSecret || config.auth.sessionSecret.length < 32) problems.push('SESSION_SECRET must be set to a random string of at least 32 characters');
    if (config.worker.secret === 'dev-worker-secret') problems.push('WORKER_SECRET must be changed from the default');
    if (!arc.factoryAddress) problems.push('VITE_FACTORY_ADDRESS (the Chronos contract address) is required');
  }
  if (arc.isMainnet && chainId !== 5042 && !process.env.ARC_CHAIN_ID) problems.push('Mainnet chain id mismatch');
  if (requireOracleKey || config.oracle.privateKey) { const pk = privateKeyProblem(config.oracle.privateKey); if (pk) problems.push(pk); }
  if (problems.length) throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  return true;
};

config.resolveMongo = resolveMongo;
config.normalizePrivateKey = normalizePrivateKey;
config.privateKeyProblem = privateKeyProblem;

module.exports = config;
