'use strict';
process.env.NODE_ENV = 'test'; process.env.GEMINI_MAX_RPM = '600000';
const assert = require('assert');
const { fakeDb, fakeChain, fakeGemini, fc, systems } = require('./harness');
const gemini = require('../src/services/gemini');
const { runDiscovery } = require('../src/agent/discover');
const { resolveMarketById, runResolution } = require('../src/agent/resolve');
const { runKeeper } = require('../src/agent/keeper');
const config = require('../src/config');
config.arc.factoryAddress = '0xfactory';
config.agent.maxProposalsPerRun = 9; // the scripted agent below makes 7 proposals; the budget itself is tested separately

const T = (iso) => new Date(iso).getTime();
const clock = { t: T('2026-10-24T10:00:00Z') };
const database = fakeDb();
const chain = fakeChain(clock);
const scheduled = []; const retries = []; const payouts = [];
const jobs = { schedulePayout: async (id) => payouts.push(id), scheduleResolution: async (id, o) => scheduled.push([id, o]), scheduleRetry: async (id, d) => retries.push([id, d]), hasScheduledJob: async () => false };
const FED = 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261209a.htm';
const REUT = 'https://www.reuters.com/markets/us/fed-decision-dec-2026/';
const PAGES = {
  [FED]: { title: 'FOMC statement', text: 'The Committee decided to lower the target range for the federal funds rate by 25 basis points to 3-1/4 to 3-1/2 percent at its December 2026 meeting.' },
  [REUT]: { title: 'Fed cuts rates', text: 'WASHINGTON - The Federal Reserve cut interest rates by a quarter percentage point on Wednesday, its December 2026 policy meeting concluded.' },
};
const parallel = {
  async search() { return Object.entries(PAGES).map(([url, p]) => ({ url, title: p.title, publishDate: clock.t > T('2026-12-09T19:00:00Z') ? '2026-12-09' : '2026-10-20', excerpts: [p.text] })); },
  async extract({ urls }) { const p = PAGES[urls[0]]; return p ? { pages: [{ url: urls[0], title: p.title, excerpts: [p.text], fullContent: p.text }], errors: [] } : { pages: [], errors: [{ url: urls[0], error: 'nope' }] }; },
};
let verifierAnswer;
const generateJson = async ({ system }) => (/independent, skeptical reviewer/.test(system) ? { probability_yes: 0.55, outcome_already_known: false, event_in_future: true, ambiguous: false, manipulable: false } : verifierAnswer);
const base = { db: () => database, contract: chain, parallel, generateJson, jobs, config, now: () => clock.t };

const good2 = { question: 'Will the European Central Bank change its deposit facility rate at its December 2026 meeting?', resolution_criteria: 'Resolves YES if the ECB press release on ecb.europa.eu dated 2026-12-17 announces any change to the deposit facility rate; NO if it is left unchanged. Cutoff 2026-12-18 12:00 UTC.', category: 'Finance', tags: ['ecb'], authority_source_url: 'https://www.reuters.com/markets/europe/ecb-decision-dec-2026/', source_event_url: 'https://www.reuters.com/markets/europe/ecb-preview-dec-2026/', event_date: '2026-12-17T13:15:00Z', trading_deadline: '2026-12-16T12:00:00Z', resolution_deadline: '2026-12-19T00:00:00Z', estimated_probability_yes: 0.45, probability_basis: 'Money markets price a 45% chance of a move and ECB speakers have been divided.', why_uncertain: 'Governing Council members have publicly disagreed on whether inflation justifies another move.', how_to_verify: 'Read the ECB monetary policy press release on December 17.' };
const good = {
  question: 'Will the US Federal Reserve lower the federal funds target range at its December 2026 FOMC meeting?',
  resolution_criteria: 'Resolves YES if the FOMC statement published on federalreserve.gov on or before 2026-12-10 23:59 UTC announces a reduction of the federal funds target range at the December 8-9, 2026 meeting. Resolves NO if the range is unchanged or raised.',
  category: 'Finance', tags: ['fed', 'rates'], authority_source_url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  source_event_url: 'https://www.reuters.com/markets/us/fed-preview-dec-2026/',
  event_date: '2026-12-09T19:00:00Z', trading_deadline: '2026-12-08T12:00:00Z', resolution_deadline: '2026-12-12T00:00:00Z',
  estimated_probability_yes: 0.55, probability_basis: 'CME FedWatch implied roughly 55% odds of a cut and the latest dot plot is split.', why_uncertain: 'Economists and fed funds futures are split between a cut and a hold, with recent inflation data mixed.',
  how_to_verify: 'Read the FOMC press release on federalreserve.gov after 2pm ET on December 9.',
};

(async () => {
  const ok = (m) => console.log('PASS', m);

  // ── A. Discovery agent ────────────────────────────────────────────────────
  gemini.setClientForTests(fakeGemini([
    [fc('web_search', { objective: 'Find upcoming Fed decisions', queries: ['Fed December 2026 FOMC'] })],
    [fc('create_market', good)],                                                                  // authority source not read yet -> refused
    [fc('read_page', { url: FED, objective: 'Confirm the Fed publishes its decision as text' }), fc('read_page', { url: REUT, objective: 'Confirm coverage' })],
    [fc('create_market', { ...good, event_date: '2026-10-20T19:00:00Z' })],                     // past event
    [fc('create_market', { ...good, authority_source_url: 'https://made-up-site.example/fed' })], // ungrounded source
    [fc('create_market', { ...good, estimated_probability_yes: 0.95 })],                         // too predictable
    [fc('create_market', { ...good, question: 'Will the Fed cut rates as scheduled at its December 2026 meeting?' })], // scheduled wording
    [fc('create_market', good)],                                                                  // valid -> saved as pending
    [fc('create_market', good2)],                                                                 // valid -> saved as pending
    [fc('create_market', { ...good, source_event_url: 'https://other.example/x', question: 'Will the US Federal Reserve lower the federal funds target range at its December 2026 FOMC meeting?' })], // duplicate
    [fc('finish_discovery', { summary: 'one market published' })],
  ]));
  const d = await runDiscovery(base);
  assert.strictEqual(d.status, 'completed', JSON.stringify(d.error));
  assert.strictEqual(d.marketsApproved, 2); assert.strictEqual(d.marketsPublished, 2); assert.strictEqual(d.marketsRejected, 6);
  assert.ok(d.rejectionReasons.some((r) => /read the authority source with read_page first/.test(r.reason))); ok('discovery: a market whose authority source was never read is refused (the answer must be findable when due)');
  assert.strictEqual(chain.calls.createBatch, 1); assert.strictEqual(chain.markets.length, 2); ok('discovery: two approved questions were put on-chain in ONE transaction');
  assert.ok(database.collection('marketProposals').docs.every((x) => x.state === 'created'));
  const pred = database.collection('predictions').docs[0];
  assert.strictEqual(pred.marketId, 0); assert.strictEqual(pred.state, 'Open'); assert.ok(pred.authoritySource && pred.eventDateTs);
  assert.strictEqual(scheduled.length, 2);
  const fedJob = scheduled.find(([id]) => id === 0); assert.strictEqual(fedJob[1].dueAt, T('2026-12-09T19:00:00Z') + 60 * 60000);
  assert.ok(d.rejectionReasons.some((r) => /past/.test(r.reason)) && d.rejectionReasons.some((r) => /too predictable/.test(r.reason)) && d.rejectionReasons.some((r) => /not found in your research/.test(r.reason)));
  ok('discovery: rejects past events, ungrounded sources, predictable and scheduled questions; creates one valid market on-chain');
  assert.strictEqual(database.collection('agentLocks').docs.length, 0); ok('discovery: lock released');

  // ── A2. A chain failure never loses an approved question: it stays pending in the DB and is retried ─────────────────
  {
    const db2 = fakeDb(); const chain2 = fakeChain(clock); chain2.failCreate = () => new Error('insufficient funds for gas');
    const b2 = { ...base, db: () => db2, contract: chain2 };
    gemini.setClientForTests(fakeGemini([[fc('web_search', { objective: 'x', queries: ['fed december 2026'] })], [fc('read_page', { url: FED, objective: 'Confirm the Fed publishes its decision as text' }), fc('read_page', { url: REUT, objective: 'Confirm coverage' })], [fc('create_market', good)], [fc('finish_discovery', { summary: 'ok' })]]));
    const dx = await runDiscovery(b2);
    assert.strictEqual(dx.marketsApproved, 1); assert.strictEqual(dx.marketsPublished, 0);
    const prop = db2.collection('marketProposals').docs[0];
    assert.strictEqual(prop.state, 'pending'); assert.strictEqual(prop.attempts, 1); assert.ok(/insufficient funds for gas/.test(prop.lastError)); assert.ok(prop.nextAttemptAt);
    assert.ok(dx.errors.some((e) => /insufficient funds for gas/.test(e.error))); ok('discovery: when the chain step fails, the approved question is saved as pending (not lost) with the reason');
    assert.strictEqual(db2.collection('predictions').docs.length, 0);
    // chain healthy again, backoff elapsed: the next discovery run publishes it BEFORE researching anything new
    chain2.failCreate = null; clock.t += 6 * 60 * 1000;
    gemini.setClientForTests(fakeGemini([[fc('finish_discovery', { summary: 'nothing new' })]]));
    const dz = await runDiscovery(b2);
    assert.strictEqual(prop.state, 'created'); assert.strictEqual(db2.collection('predictions').docs.length, 1); assert.strictEqual(chain2.calls.createBatch, 2);
    ok('discovery: the pending question is retried from the database and goes live once the chain works');
    const badReviewer = async () => { throw new Error('model not found'); };
    gemini.setClientForTests(fakeGemini([[fc('web_search', { objective: 'x', queries: ['fed december 2026'] })], [fc('read_page', { url: FED, objective: 'Confirm the Fed publishes its decision as text' }), fc('read_page', { url: REUT, objective: 'Confirm coverage' })], [fc('create_market', good)], [fc('finish_discovery', { summary: 'x' })]]));
    const dy = await runDiscovery({ ...base, db: () => fakeDb(), generateJson: badReviewer });
    assert.strictEqual(dy.marketsRejected, 1); assert.ok(/reviewer call failed: model not found/.test(dy.rejectionReasons[0].reason)); ok('discovery: a failing reviewer call is counted and explained');
  }

  // quota: second run today is capped by maxMarketsPerDay (3) minus 1 created
  gemini.setClientForTests(fakeGemini([[fc('finish_discovery', { summary: 'nothing' })]]));
  const d2 = await runDiscovery(base); assert.strictEqual(d2.status, 'completed'); ok('discovery: second run uses remaining quota');

  // ── B. Not due yet ────────────────────────────────────────────────────────
  clock.t = T('2026-12-09T18:00:00Z');
  assert.strictEqual((await resolveMarketById(0, { overrides: base })).status, 'not_due'); ok('resolution: refuses before the event is over');

  // ── C. Resolution agent: guards, then success; never twice ────────────────
  clock.t = T('2026-12-09T21:00:00Z');
  const verdict = { outcome: 'YES', confidence: 0.95, reason: 'Both sources report a cut.' };
  verifierAnswer = verdict;
  const evidence = [{ url: FED, quote: 'lower the target range for the federal funds rate by 25 basis points', supports: 'YES' }, { url: REUT, quote: 'The Federal Reserve cut interest rates by a quarter percentage point on Wednesday', supports: 'YES' }];
  gemini.setClientForTests(fakeGemini([
    [fc('web_search', { objective: 'Fed decision result', queries: ['FOMC December 9 2026 decision'] })],
    [fc('resolve_market', { outcome: 'YES', confidence: 0.95, reasoning: 'x', evidence })],                         // fine to quote search excerpts too: see below
  ]));
  // search results are citable, so first attempt with a fabricated quote must fail
  gemini.setClientForTests(fakeGemini([
    [fc('web_search', { objective: 'Fed decision result', queries: ['FOMC December 9 2026 decision'] })],
    [fc('resolve_market', { outcome: 'YES', confidence: 0.95, reasoning: 'x', evidence: [{ ...evidence[0], quote: 'The Fed slashed rates by fifty basis points in a surprise move' }, evidence[1]] })],
    [fc('resolve_market', { outcome: 'YES', confidence: 0.95, reasoning: 'x', evidence: [{ url: 'https://never-read.example/a', quote: 'The Federal Reserve cut interest rates by a quarter percentage point', supports: 'YES' }, evidence[1]] })],
    [fc('read_page', { url: FED, objective: 'confirm the decision' })],
    [fc('resolve_market', { outcome: 'YES', confidence: 0.7, reasoning: 'x', evidence })],                          // low confidence
    [fc('resolve_market', { outcome: 'YES', confidence: 0.95, reasoning: 'The FOMC statement and Reuters both report a 25bp cut.', evidence })], // valid
  ]));
  const r1 = await resolveMarketById(0, { overrides: base });
  assert.strictEqual(r1.status, 'resolved', JSON.stringify(r1)); assert.strictEqual(r1.outcome, 'YES');
  assert.strictEqual(chain.calls.resolve, 1);
  assert.strictEqual(chain.markets[0].state, 'Resolved');
  assert.strictEqual(database.collection('predictions').docs[0].state, 'Resolved');
  const ev = database.collection('evidence').docs[0]; assert.ok(ev.submittedOnChain && ev.sources.length === 2 && ev.sources[0].contentHash);
  ok('resolution: fabricated quotes, unread sources and low confidence are refused; valid evidence resolves on-chain with a stored audit trail');

  assert.deepStrictEqual(payouts, [0]); ok('resolution: a payout job is queued as soon as a market resolves');
  const r2 = await resolveMarketById(0, { overrides: base });
  assert.strictEqual(r2.status, 'already_final'); assert.strictEqual(chain.calls.resolve, 1); ok('resolution: a resolved market is never resolved twice');

  // ── D. Concurrency: only one run per market ───────────────────────────────
  chain.markets.push({ question: 'Will X happen?', resolutionCriteria: 'c', tradingTs: T('2026-12-01T00:00:00Z') / 1000, resolutionTs: T('2026-12-20T00:00:00Z') / 1000, state: 'TradingClosed', outcome: 'UNRESOLVED' });
  database.collection('predictions').docs.push({ _id: 99, marketId: 2, question: 'Will X happen?', state: 'TradingClosed', tradingDeadline: new Date(T('2026-12-01T00:00:00Z')), resolutionDeadline: new Date(T('2026-12-20T00:00:00Z')), eventDate: new Date(T('2026-12-08T00:00:00Z')), authoritySource: 'https://example.org' });
  gemini.setClientForTests(fakeGemini([[fc('defer_resolution', { reason: 'Official results are published at 6pm', retry_in_minutes: 90 })]]));
  const [a, b] = await Promise.all([resolveMarketById(2, { overrides: base }), resolveMarketById(2, { overrides: base })]);
  assert.deepStrictEqual([a.status, b.status].sort(), ['deferred', 'in_progress']); ok('resolution: concurrent triggers collapse to one run');
  assert.strictEqual(retries.length, 1); assert.strictEqual(retries[0][1], 90 * 60000); ok('resolution: deferral schedules a retry at the time the agent chose');
  assert.ok(database.collection('predictions').docs.find((x) => x.marketId === 2).resolutionNextAttemptAt);

  // ── E. Deadline passed: cancel (refund) without an LLM ────────────────────
  clock.t = T('2026-12-21T00:00:00Z');
  gemini.setClientForTests(fakeGemini([]));
  const r3 = await resolveMarketById(2, { overrides: base });
  assert.strictEqual(r3.status, 'cancelled'); assert.strictEqual(chain.markets[2].state, 'Refundable'); assert.strictEqual(chain.calls.refund, 1); assert.deepStrictEqual(payouts, [0, 2]); ok('resolution: unresolved market past its deadline is cancelled so everyone is refunded');

  // ── F. Sweeper + keeper ───────────────────────────────────────────────────
  chain.markets.push({ question: 'Will Y happen?', resolutionCriteria: 'c', tradingTs: T('2026-12-01T00:00:00Z') / 1000, resolutionTs: T('2026-12-20T00:00:00Z') / 1000, state: 'TradingClosed', outcome: 'UNRESOLVED' });
  database.collection('predictions').docs.push({ _id: 100, marketId: 3, question: 'Will Y happen?', state: 'TradingClosed', tradingDeadline: new Date(T('2026-12-01T00:00:00Z')), resolutionDeadline: new Date(T('2026-12-20T00:00:00Z')), eventDate: new Date(T('2026-12-08T00:00:00Z')) });
  const sweep = await runResolution(base);
  assert.strictEqual(sweep.marketsRefunded, 2); ok('sweeper: refunds every overdue market it finds (the ECB market and the extra one)');

  clock.t = T('2026-12-22T00:00:00Z');
  const k = await runKeeper(base);
  assert.strictEqual(k.status, 'completed', JSON.stringify(k.error || k.errors)); assert.strictEqual(k.errors.length, 0); ok('keeper: syncs markets with no errors');
  console.log('\nAll agent tests passed.');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
