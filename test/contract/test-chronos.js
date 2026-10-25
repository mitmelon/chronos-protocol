'use strict';
// Real-EVM tests (Hardhat in-process network) for the push-payout functions.
const hre = require('hardhat');
const assert = require('assert');
const { createWalletClient, createPublicClient, custom, getAddress } = require('viem');
const { hardhat } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const CH = require('./out/Chronos.json'), USDC = require('./out/MockUSDC.json');

const provider = hre.network.provider;
const transport = custom({ request: ({ method, params }) => provider.request({ method, params }) });
const pub = createPublicClient({ chain: hardhat, transport });
const keys = ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32), '0x' + '03'.repeat(32), '0x' + '04'.repeat(32), '0x' + '05'.repeat(32), '0x' + '06'.repeat(32)];
const accts = keys.map((k) => privateKeyToAccount(k));
const wc = (a) => createWalletClient({ account: a, chain: hardhat, transport });
const [owner, oracle, alice, bob, carol, dave] = accts;
const U = (n) => BigInt(Math.round(n * 1e6));
let nonce = 0;
const mine = async (secs) => { await provider.request({ method: 'evm_increaseTime', params: [secs] }); await provider.request({ method: 'evm_mine', params: [] }); };
const now = async () => Number((await pub.getBlock()).timestamp);

async function fund() { for (const a of accts) await provider.request({ method: 'hardhat_setBalance', params: [a.address, '0x56BC75E2D63100000'] }); }
async function deploy(abi, bytecode, args, from) { const h = await wc(from).deployContract({ abi, bytecode, args }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function send(from, address, abi, functionName, args) { const { request } = await pub.simulateContract({ address, abi, functionName, args, account: from }); const h = await wc(from).writeContract(request); return pub.waitForTransactionReceipt({ hash: h }); }
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const { toFunctionSelector } = require('viem');
const util = require('util');
const errSel = (name) => { const it = CH.abi.find((x) => x.type === 'error' && x.name === name); return toFunctionSelector(`${name}(${it.inputs.map((i) => i.type).join(',')})`).slice(2).toLowerCase(); };
// A revert is identified by its custom-error selector appearing in the error payload.
async function reverts(promise, name) {
  try { await promise; } catch (e) { const t = util.inspect(e, { depth: 8 }).toLowerCase(); assert.ok(t.includes(errSel(name)), `expected ${name} (${errSel(name)}), got: ${t.slice(0, 300)}`); return; }
  assert.fail(`expected revert ${name}`);
}

(async () => {
  await fund();
  const usdc = await deploy(USDC.abi, USDC.bytecode, [], owner);
  const chronos = await deploy(CH.abi, CH.bytecode, [usdc, oracle.address, owner.address, 500n, 86400n * 180n, owner.address], owner);
  for (const a of [alice, bob, carol, dave]) { await send(owner, usdc, USDC.abi, 'mint', [a.address, U(10000)]); await send(a, usdc, USDC.abi, 'approve', [chronos, U(10000)]); }
  const bal = (a) => read(usdc, USDC.abi, 'balanceOf', [a.address]);
  const ok = (m) => console.log('PASS', m);

  async function newMarket() {
    const t = await now();
    await send(owner, chronos, CH.abi, 'createMarket', ['Will X happen by Friday?', 'Resolves YES if X happens', BigInt(t + 1000), BigInt(t + 5000)]);
    return Number(await read(chronos, CH.abi, 'marketCount')) - 1;
  }
  const buy = (who, id, side, amt) => send(who, chronos, CH.abi, 'buyShares', [BigInt(id), side, U(amt)]);

  // ── Market 0: YES wins. alice 100 YES, bob 300 YES, carol 600 NO, dave 100 NO  (pool 1100, yes 400)
  const m0 = await newMarket();
  await buy(alice, m0, 1, 100); await buy(bob, m0, 1, 300); await buy(carol, m0, 2, 600); await buy(dave, m0, 2, 100);
  await mine(1100);
  await send(oracle, chronos, CH.abi, 'resolveMarket', [BigInt(m0), 1, 'ipfs://evidence']);

  const before = { a: await bal(alice), b: await bal(bob), c: await bal(carol), d: await bal(dave) };
  // a third party (the agent) pays everyone, including losers and a duplicate address, in one transaction
  const agent = oracle;
  const r = await send(agent, chronos, CH.abi, 'claimBatch', [BigInt(m0), [alice.address, bob.address, carol.address, dave.address, alice.address]]);
  const ev = r.logs.find((l) => l.topics[0] && l.address.toLowerCase() === chronos.toLowerCase() && l.data.length === 2 + 128);
  const gain = { a: (await bal(alice)) - before.a, b: (await bal(bob)) - before.b, c: (await bal(carol)) - before.c, d: (await bal(dave)) - before.d };
  // alice stake 100 of yesPool 400: gross = 100*1100/400 = 275, profit 175, fee 8.75, net 266.25 ; bob: gross 825, profit 525, fee 26.25, net 798.75
  assert.strictEqual(gain.a, U(266.25)); assert.strictEqual(gain.b, U(798.75)); assert.strictEqual(gain.c, 0n); assert.strictEqual(gain.d, 0n);
  ok('batch pays each winner exactly the contract formula; losers and duplicates are skipped');
  assert.strictEqual(await read(chronos, CH.abi, 'claimed', [BigInt(m0), alice.address]), true);
  assert.strictEqual(await read(chronos, CH.abi, 'claimed', [BigInt(m0), carol.address]), false);
  ok('claimed flags set only for paid winners');

  await reverts(send(alice, chronos, CH.abi, 'claimWinnings', [BigInt(m0)]), 'AlreadyClaimed'); ok('winner cannot claim a second time after being paid');
  await reverts(send(agent, chronos, CH.abi, 'claimWinningsFor', [BigInt(m0), alice.address]), 'AlreadyClaimed'); ok('claimWinningsFor cannot double-pay either');

  const mk = await read(chronos, CH.abi, 'markets', [BigInt(m0)]);
  const fees = await read(chronos, CH.abi, 'pendingFees');
  const contractBal = await read(usdc, USDC.abi, 'balanceOf', [chronos]);
  assert.strictEqual(fees, U(8.75 + 26.25)); assert.strictEqual(contractBal, U(1100) - U(266.25) - U(798.75));
  ok('accounting: fees accrued 35 USDC; contract still holds the losers\' pool share for fees/sweep, nothing leaked');

  // ── Caller can never redirect funds: funds go to `user`, not msg.sender
  const m1 = await newMarket();
  await buy(alice, m1, 1, 50); await buy(bob, m1, 2, 50);
  await mine(1100); await send(oracle, chronos, CH.abi, 'resolveMarket', [BigInt(m1), 2, 'x']);
  const callerBefore = await bal(carol), bobBefore = await bal(bob);
  await send(carol, chronos, CH.abi, 'claimWinningsFor', [BigInt(m1), bob.address]); // carol (a stranger) pushes bob's payout
  assert.strictEqual(await bal(carol), callerBefore); assert.ok((await bal(bob)) > bobBefore);
  ok('a stranger can push your payout but the money only ever goes to you');

  // ── Blocked address must not block the rest of the batch
  const m2 = await newMarket();
  await buy(alice, m2, 1, 100); await buy(bob, m2, 1, 100); await buy(carol, m2, 2, 100);
  await mine(1100); await send(oracle, chronos, CH.abi, 'resolveMarket', [BigInt(m2), 1, 'x']);
  await send(owner, usdc, USDC.abi, 'setBlocked', [alice.address, true]);
  const bb = await bal(bob);
  const r2 = await send(agent, chronos, CH.abi, 'claimBatch', [BigInt(m2), [alice.address, bob.address]]);
  assert.ok((await bal(bob)) > bb); assert.strictEqual(await read(chronos, CH.abi, 'claimed', [BigInt(m2), alice.address]), false);
  ok('a transfer that reverts for one address (blocklisted) skips only that address');
  await send(owner, usdc, USDC.abi, 'setBlocked', [alice.address, false]);
  await send(agent, chronos, CH.abi, 'claimBatch', [BigInt(m2), [alice.address]]); assert.strictEqual(await read(chronos, CH.abi, 'claimed', [BigInt(m2), alice.address]), true);
  ok('...and that address can be paid later once it can receive');

  // ── Refund path
  const m3 = await newMarket();
  await buy(alice, m3, 1, 40); await buy(bob, m3, 2, 60); await buy(carol, m3, 1, 25);
  await mine(6000); // past resolution deadline
  await send(agent, chronos, CH.abi, 'markRefundable', [BigInt(m3)]);
  const rb = { a: await bal(alice), b: await bal(bob), c: await bal(carol), d: await bal(dave) };
  await send(agent, chronos, CH.abi, 'claimBatch', [BigInt(m3), [alice.address, bob.address, carol.address, dave.address]]);
  assert.strictEqual((await bal(alice)) - rb.a, U(40)); assert.strictEqual((await bal(bob)) - rb.b, U(60)); assert.strictEqual((await bal(carol)) - rb.c, U(25)); assert.strictEqual(await bal(dave), rb.d);
  ok('refund batch returns every stake in full; non-participants untouched');

  // ── Guards
  await reverts(send(agent, chronos, CH.abi, 'claimBatch', [BigInt(m3), []]), 'InvalidBatch'); ok('empty batch rejected');
  await reverts(send(agent, chronos, CH.abi, 'claimBatch', [BigInt(m3), Array(101).fill(alice.address)]), 'InvalidBatch'); ok('batch over MAX_BATCH (100) rejected');
  const m4 = await newMarket(); await buy(alice, m4, 1, 10);
  await reverts(send(agent, chronos, CH.abi, 'claimBatch', [BigInt(m4), [alice.address]]), 'InvalidMarketState'); ok('cannot pay out before the market is resolved or refundable');
  await reverts(send(agent, chronos, CH.abi, 'claimWinningsFor', [BigInt(m4), alice.address]), 'InvalidMarketState'); ok('claimWinningsFor blocked before resolution');
  await reverts(send(agent, chronos, CH.abi, 'claimBatch', [99n, [alice.address]]), 'MarketDoesNotExist'); ok('unknown market rejected');

  // ── Paused: payouts are still allowed (users must always be able to exit)
  await send(owner, chronos, CH.abi, 'pause', []);
  const m5 = m1; await send(agent, chronos, CH.abi, 'claimBatch', [BigInt(m5), [alice.address]]).catch(() => {});
  const m6 = m2; await send(agent, chronos, CH.abi, 'claimBatch', [BigInt(m6), [bob.address]]).catch(() => {});
  const m7 = await (async () => { await send(owner, chronos, CH.abi, 'unpause', []); const id = await newMarket(); await buy(alice, id, 1, 20); await buy(bob, id, 2, 20); await mine(1100); await send(oracle, chronos, CH.abi, 'resolveMarket', [BigInt(id), 1, 'x']); await send(owner, chronos, CH.abi, 'pause', []); return id; })();
  const ab = await bal(alice);
  await send(agent, chronos, CH.abi, 'claimBatch', [BigInt(m7), [alice.address]]);
  assert.ok((await bal(alice)) > ab); ok('payouts still work while the contract is paused (exits are never blocked)');
  console.log('\nAll contract tests passed.');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message || e); process.exit(1); });
