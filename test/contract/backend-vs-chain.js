'use strict';
// Runs src/services/contract.js + payouts.js against the real compiled contract (Hardhat in-process node, served over HTTP).
const hre = require('hardhat'); const http = require('http'); const assert = require('assert');
const { createWalletClient, createPublicClient, custom } = require('viem'); const { hardhat } = require('viem/chains'); const { privateKeyToAccount } = require('viem/accounts');
const CH = require('./out/Chronos.json'), USDC = require('./out/MockUSDC.json');
const provider = hre.network.provider;
const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => { const j = JSON.parse(b); try { const result = await provider.request({ method: j.method, params: j.params }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result })); } catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: (() => { const d = e.data && typeof e.data === 'object' ? e.data.data : e.data; return { code: d ? 3 : (e.code || -32000), message: d ? 'execution reverted' : e.message, data: d }; })() })); } }); });
server.listen(0, async () => {
  const port = server.address().port;
  const oracleKey = '0x' + '02'.repeat(32);
  const transport = custom({ request: ({ method, params }) => provider.request({ method, params }) });
  const pub = createPublicClient({ chain: hardhat, transport });
  const keys = ['01', '02', '03', '04', '05'].map((n) => '0x' + n.repeat(32)); const [owner, oracle, alice, bob, carol] = keys.map((k) => privateKeyToAccount(k));
  const wc = (a) => createWalletClient({ account: a, chain: hardhat, transport });
  for (const a of [owner, oracle, alice, bob, carol]) await provider.request({ method: 'hardhat_setBalance', params: [a.address, '0x56BC75E2D63100000'] });
  const dep = async (abi, bytecode, args) => (await pub.waitForTransactionReceipt({ hash: await wc(owner).deployContract({ abi, bytecode, args }) })).contractAddress;
  const usdc = await dep(USDC.abi, USDC.bytecode, []); const chronos = await dep(CH.abi, CH.bytecode, [usdc, oracle.address, owner.address, 500n, 86400n * 180n, owner.address]);
  const tx = async (a, address, abi, functionName, args) => { const { request } = await pub.simulateContract({ address, abi, functionName, args, account: a }); return pub.waitForTransactionReceipt({ hash: await wc(a).writeContract(request) }); };
  for (const a of [alice, bob, carol]) { await tx(owner, usdc, USDC.abi, 'mint', [a.address, 10_000_000_000n]); await tx(a, usdc, USDC.abi, 'approve', [chronos, 10_000_000_000n]); }

  // Point the real backend module at this chain (testnet-style config via env) and the oracle key.
  process.env.ARC_NETWORK = 'testnet'; process.env.ARC_CHAIN_ID = '31337'; process.env.ARC_RPC_URL = `http://127.0.0.1:${port}`; process.env.VITE_FACTORY_ADDRESS = chronos; process.env.ORACLE_PRIVATE_KEY = oracleKey;
  const contract = require('../../src/services/contract.js');
  const { payoutMarket } = require('../../src/agent/payouts.js');
  const config = require('../../src/config.js');
  const { fakeDb } = require('../../test/harness.js');

  const t = Number((await pub.getBlock()).timestamp);
  const created = await contract.createMarket('Will the agent pay everyone automatically?', 'Resolves YES if it does.', t + 1000, t + 5000);
  assert.strictEqual(created.marketId, 0); assert.ok(created.blockNumber > 0); console.log('PASS backend createMarket on the real contract; returns marketId and block number');
  for (const [a, side, amt] of [[alice, 1, 100e6], [bob, 1, 300e6], [carol, 2, 600e6]]) await tx(a, chronos, CH.abi, 'buyShares', [0n, side, BigInt(amt)]);
  await provider.request({ method: 'evm_increaseTime', params: [1100] }); await provider.request({ method: 'evm_mine', params: [] });

  const m = await contract.getMarket(0); assert.strictEqual(m.state, 'Open'); assert.strictEqual(m.yesPool, '400000000'); console.log('PASS getMarket decodes the real struct (feeBps position fixed)');
  await contract.closeTrading(0); assert.strictEqual((await contract.getMarket(0)).state, 'TradingClosed');
  await assert.rejects(contract.closeTrading(0), (e) => e.errorName === 'InvalidMarketState'); console.log('PASS close trading; second close is rejected with a decoded InvalidMarketState error');
  await contract.resolveMarket(0, 1, 'data:evidence'); assert.strictEqual((await contract.getMarket(0)).outcome, 'YES');
  await assert.rejects(contract.resolveMarket(0, 1, 'again'), (e) => e.errorName === 'InvalidMarketState'); console.log('PASS resolve on-chain; resolving twice is rejected by the contract');

  const parts = await contract.getParticipants(0, created.blockNumber); assert.strictEqual(parts.length, 3); console.log('PASS participants found from SharesPurchased logs:', parts.length);
  const bal = async (a) => pub.readContract({ address: usdc, abi: USDC.abi, functionName: 'balanceOf', args: [a.address] });
  const before = [await bal(alice), await bal(bob), await bal(carol)];
  const db = fakeDb(); db.collection('predictions').docs.push({ _id: 1, marketId: 0, createBlock: created.blockNumber });
  const r = await payoutMarket(0, { db: () => db, contract, config, now: () => Date.now(), jobs: { schedulePayout: async () => {} } });
  assert.strictEqual(r.status, 'complete'); assert.strictEqual(r.paid, 2);
  assert.strictEqual((await bal(alice)) - before[0], 242_500_000n); assert.strictEqual((await bal(bob)) - before[1], 727_500_000n); assert.strictEqual(await bal(carol), before[2]);
  console.log('PASS payoutMarket paid alice 242.50 and bob 727.50 USDC automatically; carol (loser) untouched');
  const r2 = await payoutMarket(0, { db: () => db, contract, config, now: () => Date.now(), jobs: { schedulePayout: async () => {} } }); assert.strictEqual(r2.owed, 0); console.log('PASS second payout run owes nothing');
  server.close(); process.exit(0);
});
