'use strict';
process.env.NODE_ENV = 'test'; process.env.GEMINI_MAX_RPM = '600000';
const assert = require('assert');
const config = require('../src/config');
const gemini = require('../src/services/gemini')._internal;
const { buildEvidence, sha256, stableStringify } = require('../src/services/evidence');
const guards = require('../src/agent/guards');
const { shortMessage } = require('../src/agent/lib');
const { _internal: chainInternal } = require('../src/services/contract');
const ok = (m) => console.log('PASS', m);

(async () => {
  // The exact error from the user's log: the API asked for 44s; we used to retry after 2.6s and 5.2s and burn attempts.
  const err = new Error(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota... Please retry in 44.270515815s.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '44s' }] } }));
  assert.strictEqual(gemini.retryAfterMs(err), 45000); assert.strictEqual(gemini.retryAfterMs(new Error('Please retry in 12.5s.')), 13500); assert.strictEqual(gemini.retryAfterMs(new Error('boom')), null);
  ok('rate-limit errors: waits the time the API asks for (44s), not a blind 2.6s'); assert.ok(shortMessage(err).length <= 160 && !shortMessage(err).includes('{')); ok('retry log is one short line instead of a screen of JSON');

  // throttle spaces calls to stay under the per-minute quota
  config.gemini.maxRpm = 600; const t0 = Date.now(); await gemini.throttle(); await gemini.throttle(); await gemini.throttle(); assert.ok(Date.now() - t0 >= 190, `took ${Date.now() - t0}ms`); ok('requests are spaced evenly (client-side rate limit) so the agent never trips the quota');

  // history compaction keeps recent turns whole, shrinks old search results, never touches page reads
  const big = { ok: true, count: 6, results: Array.from({ length: 6 }, (_, i) => ({ url: `https://s.example/${i}`, title: `T${i}`, published: '2026-10-20', excerpt: 'x'.repeat(600) })) };
  const turn = (name, output) => ({ role: 'user', parts: [{ functionResponse: { name, response: { output } } }] });
  const model = { role: 'model', parts: [{ functionCall: { name: 'web_search', args: {} } }] };
  const hist = [{ role: 'user', parts: [{ text: 'goal' }] }, model, turn('web_search', big), model, turn('read_page', { content: 'PAGE TEXT TO QUOTE' }), model, turn('web_search', big), model, turn('web_search', big)];
  const c = gemini.compactHistory(hist, 2);
  assert.ok(!JSON.stringify(c[2]).includes('xxxx') && JSON.stringify(c[2]).includes('https://s.example/5')); assert.ok(JSON.stringify(c[4]).includes('PAGE TEXT TO QUOTE')); assert.ok(JSON.stringify(c[6]).includes('xxxx') && JSON.stringify(c[8]).includes('xxxx'));
  assert.ok(JSON.stringify(c).length < JSON.stringify(hist).length * 0.85); ok('old search results shrink to url/title (keeping the links); recent turns and page reads stay whole, so token use stops growing every step');

  // evidence: tiny on-chain pointer that commits to the full, verifiable evidence
  const bundle = { outcome: 'YES', confidence: 0.93, reasoning: 'Both sources report it.', sources: [{ url: 'https://a.example/x', contentHash: 'h1', supports: 'YES', excerpt: 'quote one is long enough', publishedAt: new Date('2026-12-09T20:00:00Z'), fetchedAt: new Date('2026-12-09T21:00:00Z') }, { url: 'https://b.example/y', contentHash: 'h2', supports: 'YES', excerpt: 'quote two is long enough' }] };
  const ev = buildEvidence(7, bundle); assert.ok(Buffer.byteLength(ev.uri) < 100, ev.uri.length); assert.strictEqual(ev.uri, `chronos:v1:7:${ev.hash}`); assert.strictEqual(sha256(ev.canonicalJson), ev.hash);
  assert.strictEqual(buildEvidence(7, JSON.parse(JSON.stringify({ ...bundle, sources: bundle.sources.map((s) => ({ ...s })) }))).hash.length, 64);
  const tampered = buildEvidence(7, { ...bundle, outcome: 'NO' }); assert.notStrictEqual(tampered.hash, ev.hash);
  assert.strictEqual(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}'); ok(`evidence pointer is ${Buffer.byteLength(ev.uri)} bytes on-chain (was ~2000), commits to the full JSON by hash, and any change breaks it`);

  // guards: on-chain text limits (gas) and grounded probabilities
  const s = guards.settings(config); const base = { question: 'Will the ECB change its deposit facility rate at its December 2026 meeting?', resolution_criteria: 'Resolves YES if the ECB press release dated 2026-12-17 announces any change to the deposit facility rate. NO otherwise. Source: ecb.europa.eu', authority_source_url: 'https://www.ecb.europa.eu/', how_to_verify: 'Read the ECB press release on December 17.', estimated_probability_yes: 0.5, probability_basis: 'Money markets price roughly 50% odds of a move.', why_uncertain: 'Council members have publicly disagreed about the next step.' };
  assert.deepStrictEqual(guards.textProblems(base, Date.UTC(2026, 9, 24), s), []);
  assert.ok(guards.textProblems({ ...base, resolution_criteria: 'x'.repeat(s.maxCriteriaChars + 1) }, Date.UTC(2026, 9, 24), s).some((p) => /stored on-chain/.test(p)));
  assert.ok(guards.textProblems({ ...base, question: 'Will ' + 'x'.repeat(s.maxQuestionChars) + '?' }, Date.UTC(2026, 9, 24), s).some((p) => /gas/.test(p))); ok(`question (<=${s.maxQuestionChars}) and criteria (<=${s.maxCriteriaChars}) are capped because on-chain text costs gas per 32 bytes`);
  assert.deepStrictEqual(guards.uncertaintyProblems(base, s), []); assert.ok(guards.uncertaintyProblems({ ...base, probability_basis: '' }, s).some((p) => /probability_basis/.test(p))); ok('a probability estimate must cite the data behind it');

  // per-transaction cost cap protects a small wallet
  const client = (gas, fee) => ({ estimateContractGas: async () => gas, estimateFeesPerGas: async () => ({ maxFeePerGas: fee }) });
  await chainInternal.assertCostWithinCap(client(1_344_490n, 40_000_000_000n), { functionName: 'createMarkets', args: [], address: '0x0', account: '0x0' }); ok('a 1.34M-gas batch at 40 gwei (0.054 USDC) is allowed');
  await assert.rejects(chainInternal.assertCostWithinCap(client(1_344_490n, 500_000_000_000n), { functionName: 'createMarkets', args: [], address: '0x0', account: '0x0' }), (e) => e.errorName === 'CostCap' && /AGENT_MAX_TX_COST_USDC/.test(e.message)); ok('the same batch at 500 gwei (0.67 USDC) is refused before anything is sent, with the setting to change');
  console.log('\nAll misc tests passed.'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
