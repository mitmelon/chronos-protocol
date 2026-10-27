'use strict';
process.env.NODE_ENV = 'test'; process.env.GEMINI_MAX_RPM = '600000';
const assert = require('assert');
const { fakeDb, fakeChain, fakeGemini, fc, systems } = require('./harness');
const gemini = require('../src/services/gemini');
const config = require('../src/config');
config.arc.factoryAddress = '0xf';
const guards = require('../src/agent/guards');
const { resolveMarketById, backoffMs } = require('../src/agent/resolve');
const ok = (m) => console.log('PASS', m);
const T = (iso) => new Date(iso).getTime();
const clock = { t: T('2026-12-09T21:00:00Z') };
const AUTH = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', FED = 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261209a.htm', BLOG = 'https://someblog.example/fed-cut';
const PAGES = { [FED]: 'The Committee decided to lower the target range for the federal funds rate by 25 basis points to 3-1/4 to 3-1/2 percent.', [BLOG]: 'A random blog says the Fed lowered the target range for the federal funds rate by 25 basis points yesterday.' };
const parallel = { async search() { return Object.entries(PAGES).map(([url, t]) => ({ url, title: url, publishDate: '2026-12-09', excerpts: [t] })); }, async extract({ urls }) { return { pages: [{ url: urls[0], title: 't', excerpts: [PAGES[urls[0]]], fullContent: PAGES[urls[0]] }], errors: [] }; } };
let verdict = { outcome: 'YES', confidence: 0.95, reason: 'ok' };
const generateJson = async () => verdict;
const retries = [], payouts = [];
const jobs = { scheduleRetry: async (id, d) => retries.push([id, d]), schedulePayout: async (id) => payouts.push(id), scheduleResolution: async () => {}, hasScheduledJob: async () => true };

function world() {
  const db = fakeDb(); const chain = fakeChain(clock);
  chain.markets.push({ question: 'Will the Fed cut?', resolutionCriteria: 'YES if cut. Source: federalreserve.gov', tradingTs: T('2026-12-08T12:00:00Z') / 1000, resolutionTs: T('2026-12-16T00:00:00Z') / 1000, state: 'TradingClosed', outcome: 'UNRESOLVED' });
  db.collection('predictions').docs.push({ _id: 1, marketId: 0, state: 'TradingClosed', tradingDeadline: new Date(T('2026-12-08T12:00:00Z')), resolutionDeadline: new Date(T('2026-12-16T00:00:00Z')), eventDate: new Date(T('2026-12-09T19:00:00Z')), authoritySource: AUTH, verificationPlan: 'Read the FOMC statement' });
  return { db, chain, deps: { db: () => db, contract: chain, parallel, generateJson, jobs, config, now: () => clock.t } };
}
const quote = { url: FED, quote: 'decided to lower the target range for the federal funds rate by 25 basis points', supports: 'YES' };

(async () => {
  // 1. The authority source named in the market settles it on its own (this is what keeps refunds rare)
  let { db, chain, deps } = world();
  gemini.setClientForTests(fakeGemini([[fc('web_search', { objective: 'x', queries: ['fomc statement december 2026'], include_domains: ['federalreserve.gov'] })], [fc('resolve_market', { outcome: 'YES', confidence: 0.95, reasoning: 'The FOMC statement says so.', evidence: [quote] })]]));
  let r = await resolveMarketById(0, { overrides: deps });
  if (r.status !== 'resolved') console.log(JSON.stringify(db.collection('agentRuns').docs.map((x) => x.steps), null, 1).slice(0, 2500));
  assert.strictEqual(r.status, 'resolved', JSON.stringify(r)); assert.strictEqual(chain.markets[0].state, 'Resolved'); assert.deepStrictEqual(payouts, [0]); ok('one verbatim quote from the market\'s own authority source resolves it, and the payout job is queued (winners get paid)');
  assert.ok(db.collection('evidence').docs[0].evidenceHash && chain.markets[0].evidenceURI.startsWith('chronos:v1:0:')); ok('the on-chain evidence is a short hash pointer to the full stored evidence');

  // 2. A single NON-authority source is still not enough
  ({ db, chain, deps } = world());
  const s = guards.settings(config); const pages = new Map([[BLOG, { text: PAGES[BLOG], contentHash: 'h', fetchedAt: new Date(), publishDate: '2026-12-09', title: 'b' }], [FED, { text: PAGES[FED], contentHash: 'h2', fetchedAt: new Date(), publishDate: '2026-12-09', title: 'f' }]]);
  const ev1 = { url: BLOG, quote: 'lowered the target range for the federal funds rate by 25 basis points', supports: 'YES' };
  const run = (evidence, minSources, extra = []) => guards.evidenceProblems({ outcome: 'YES', confidence: 0.95, evidence, pages: new Map([...pages, ...extra]), authorityUrl: AUTH, eventMs: T('2026-12-09T19:00:00Z') }, { ...s, minSources });
  assert.deepStrictEqual(run([quote], 2).problems, []);
  assert.ok(run([ev1], 2).problems.some((p) => /independent sources/.test(p)));
  assert.deepStrictEqual(run([ev1, quote], 2).problems, []);
  const junk = 'https://someone.blogspot.com/fed'; assert.ok(run([{ ...ev1, url: junk }], 1, [[junk, { text: PAGES[BLOG], contentHash: 'h', fetchedAt: new Date(), publishDate: '2026-12-09', title: 'j' }]]).problems.some((p) => /credibility/.test(p)));
  ok('the authority source alone settles it; an ordinary outlet needs corroboration; a self-published blog alone never counts');

  // 3. Keeps trying until the deadline: no "giving up" after N attempts
  ({ db, chain, deps } = world()); retries.length = 0;
  for (let i = 0; i < 12; i++) { gemini.setClientForTests(fakeGemini([[fc('defer_resolution', { reason: 'Statement not indexed yet', reason_code: 'not_published_yet', retry_in_minutes: 30 })]])); r = await resolveMarketById(0, { overrides: deps }); assert.strictEqual(r.status, 'deferred', `attempt ${i + 1} gave ${r.status}`); clock.t += 31 * 60000; if (clock.t > T('2026-12-15T00:00:00Z')) break; }
  assert.ok(retries.length >= 10); ok('after 12 failed attempts the agent is still trying (the old "give up after 8" is gone)');
  clock.t = T('2026-12-09T21:00:00Z'); assert.deepStrictEqual([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(9)], [900000, 1800000, 3600000, 7200000]); ok('retry spacing: 15m, 30m, 1h, then every 2h, never faster than that');

  // 4. The final, bigger attempt
  ({ db, chain, deps } = world()); systems.length = 0;
  gemini.setClientForTests(fakeGemini([[fc('web_search', { objective: 'x', queries: ['q'] })], [fc('resolve_market', { outcome: 'YES', confidence: 0.95, reasoning: 'The FOMC statement says so.', evidence: [quote] })]]));
  r = await resolveMarketById(0, { trigger: 'final', overrides: deps }); assert.strictEqual(r.status, 'resolved'); assert.ok(systems.every((x) => /LAST ATTEMPT/.test(x)));
  ({ db, chain, deps } = world()); systems.length = 0; gemini.setClientForTests(fakeGemini([[fc('defer_resolution', { reason: 'x', reason_code: 'other' })]])); await resolveMarketById(0, { trigger: 'scheduled', overrides: deps }); assert.ok(systems.every((x) => !/LAST ATTEMPT/.test(x)));
  ok('the pre-deadline attempt is told it is the last chance and gets a larger budget; normal attempts are not');

  // 5. A void event waits for the final look instead of burning attempts, then is refunded at the deadline with the right reason
  ({ db, chain, deps } = world()); retries.length = 0; gemini.setClientForTests(fakeGemini([[fc('defer_resolution', { reason: 'The meeting was cancelled', reason_code: 'event_cancelled' })]]));
  r = await resolveMarketById(0, { overrides: deps }); const finalAt = chain.markets[0].resolutionTs * 1000 - s.finalLead;
  assert.strictEqual(r.code, 'event_cancelled'); assert.strictEqual(new Date(r.retryAt).getTime(), finalAt); assert.strictEqual(retries.length, 0); ok('a void event is not retried every 2 hours: it waits for the final attempt');
  clock.t = T('2026-12-16T00:05:00Z'); gemini.setClientForTests(fakeGemini([])); payouts.length = 0; r = await resolveMarketById(0, { trigger: 'deadline', overrides: deps });
  assert.strictEqual(r.status, 'cancelled'); assert.strictEqual(db.collection('predictions').docs[0].cancelCategory, 'event_cancelled'); assert.deepStrictEqual(payouts, [0]); ok('refund only at the deadline, recorded as "event_cancelled", with the refund payout queued');
  ({ db, chain, deps } = world()); clock.t = T('2026-12-16T00:05:00Z'); r = await resolveMarketById(0, { trigger: 'deadline', overrides: deps }); assert.strictEqual(db.collection('predictions').docs[0].cancelCategory, 'no_evidence'); ok('a market with no evidence by the deadline is refunded as "no_evidence"');
  console.log('\nAll persistence tests passed.'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
