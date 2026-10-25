'use strict';
process.env.NODE_ENV = 'test';
const assert = require('assert');
const { fakeDb } = require('./harness');
const config = require('../src/config');
const { payoutMarket } = require('../src/agent/payouts');

const U = (n) => String(Math.round(n * 1e6));
function fakeContract() {
  const state = { market: { state: 'Resolved', outcome: 'YES' }, shares: {}, claimed: new Set(), blocked: new Set(), batches: [] };
  return {
    state,
    async getMarket() { return { marketId: 0, ...state.market }; },
    async getParticipants() { return Object.keys(state.shares); },
    async getShares(_id, u) { return state.shares[u]; },
    async isClaimed(_id, u) { return state.claimed.has(u); },
    async claimBatch(_id, users) { state.batches.push(users); let paid = 0; for (const u of users) { const s = state.shares[u]; const owed = state.market.state === 'Refundable' || (state.market.outcome === 'YES' ? BigInt(s.yesAmt) : BigInt(s.noAmt)) > 0n; if (!state.claimed.has(u) && !state.blocked.has(u) && owed) { state.claimed.add(u); paid++; } } return { txHash: '0xbatch' + state.batches.length, attempted: users.length, paid }; },
  };
}
(async () => {
  const ok = (m) => console.log('PASS', m);
  const database = fakeDb(); const contract = fakeContract(); const retries = [];
  const s = contract.state; s.shares = { A: { yesAmt: U(100), noAmt: '0' }, B: { yesAmt: U(300), noAmt: '0' }, C: { yesAmt: '0', noAmt: U(600) }, D: { yesAmt: U(50), noAmt: '0' }, E: { yesAmt: U(10), noAmt: '0' } };
  s.claimed.add('E'); s.blocked.add('D');
  database.collection('predictions').docs.push({ _id: 1, marketId: 0, state: 'Resolved' });
  const deps = { db: () => database, contract, config, now: () => Date.now(), jobs: { schedulePayout: async (id, d) => retries.push([id, d]) } };

  let r = await payoutMarket(0, deps);
  assert.deepStrictEqual([r.status, r.owed, r.paid, r.failed], ['partial', 3, 2, 1]);
  assert.ok(s.claimed.has('A') && s.claimed.has('B') && !s.claimed.has('C') && !s.claimed.has('D'));
  assert.strictEqual(s.batches[0].length, 3); // losers and already-claimed users are never sent
  assert.strictEqual(retries.length, 1); assert.strictEqual(database.collection('predictions').docs[0].payoutStatus, 'partial');
  ok('pays winners, skips losers and people who already claimed; one stuck address does not block the rest; retry is scheduled');

  s.blocked.delete('D');
  r = await payoutMarket(0, deps); assert.deepStrictEqual([r.status, r.paid], ['complete', 1]);
  const ledger = database.collection('payouts').docs; assert.strictEqual(ledger.filter((l) => l.status === 'paid').length, 3);
  ok('retry pays the remaining participant; ledger shows every payout');

  const batchesBefore = s.batches.length;
  r = await payoutMarket(0, deps); assert.strictEqual(r.status, 'complete'); assert.strictEqual(s.batches.length, batchesBefore);
  ok('running again sends nothing (idempotent)');

  // permanently failing address -> stuck after max attempts, retries stop
  const db2 = fakeDb(); const c2 = fakeContract(); c2.state.shares = { X: { yesAmt: U(5), noAmt: '0' }, Y: { yesAmt: U(5), noAmt: '0' } }; c2.state.blocked.add('Y');
  db2.collection('predictions').docs.push({ _id: 1, marketId: 0, state: 'Resolved' });
  const d2 = { ...deps, db: () => db2, contract: c2 }; let last; for (let i = 0; i < config.agent.payoutMaxAttempts + 1; i++) last = await payoutMarket(0, d2);
  assert.strictEqual(last.status, 'stuck'); assert.strictEqual(db2.collection('payouts').docs.find((l) => l.user === 'y').attempts, config.agent.payoutMaxAttempts);
  ok('an address that can never be paid is marked stuck after the max attempts (it can still claim itself)');

  // refunds pay everyone their full stake
  const db3 = fakeDb(); const c3 = fakeContract(); c3.state.market = { state: 'Refundable', outcome: 'UNRESOLVED' }; c3.state.shares = { P: { yesAmt: U(10), noAmt: '0' }, Q: { yesAmt: '0', noAmt: U(20) } };
  db3.collection('predictions').docs.push({ _id: 1, marketId: 0, state: 'Refundable' });
  r = await payoutMarket(0, { ...deps, db: () => db3, contract: c3 }); assert.deepStrictEqual([r.status, r.paid], ['complete', 2]); ok('cancelled market: every participant is refunded');

  c3.state.market = { state: 'TradingClosed' }; assert.strictEqual((await payoutMarket(0, { ...deps, db: () => db3, contract: c3 })).status, 'not_settled'); ok('does nothing for a market that is not settled');
  const off = { ...config, agent: { ...config.agent, autoPayout: false } }; assert.strictEqual((await payoutMarket(0, { ...deps, config: off })).status, 'disabled'); ok('AGENT_AUTO_PAYOUT=false disables it');

  const db4 = fakeDb(); const c4 = fakeContract(); c4.state.shares = { A: { yesAmt: U(1), noAmt: '0' } }; db4.collection('predictions').docs.push({ _id: 1, marketId: 0 });
  const slow = { ...c4, claimBatch: async (...a) => { await new Promise((r) => setTimeout(r, 20)); return c4.claimBatch(...a); } };
  const [x, y] = await Promise.all([payoutMarket(0, { ...deps, db: () => db4, contract: slow }), payoutMarket(0, { ...deps, db: () => db4, contract: slow })]);
  assert.deepStrictEqual([x.status, y.status].sort(), ['complete', 'in_progress']); ok('concurrent payout runs collapse to one');
  console.log('\nAll payout tests passed.'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
