'use strict';

const { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const config = require('../config');

// NOTE: the Market tuple MUST match the Solidity struct order exactly (feeBps is LAST).
// The previous ABI put feeBps after settledAmount, which mis-decodes state/outcome or makes getMarket revert.
const CHRONOS_ABI = parseAbi([
  'function marketCount() view returns (uint256)',
  'function getMarket(uint256 marketId) view returns ((string question, string resolutionCriteria, uint64 tradingDeadline, uint64 resolutionDeadline, uint256 yesPool, uint256 noPool, uint256 totalPool, uint256 settledAmount, uint8 outcome, uint8 state, uint64 resolvedAt, string evidenceURI, bool swept, address creator, uint256 feeBps))',
  'function getShares(uint256 marketId, address user) view returns (uint256 yesAmt, uint256 noAmt)',
  'function computeWinnings(uint256 marketId, address user) view returns (uint256 netPayout, uint256 feeAmount)',
  'function oracle() view returns (address)',
  'function treasury() view returns (address)',
  'function feeBps() view returns (uint256)',
  'function gracePeriod() view returns (uint256)',
  'function paused() view returns (bool)',
  'function owner() view returns (address)',
  'function claimed(uint256, address) view returns (bool)',
  'function createMarket(string question, string resolutionCriteria, uint64 tradingDeadline, uint64 resolutionDeadline) returns (uint256 marketId)',
  'function claimWinningsFor(uint256 marketId, address user)',
  'function claimRefundFor(uint256 marketId, address user)',
  'function claimBatch(uint256 marketId, address[] users) returns (uint256 paid)',
  'function MAX_BATCH() view returns (uint256)',
  'function closeTrading(uint256 marketId)',
  'function resolveMarket(uint256 marketId, uint8 outcome, string calldata evidenceURI)',
  'function markRefundable(uint256 marketId)',
  'event MarketCreated(uint256 indexed marketId, address indexed creator, string question, uint64 tradingDeadline, uint64 resolutionDeadline)',
  'event SharesPurchased(uint256 indexed marketId, address indexed buyer, uint8 outcome, uint256 amount)',
  'event TradingClosed(uint256 indexed marketId, uint256 totalPool)',
  'event MarketResolved(uint256 indexed marketId, uint8 outcome, string evidenceURI, uint64 timestamp)',
  'event MarketRefundable(uint256 indexed marketId)',
  'event BatchClaimed(uint256 indexed marketId, address indexed caller, uint256 attempted, uint256 paid)',
  'event WinningsClaimed(uint256 indexed marketId, address indexed claimant, uint256 netPayout, uint256 originalStake, uint256 profit, uint256 fee)',
  'event RefundClaimed(uint256 indexed marketId, address indexed claimant, uint256 amount)',
  // Custom errors, so reverts are decoded by name (the agent matches on these).
  'error AlreadyClaimed()',
  'error AlreadySwept()',
  'error EnforcedPause()',
  'error ExpectedPause()',
  'error GracePeriodNotElapsed()',
  'error InsufficientUSDCReserves()',
  'error InvalidAddress()',
  'error InvalidBatch()',
  'error InvalidCriteria()',
  'error InvalidDeadline()',
  'error InvalidFee()',
  'error InvalidGracePeriod()',
  'error InvalidMarketState(uint8 current, uint8 expected)',
  'error InvalidOutcome()',
  'error InvalidQuestion()',
  'error MarketDoesNotExist(uint256 id)',
  'error NoShares()',
  'error NoUnclaimed()',
  'error TradingClosed_()',
  'error TradingOpen()',
]);

const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

// The chain is built from config (ARC_NETWORK=testnet|mainnet, plus optional overrides), never hard-coded,
// so one build runs on testnet or mainnet depending on the .env it is installed with.
const arcChain = {
  id: config.arc.chainId,
  name: config.arc.networkName,
  nativeCurrency: config.arc.nativeCurrency,
  rpcUrls: { default: { http: [config.arc.rpcUrl] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: config.arc.explorerUrl } },
  testnet: !config.arc.isMainnet,
};

let _publicClient = null;
let _walletClient = null;

function getPublicClient() {
  if (!_publicClient) {
    if (!config.arc.rpcUrl) throw new Error('ARC_RPC_URL not configured');
    _publicClient = createPublicClient({ chain: arcChain, transport: http(config.arc.rpcUrl, { timeout: 20000, retryCount: 3 }) });
  }
  return _publicClient;
}

function getWalletClient() {
  if (!_walletClient) {
    if (!config.oracle.privateKey) throw new Error('ORACLE_PRIVATE_KEY not configured');
    const account = privateKeyToAccount(config.oracle.privateKey);
    _walletClient = createWalletClient({ chain: arcChain, transport: http(config.arc.rpcUrl, { timeout: 20000 }), account });
  }
  return _walletClient;
}

function getOracleAddress() {
  return getWalletClient().account.address;
}

function getChronosAddress() {
  if (!config.arc.factoryAddress) throw new Error('VITE_FACTORY_ADDRESS not configured');
  return config.arc.factoryAddress;
}

async function getMarketCount() {
  return getPublicClient().readContract({ address: getChronosAddress(), abi: CHRONOS_ABI, functionName: 'marketCount' });
}

async function getMarket(marketId) {
  const raw = await getPublicClient().readContract({ address: getChronosAddress(), abi: CHRONOS_ABI, functionName: 'getMarket', args: [BigInt(marketId)] });
  return formatMarket(raw, marketId);
}

async function getShares(marketId, userAddress) {
  const [yesAmt, noAmt] = await getPublicClient().readContract({ address: getChronosAddress(), abi: CHRONOS_ABI, functionName: 'getShares', args: [BigInt(marketId), userAddress] });
  return { yesAmt: yesAmt.toString(), noAmt: noAmt.toString() };
}

async function computeWinnings(marketId, userAddress) {
  const [netPayout, feeAmount] = await getPublicClient().readContract({ address: getChronosAddress(), abi: CHRONOS_ABI, functionName: 'computeWinnings', args: [BigInt(marketId), userAddress] });
  return { netPayout: netPayout.toString(), feeAmount: feeAmount.toString() };
}

async function getProtocolSettings() {
  const client = getPublicClient();
  const addr = getChronosAddress();
  const [oracle, treasury, feeBps, gracePeriod, paused, owner] = await Promise.all([
    client.readContract({ address: addr, abi: CHRONOS_ABI, functionName: 'oracle' }),
    client.readContract({ address: addr, abi: CHRONOS_ABI, functionName: 'treasury' }),
    client.readContract({ address: addr, abi: CHRONOS_ABI, functionName: 'feeBps' }),
    client.readContract({ address: addr, abi: CHRONOS_ABI, functionName: 'gracePeriod' }),
    client.readContract({ address: addr, abi: CHRONOS_ABI, functionName: 'paused' }),
    client.readContract({ address: addr, abi: CHRONOS_ABI, functionName: 'owner' }),
  ]);
  return {
    oracle, treasury,
    feeBps: Number(feeBps),
    gracePeriodDays: Number(gracePeriod) / 86400,
    paused, owner,
    contractAddress: addr,
    chainId: config.arc.chainId,
    usdcAddress: config.arc.usdcAddress,
  };
}

async function getBlockNumber() {
  return getPublicClient().getBlockNumber();
}

/**
 * Send a write: simulate first (reverts surface by NAME before any gas is spent), broadcast,
 * then wait for the receipt and verify it succeeded.
 *
 * Errors thrown:
 *   - err.errorName       decoded custom error, e.g. "InvalidMarketState", when simulation reverted
 *   - err.unconfirmed     true if the tx was broadcast but no receipt arrived in time. err.txHash is set.
 *                         The tx may still land: callers must NOT blindly resubmit; re-read chain state.
 */
// One oracle wallet, several workers: send transactions strictly one at a time (through confirmation),
// otherwise concurrent sends collide on the same nonce.
let _txChain = Promise.resolve();
function serial(fn) {
  const run = _txChain.then(fn, fn);
  _txChain = run.catch(() => {});
  return run;
}

let _chainVerified = false;
/** Refuse to sign anything if the RPC is not the chain this deployment is configured for. */
async function assertChain() {
  if (_chainVerified) return;
  const id = await getPublicClient().getChainId();
  if (id !== config.arc.chainId) throw new Error(`RPC chain id ${id} does not match configured ${config.arc.network} (${config.arc.chainId}). Refusing to send transactions.`);
  _chainVerified = true;
}

function sendTx(functionName, args, opts) { return serial(() => sendTxUnserialized(functionName, args, opts)); }

async function sendTxUnserialized(functionName, args, { timeoutMs = 90000 } = {}) {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const address = getChronosAddress();
  await assertChain();

  let request;
  try {
    ({ request } = await client.simulateContract({ address, abi: CHRONOS_ABI, functionName, args, account: wallet.account }));
  } catch (err) {
    // viem wraps the decoded custom error somewhere in the cause chain; walk it instead of guessing the depth
    const revert = typeof err?.walk === 'function' ? err.walk((e) => e?.data?.errorName) : null;
    const name = revert?.data?.errorName || err?.cause?.data?.errorName || err?.cause?.cause?.data?.errorName || err?.data?.errorName;
    const wrapped = new Error(`${functionName} would revert${name ? ` (${name})` : ''}: ${err.shortMessage || err.message}`);
    wrapped.errorName = name || null;
    throw wrapped;
  }

  const hash = await wallet.writeContract(request);

  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  } catch (err) {
    const e = new Error(`${functionName} broadcast (tx ${hash}) but not confirmed within ${timeoutMs}ms: ${err.shortMessage || err.message}`);
    e.unconfirmed = true;
    e.txHash = hash;
    throw e;
  }
  if (receipt.status !== 'success') {
    const e = new Error(`${functionName} reverted on-chain (tx ${hash})`);
    e.txHash = hash;
    throw e;
  }
  return { txHash: hash, receipt };
}

async function closeTrading(marketId) {
  const { txHash } = await sendTx('closeTrading', [BigInt(marketId)]);
  return { txHash };
}

async function resolveMarket(marketId, outcome, evidenceURI) {
  const { txHash } = await sendTx('resolveMarket', [BigInt(marketId), outcome, evidenceURI]);
  return { txHash };
}

async function markRefundable(marketId) {
  const { txHash } = await sendTx('markRefundable', [BigInt(marketId)]);
  return { txHash };
}

/** Create a market on-chain and return its new id (read from the MarketCreated log). */
async function createMarket(question, resolutionCriteria, tradingDeadlineSecs, resolutionDeadlineSecs) {
  const { txHash, receipt } = await sendTx('createMarket', [question, resolutionCriteria, BigInt(tradingDeadlineSecs), BigInt(resolutionDeadlineSecs)]);
  const marketId = marketIdFromReceipt(receipt);
  if (marketId === null) throw Object.assign(new Error(`createMarket confirmed but no MarketCreated log found (tx ${txHash})`), { txHash, unconfirmed: true });
  return { txHash, marketId, blockNumber: Number(receipt.blockNumber) };
}

function marketIdFromReceipt(receipt) {
  const logs = parseEventLogs({ abi: CHRONOS_ABI, eventName: 'MarketCreated', logs: receipt.logs })
    .filter((l) => l.address.toLowerCase() === getChronosAddress().toLowerCase());
  return logs.length ? Number(logs[0].args.marketId) : null;
}

/** Look up a previously broadcast createMarket tx: { status: 'success'|'reverted'|'pending', marketId? } */
async function getCreateMarketResult(txHash) {
  try {
    const receipt = await getPublicClient().getTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') return { status: 'reverted' };
    const marketId = marketIdFromReceipt(receipt);
    return marketId === null ? { status: 'reverted' } : { status: 'success', marketId };
  } catch (err) {
    if (/not be found|TransactionReceiptNotFound/i.test(err.name + err.message)) return { status: 'pending' };
    throw err;
  }
}

async function isClaimed(marketId, user) {
  return getPublicClient().readContract({ address: getChronosAddress(), abi: CHRONOS_ABI, functionName: 'claimed', args: [BigInt(marketId), user] });
}

/** Everyone who ever bought into this market (from SharesPurchased logs). Pages the log query and shrinks the range if the RPC limits it. */
async function getParticipants(marketId, fromBlock = 0) {
  const client = getPublicClient();
  const address = getChronosAddress();
  const event = CHRONOS_ABI.find((e) => e.type === 'event' && e.name === 'SharesPurchased');
  const latest = await client.getBlockNumber();
  const users = new Map();
  let from = BigInt(fromBlock), step = 50000n;
  while (from <= latest) {
    const to = from + step - 1n > latest ? latest : from + step - 1n;
    try {
      const logs = await client.getLogs({ address, event, args: { marketId: BigInt(marketId) }, fromBlock: from, toBlock: to });
      for (const l of logs) users.set(l.args.buyer.toLowerCase(), l.args.buyer);
      from = to + 1n;
    } catch (err) {
      if (step > 500n) { step = step / 2n; continue; } // RPC rejected the range: retry smaller
      throw err;
    }
  }
  return [...users.values()];
}

/** Pay many participants in one transaction (winnings if Resolved, refunds if Refundable). Funds only ever go to each participant. */
async function claimBatch(marketId, users) {
  const { txHash, receipt } = await sendTx('claimBatch', [BigInt(marketId), users]);
  const log = parseEventLogs({ abi: CHRONOS_ABI, eventName: 'BatchClaimed', logs: receipt.logs })[0];
  return { txHash, attempted: log ? Number(log.args.attempted) : users.length, paid: log ? Number(log.args.paid) : null };
}

async function getMarketEvents(marketId, fromBlock, toBlock) {
  const client = getPublicClient();
  const addr = getChronosAddress();
  const [created, purchases, resolved, tradingClosed, refundable] = await Promise.all([
    client.getLogs({ address: addr, event: CHRONOS_ABI.find(e => e.name === 'MarketCreated'), args: { marketId: BigInt(marketId) }, fromBlock, toBlock }),
    client.getLogs({ address: addr, event: CHRONOS_ABI.find(e => e.name === 'SharesPurchased'), args: { marketId: BigInt(marketId) }, fromBlock, toBlock }),
    client.getLogs({ address: addr, event: CHRONOS_ABI.find(e => e.name === 'MarketResolved'), args: { marketId: BigInt(marketId) }, fromBlock, toBlock }),
    client.getLogs({ address: addr, event: CHRONOS_ABI.find(e => e.name === 'TradingClosed'), args: { marketId: BigInt(marketId) }, fromBlock, toBlock }),
    client.getLogs({ address: addr, event: CHRONOS_ABI.find(e => e.name === 'MarketRefundable'), args: { marketId: BigInt(marketId) }, fromBlock, toBlock }),
  ]);
  return { created, purchases, resolved, tradingClosed, refundable };
}

const STATE_NAMES = ['Open', 'TradingClosed', 'Resolved', 'Refundable', 'Settled'];
const OUTCOME_NAMES = ['UNRESOLVED', 'YES', 'NO'];

function formatMarket(raw, marketId) {
  // Never default an unknown state to 'Open': that would let the keeper/resolver act on a market it can't read.
  if (STATE_NAMES[raw.state] === undefined) throw new Error(`Market ${marketId} has unknown state ${raw.state}`);
  return {
    marketId: Number(marketId),
    question: raw.question,
    resolutionCriteria: raw.resolutionCriteria,
    tradingDeadline: new Date(Number(raw.tradingDeadline) * 1000),
    resolutionDeadline: new Date(Number(raw.resolutionDeadline) * 1000),
    yesPool: raw.yesPool.toString(),
    noPool: raw.noPool.toString(),
    totalPool: raw.totalPool.toString(),
    settledAmount: raw.settledAmount.toString(),
    feeBps: Number(raw.feeBps),
    outcome: OUTCOME_NAMES[raw.outcome] || 'UNRESOLVED',
    state: STATE_NAMES[raw.state],
    resolvedAt: raw.resolvedAt > 0n ? new Date(Number(raw.resolvedAt) * 1000) : null,
    evidenceURI: raw.evidenceURI,
    swept: raw.swept,
    creator: raw.creator,
  };
}

module.exports = {
  getMarketCount, getMarket, getShares, computeWinnings,
  getProtocolSettings, getBlockNumber,
  createMarket, getCreateMarketResult, claimBatch, isClaimed, getParticipants,
  closeTrading, resolveMarket, markRefundable, getMarketEvents,
  getPublicClient, getWalletClient, getOracleAddress, CHRONOS_ABI, USDC_ABI, arcChain, arcTestnet: arcChain,
  _internal: { formatMarket, serial },
};
