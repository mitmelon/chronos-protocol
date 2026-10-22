'use strict';

const { createPublicClient, createWalletClient, http, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const config = require('../config');

const CHRONOS_ABI = parseAbi([
  'function marketCount() view returns (uint256)',
  'function getMarket(uint256 marketId) view returns ((string question, string resolutionCriteria, uint64 tradingDeadline, uint64 resolutionDeadline, uint256 yesPool, uint256 noPool, uint256 totalPool, uint256 settledAmount, uint256 feeBps, uint8 outcome, uint8 state, uint64 resolvedAt, string evidenceURI, bool swept, address creator))',
  'function getShares(uint256 marketId, address user) view returns (uint256 yesAmt, uint256 noAmt)',
  'function computeWinnings(uint256 marketId, address user) view returns (uint256 netPayout, uint256 feeAmount)',
  'function oracle() view returns (address)',
  'function treasury() view returns (address)',
  'function feeBps() view returns (uint256)',
  'function gracePeriod() view returns (uint256)',
  'function paused() view returns (bool)',
  'function owner() view returns (address)',
  'function claimed(uint256, address) view returns (bool)',
  'function closeTrading(uint256 marketId)',
  'function resolveMarket(uint256 marketId, uint8 outcome, string calldata evidenceURI)',
  'function markRefundable(uint256 marketId)',
  'event MarketCreated(uint256 indexed marketId, address indexed creator, string question, uint64 tradingDeadline, uint64 resolutionDeadline)',
  'event SharesPurchased(uint256 indexed marketId, address indexed buyer, uint8 outcome, uint256 amount)',
  'event TradingClosed(uint256 indexed marketId, uint256 totalPool)',
  'event MarketResolved(uint256 indexed marketId, uint8 outcome, string evidenceURI, uint64 timestamp)',
  'event MarketRefundable(uint256 indexed marketId)',
  'event WinningsClaimed(uint256 indexed marketId, address indexed claimant, uint256 netPayout, uint256 originalStake, uint256 profit, uint256 fee)',
  'event RefundClaimed(uint256 indexed marketId, address indexed claimant, uint256 amount)',
]);

const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [config.arc.rpcUrl] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: config.arc.explorerUrl } },
};

let _publicClient = null;
let _walletClient = null;

function getPublicClient() {
  if (!_publicClient) {
    if (!config.arc.rpcUrl) throw new Error('ARC_RPC_URL not configured');
    _publicClient = createPublicClient({ chain: arcTestnet, transport: http(config.arc.rpcUrl) });
  }
  return _publicClient;
}

function getWalletClient() {
  if (!_walletClient) {
    if (!config.oracle.privateKey) throw new Error('ORACLE_PRIVATE_KEY not configured');
    const account = privateKeyToAccount(config.oracle.privateKey);
    _walletClient = createWalletClient({ chain: arcTestnet, transport: http(config.arc.rpcUrl), account });
  }
  return _walletClient;
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

async function closeTrading(marketId) {
  const hash = await getWalletClient().writeContract({ address: getChronosAddress(), abi: CHRONOS_ABI, functionName: 'closeTrading', args: [BigInt(marketId)] });
  return { txHash: hash };
}

async function resolveMarket(marketId, outcome, evidenceURI) {
  const hash = await getWalletClient().writeContract({ address: getChronosAddress(), abi: CHRONOS_ABI, functionName: 'resolveMarket', args: [BigInt(marketId), outcome, evidenceURI] });
  return { txHash: hash };
}

async function markRefundable(marketId) {
  const hash = await getWalletClient().writeContract({ address: getChronosAddress(), abi: CHRONOS_ABI, functionName: 'markRefundable', args: [BigInt(marketId)] });
  return { txHash: hash };
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
    state: STATE_NAMES[raw.state] || 'Open',
    resolvedAt: raw.resolvedAt > 0 ? new Date(Number(raw.resolvedAt) * 1000) : null,
    evidenceURI: raw.evidenceURI,
    swept: raw.swept,
    creator: raw.creator,
  };
}

module.exports = {
  getMarketCount, getMarket, getShares, computeWinnings,
  getProtocolSettings, getBlockNumber,
  closeTrading, resolveMarket, markRefundable, getMarketEvents,
  getPublicClient, CHRONOS_ABI, USDC_ABI, arcTestnet,
};
