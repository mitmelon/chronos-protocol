'use strict';
process.env.NODE_ENV = 'test';
const assert = require('assert');
const { fakeDb } = require('./harness');
const { recordTransaction, runIndexer, positionId } = require('../src/services/indexer');
const { computeStats } = require('../src/services/stats');
const ok = (m) => console.log('PASS', m);
const U = (n) => String(Math.round(n * 1e6));
const A = '0xAaaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa', B = '0xBbbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const tx = (n) => '0x' + String(n).padStart(64, '0');

// A tiny chain: it keeps real balances, and exposes the events a purchase would emit.
function world() {
  const m = { yes: 0n, no: 0n, state: 'Open' }; const shares = { [A.toLowerCase()]: [0n, 0n], [B.toLowerCase()]: [0n, 0n] }; const claimed = new Set(); const logs = []; let block = 100;
  const stake = (who, side, usdc) => { const amt = BigInt(U(usdc)); shares[who.toLowerCase()][side - 1] += amt; side === 1 ? (m.yes += amt) : (m.no += amt); const t = tx(logs.length + 1); logs.push({ txHash: t, logIndex: 0, blockNumber: ++block, marketId: 0, type: 'buy', user: who, outcome: side, amount: amt.toString() }); return t; };
  const contract = {
    async getPositionEventsForTx(t) { return logs.filter((l) => l.txHash === t); },
    async getPositionEvents(from, to) { return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to); },
    async getBlockNumber() { return BigInt(block); },
    async getShares(_id, u) { const [y, n] = shares[u.toLowerCase()]; return { yesAmt: y.toString(), noAmt: n.toString() }; },
    async isClaimed(_id, u) { return claimed.has(u.toLowerCase()); },
    async getMarket() { return { marketId: 0, question: 'Will X happen?', resolutionCriteria: 'c', tradingDeadline: new Date(Date.now() + 864e5), resolutionDeadline: new Date(Date.now() + 9e8), yesPool: m.yes.toString(), noPool: m.no.toString(), totalPool: (m.yes + m.no).toString(), state: m.state, outcome: 'UNRESOLVED' }; },
    async getTvl() { return (m.yes + m.no).toString(); },
  };
  return { m, logs, contract, stake, claimed, shares, setBlock: (b) => { block = b; } };
}

(async () => {
  const w = world(); const db = fakeDb();
  db.collection('predictions').docs.push({ _id: 1, marketId: 0, question: 'Will X happen?', category: 'Other', state: 'Open', yesPool: '0', noPool: '0', totalPool: '0', createBlock: 90 });
  const deps = { db: () => db, contract: w.contract, now: () => Date.now() };

  // the exact bug: a stake was placed on-chain, but nothing was stored
  const t1 = w.stake(A, 1, 5);
  let r = await recordTransaction(t1, deps);
  assert.strictEqual(r.positions.length, 1); assert.strictEqual(r.positions[0].positionId, positionId(w.logs[0])); assert.strictEqual(r.positions[0].outcome, 'YES'); assert.strictEqual(r.positions[0].amount, U(5));
  const pos = db.collection('positions').docs[0]; assert.deepStrictEqual([pos.address, pos.yesShares, pos.noShares, pos.totalStaked], [A.toLowerCase(), U(5), '0', U(5)]);
  const mk = db.collection('predictions').docs[0]; assert.deepStrictEqual([mk.yesPool, mk.noPool, mk.totalPool, mk.tradeCount, mk.stakerCount], [U(5), '0', U(5), 1, 1]);
  ok('a stake is stored the moment it is recorded: position, trade (with a position id) and the question\'s pools/volume/staker count');
  await recordTransaction(t1, deps); assert.strictEqual(db.collection('trades').docs.length, 1); ok('recording the same transaction again changes nothing (no double counting)');

  w.stake(B, 2, 3); const t3 = w.stake(A, 1, 3); await recordTransaction(tx(2), deps); await recordTransaction(t3, deps);
  assert.deepStrictEqual([mk.yesPool, mk.noPool, mk.totalPool, mk.tradeCount, mk.stakerCount], [U(8), U(3), U(11), 3, 2]); assert.strictEqual(db.collection('positions').docs.find((p) => p.address === A.toLowerCase()).yesShares, U(8)); ok('more stakes accumulate: per-question volume 11 USDC, 3 trades, 2 stakers; my position totals 8 USDC');

  // the indexer finds stakes made elsewhere (other app / tab closed before recording)
  const w2 = world(); const db2 = fakeDb(); db2.collection('predictions').docs.push({ _id: 1, marketId: 0, question: 'Will X happen?', state: 'Open', createBlock: 95 }); const d2 = { db: () => db2, contract: w2.contract, now: () => Date.now() };
  w2.stake(A, 1, 2); w2.stake(B, 2, 4); let idx = await runIndexer(d2);
  assert.strictEqual(idx.events, 2); assert.strictEqual(db2.collection('trades').docs.length, 2); assert.strictEqual(db2.collection('predictions').docs[0].totalPool, U(6)); assert.strictEqual(db2.collection('indexerState').docs[0].block, 102);
  idx = await runIndexer(d2); assert.strictEqual(idx.events, 0); w2.stake(A, 2, 1); idx = await runIndexer(d2); assert.strictEqual(idx.events, 1); assert.strictEqual(db2.collection('trades').docs.length, 3); ok('background indexer: catches stakes nobody recorded, resumes from a saved block cursor, never re-reads old blocks');

  // payouts show up as "paid to winners"
  w.claimed.add(A.toLowerCase()); w.logs.push({ txHash: tx(9), logIndex: 0, blockNumber: 200, marketId: 0, type: 'winnings', user: A, amount: U(19), stake: U(8), profit: U(11), fee: U(0.5) }); w.m.state = 'Resolved'; await recordTransaction(tx(9), deps);
  const st = await computeStats(deps); db.collection('predictions').docs[0].state = 'Resolved';
  const st2 = await computeStats(deps);
  assert.deepStrictEqual([st2.totalStakedUsdc, st2.paidToWinnersUsdc, st2.resolvedMarkets, st2.stakers, st2.positions, st2.tvlUsdc], [U(11), U(19), 1, 2, 3, U(11)]);
  assert.strictEqual(db.collection('positions').docs.find((p) => p.address === A.toLowerCase()).claimed, true); ok('stats: TVL (on-chain), total staked, resolved markets, stakers, positions and paid-to-winners all reflect the recorded data');

  await assert.rejects(recordTransaction('0x123', deps), (e) => e.statusCode === 400); assert.deepStrictEqual((await recordTransaction(tx(77), deps)).positions, []); ok('invalid hashes are rejected; a transaction with no Chronos position records nothing');
  console.log('\nAll indexer tests passed.'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
