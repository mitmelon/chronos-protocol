'use strict';
process.env.NODE_ENV = 'test'; process.env.GEMINI_MAX_RPM = '600000';
const assert = require('assert');
const { fakeDb, fakeChain } = require('./harness');
const config = require('../src/config');
config.arc.factoryAddress = '0xfactory';
const { publishPending, backoffMs } = require('../src/agent/publish');
const { runKeeper } = require('../src/agent/keeper');

const T = (iso) => new Date(iso).getTime();
const ok = (m) => console.log('PASS', m);
const clock = { t: T('2026-10-24T10:00:00Z') };
const sched = []; const jobs = { scheduleResolution: async (id) => sched.push(id), scheduleRetry: async () => {}, schedulePayout: async () => {}, hasScheduledJob: async () => true };
const mk = (i, over = {}) => ({ question: `Will event number ${i} happen before the end of the year?`, resolutionCriteria: `Resolves YES if event ${i} happens. Source: https://example.org/${i}`, category: 'Other', tags: [], authoritySource: `https://example.org/${i}`, tradingDeadline: new Date(clock.t + 3 * 864e5), resolutionDeadline: new Date(clock.t + 8 * 864e5), eventDate: new Date(clock.t + 5 * 864e5), tradingDeadlineTs: Math.floor((clock.t + 3 * 864e5) / 1000), resolutionDeadlineTs: Math.floor((clock.t + 8 * 864e5) / 1000), eventDateTs: Math.floor((clock.t + 5 * 864e5) / 1000), source: { eventUrl: `https://news.example/${i}` }, state: 'pending', attempts: 0, createdAt: new Date(clock.t - 1000 + i), updatedAt: new Date(clock.t), ...over });
function setup(n = 3, over = {}) { const db = fakeDb(); const chain = fakeChain(clock); for (let i = 0; i < n; i++) db.collection('marketProposals').docs.push({ _id: i + 1, ...mk(i, over) }); return { db, chain, deps: { db: () => db, contract: chain, config, jobs, now: () => clock.t } }; }
const props = (db) => db.collection('marketProposals').docs;

(async () => {
  // 1. batch
  let { db, chain, deps } = setup(3);
  let r = await publishPending(deps);
  assert.strictEqual(r.published, 3); assert.strictEqual(chain.calls.createBatch, 1); assert.deepStrictEqual(chain.markets.map((m) => m.state), ['Open', 'Open', 'Open']);
  assert.ok(props(db).every((p, i) => p.state === 'created' && p.marketId === i)); assert.strictEqual(db.collection('predictions').docs.length, 3); assert.deepStrictEqual(sched, [0, 1, 2]);
  ok('three pending questions go on-chain in ONE transaction and become live markets, each with its resolution job');
  r = await publishPending(deps); assert.strictEqual(r.status, 'nothing_to_publish'); assert.strictEqual(chain.calls.createBatch, 1); ok('running again does nothing (idempotent)');

  // 2. failure -> stays pending, backoff, retried from the DB
  ({ db, chain, deps } = setup(2)); chain.failCreate = () => new Error('RPC unreachable');
  r = await publishPending(deps); assert.strictEqual(r.status, 'failed');
  assert.ok(props(db).every((p) => p.state === 'pending' && p.attempts === 1 && /RPC unreachable/.test(p.lastError) && new Date(p.nextAttemptAt).getTime() === clock.t + backoffMs(1)));
  ok('chain failure: both questions stay pending with the error and a retry time (nothing lost)');
  chain.failCreate = null; r = await publishPending(deps); assert.strictEqual(r.status, 'nothing_to_publish'); assert.strictEqual(chain.calls.createBatch, 1); ok('no retry before the backoff time (does not hammer a failing RPC)');
  clock.t += backoffMs(1) + 1000; r = await publishPending(deps); assert.strictEqual(r.published, 2); assert.ok(props(db).every((p) => p.state === 'created')); ok('after the backoff the pending questions are published from the database');

  // 3. cost cap keeps them pending too
  ({ db, chain, deps } = setup(1)); chain.failCreate = () => Object.assign(new Error('createMarkets estimated at up to 0.9 USDC, above the cap'), { errorName: 'CostCap' });
  r = await publishPending(deps); assert.strictEqual(props(db)[0].state, 'pending'); ok('a gas-cost-cap refusal keeps the question pending until fees come down');

  // 4. give up after the max attempts; expire stale ones
  ({ db, chain, deps } = setup(1)); props(db)[0].attempts = config.agent.publishMaxAttempts; r = await publishPending(deps);
  assert.strictEqual(props(db)[0].state, 'expired'); assert.ok(/gave up/.test(props(db)[0].expiredReason)); ok('gives up after the maximum attempts');
  ({ db, chain, deps } = setup(2)); props(db)[0].tradingDeadline = new Date(clock.t + 3600 * 1000); props(db)[1].eventDate = new Date(clock.t - 1000);
  r = await publishPending(deps); assert.deepStrictEqual(props(db).map((p) => p.state), ['expired', 'expired']); assert.strictEqual(chain.calls.createBatch || 0, 0); ok('stale questions expire (too little trading time left / event already happened) and are never published');

  // 5. unconfirmed transaction: look it up, never resend blindly
  ({ db, chain, deps } = setup(2)); chain.failCreate = () => Object.assign(new Error('broadcast but not confirmed'), { unconfirmed: true, txHash: '0xlost' });
  r = await publishPending(deps); assert.strictEqual(r.status, 'unconfirmed'); assert.ok(props(db).every((p, i) => p.state === 'unconfirmed' && p.batchTxHash === '0xlost' && p.batchIndex === i)); const sent = chain.calls.createBatch;
  chain.failCreate = null; r = await publishPending(deps); assert.strictEqual(chain.calls.createBatch, sent); assert.ok(props(db).every((p) => p.state === 'unconfirmed')); ok('unconfirmed transaction: still waiting, NOT resent');
  chain.txResults['0xlost'] = { status: 'success', marketIds: [40, 41], blockNumber: 555 }; r = await publishPending(deps);
  assert.strictEqual(r.adopted, 2); assert.deepStrictEqual(props(db).map((p) => p.marketId), [40, 41]); assert.strictEqual(chain.calls.createBatch, sent); assert.strictEqual(db.collection('predictions').docs[0].createBlock, 555); ok('once the transaction is found on-chain the markets are adopted with their real ids (no duplicate created)');
  ({ db, chain, deps } = setup(1)); props(db)[0].state = 'unconfirmed'; props(db)[0].batchTxHash = '0xdead'; props(db)[0].batchIndex = 0; chain.txResults['0xdead'] = { status: 'reverted' };
  r = await publishPending(deps); assert.ok(props(db)[0].state === 'created' || props(db)[0].state === 'pending'); assert.strictEqual(chain.calls.createBatch, 1); ok('a reverted broadcast goes back to pending and is retried');
  ({ db, chain, deps } = setup(1)); props(db)[0].state = 'unconfirmed'; props(db)[0].batchTxHash = '0xnever'; props(db)[0].batchIndex = 0; props(db)[0].updatedAt = new Date(clock.t - 31 * 60000); r = await publishPending(deps);
  assert.strictEqual(props(db)[0].attempts, 1); assert.ok(['pending', 'created'].includes(props(db)[0].state)); ok('a transaction that never confirms is retried after 30 minutes');

  // 6. never create a duplicate: the question is already on-chain
  ({ db, chain, deps } = setup(2)); chain.markets.push({ question: props(db)[0].question, resolutionCriteria: 'x', tradingTs: 1e10, resolutionTs: 2e10, state: 'Open', outcome: 'UNRESOLVED' });
  r = await publishPending(deps); assert.strictEqual(r.adopted, 1); assert.strictEqual(r.published, 1); assert.strictEqual(chain.markets.length, 2); assert.strictEqual(props(db)[0].marketId, 0); ok('a question already on-chain is adopted, not created a second time');

  // 7. limits, flags, locking
  ({ db, chain, deps } = setup(12)); r = await publishPending(deps); assert.strictEqual(r.published, 10); assert.strictEqual(r.pending, 2); r = await publishPending(deps); assert.strictEqual(r.published, 2); ok('never more than 10 markets per transaction (the contract limit); the rest go next');
  ({ db, chain, deps } = setup(1)); assert.strictEqual((await publishPending({ ...deps, config: { ...config, agent: { ...config.agent, autoPublish: false } } })).status, 'disabled'); ok('AGENT_AUTO_PUBLISH=false disables it');
  ({ db, chain, deps } = setup(2)); const slow = { ...chain, createMarkets: async (x) => { await new Promise((s) => setTimeout(s, 30)); return chain.createMarkets(x); } };
  const [a, b] = await Promise.all([publishPending({ ...deps, contract: slow }), publishPending({ ...deps, contract: slow })]); assert.deepStrictEqual([a.status, b.status].sort(), ['in_progress', 'ok']); assert.strictEqual(chain.calls.createBatch, 1); ok('two publishers at once collapse to one (no double creation)');

  // 8. the keeper retries pending questions on its schedule
  ({ db, chain, deps } = setup(2)); const kr = await runKeeper({ ...deps });
  assert.strictEqual(kr.status, 'completed', JSON.stringify(kr.error || kr.errors)); assert.strictEqual(kr.pendingPublished, 2); assert.strictEqual(chain.calls.createBatch, 1); ok('keeper run publishes leftover pending questions');

  // 9. keeper does not burn gas on closeTrading by default, but the database shows the right state
  ({ db, chain, deps } = setup(0)); chain.markets.push({ question: 'Will Q happen?', resolutionCriteria: 'c', tradingTs: Math.floor(clock.t / 1000) - 60, resolutionTs: Math.floor(clock.t / 1000) + 86400, state: 'Open', outcome: 'UNRESOLVED' });
  chain.closeTrading = async () => { throw new Error('closeTrading must not be called'); }; const k2 = await runKeeper({ ...deps }); assert.strictEqual(k2.errors.length, 0);
  const doc = db.collection('predictions').docs[0]; assert.strictEqual(doc.state, 'TradingClosed'); assert.strictEqual(doc.chainState, 'Open'); ok('keeper: no closeTrading transaction by default (resolveMarket closes trading itself); DB shows "TradingClosed"');
  console.log('\nAll publish tests passed.'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
