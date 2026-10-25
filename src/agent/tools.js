'use strict';
/**
 * src/agent/tools.js
 *
 * The tools the Gemini agent can call.
 *
 *   Research (Parallel):    web_search, read_page
 *   Discovery agent:        check_duplicate, create_market, finish_discovery
 *   Resolution agent:       get_market_info, resolve_market, cancel_market, defer_resolution
 *
 * Gemini decides WHEN to call these and with what arguments. Every contract-touching handler
 * re-validates the proposal in code (guards.js) and refuses with a list of problems the agent can
 * fix, so the model can never push an unsafe action through.
 */

const guards = require('./guards');
const { sha256, hostnameOf, matchesDomain, buildEvidenceURI } = require('../services/evidence');
const { toDate } = require('./lib');

const CATEGORIES = ['Finance', 'Politics', 'Technology', 'Sports', 'Science', 'Other'];

/** Build dependencies lazily: anything passed in `overrides` is used as-is and never required (keeps tests light). */
function resolveDeps(overrides = {}) {
  const lazy = {
    config: () => require('../config'),
    db: () => require('../db/client').db,
    contract: () => require('../services/contract'),
    parallel: () => require('../services/parallel'),
    generateJson: () => require('../services/gemini').generateJson,
    jobs: () => require('../queues/jobs'),
    now: () => () => Date.now(),
  };
  const deps = { ...overrides };
  for (const key of Object.keys(lazy)) if (!(key in deps)) deps[key] = lazy[key]();
  return deps;
}
const defaultDeps = resolveDeps;

/** Per-run working memory: what the agent has actually seen (so it can only cite or rely on real pages). */
function newSession() {
  return { searches: 0, reads: 0, hosts: new Set(), seen: new Map(), pages: new Map(), created: [], rejected: [], chainFailures: 0 };
}

/** Settled markets are paid out automatically by the payout agent (deduped per market). Never fails the caller. */
async function queuePayout(deps, marketId) {
  if (deps.config.agent.autoPayout === false) return;
  try { await deps.jobs.schedulePayout(marketId); } catch (err) { console.warn(`[tools] could not queue payout for market ${marketId} (the keeper will): ${err.message}`); }
}

const shortText = (arr, max) => (Array.isArray(arr) ? arr.join('\n') : String(arr || '')).slice(0, max);
const hostSeen = (session, url) => { const h = hostnameOf(url); return !!h && [...session.hosts].some((x) => matchesDomain(h, x) || matchesDomain(x, h)); };

// ── Research tools (Parallel) ────────────────────────────────────────────────

function researchTools(deps, session, { afterDate } = {}) {
  const { parallel, config } = deps;
  const A = config.agent;
  return [
    {
      name: 'web_search',
      description: 'Search the live web (Parallel). Give a clear objective and 1-5 short keyword queries (3-6 words each). Returns ranked results with URLs, publish dates and relevant excerpts. Use specific queries; run several different searches rather than one broad one.',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'What you are trying to find out, in a sentence or two.' },
          queries: { type: 'array', items: { type: 'string' }, description: '1-5 keyword queries.' },
          after_date: { type: 'string', description: 'Optional YYYY-MM-DD: only content published on or after this date.' },
          include_domains: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict to these domains (e.g. "federalreserve.gov").' },
        },
        required: ['objective', 'queries'],
      },
      async handler(args) {
        if (session.searches >= A.maxSearchesPerRun) return { ok: false, error: `Search budget used up (${A.maxSearchesPerRun}). Work with what you have and finish.` };
        session.searches++;
        const results = await parallel.search({ objective: args.objective, queries: args.queries, afterDate: args.after_date || afterDate, includeDomains: args.include_domains, maxResults: 8 });
        for (const r of results) {
          const h = hostnameOf(r.url); if (h) session.hosts.add(h);
          session.seen.set(r.url, { title: r.title, publishDate: r.publishDate });
          const text = shortText(r.excerpts, 6000);
          if (text && !session.pages.has(r.url)) session.pages.set(r.url, { text, contentHash: sha256(text), fetchedAt: new Date(), publishDate: r.publishDate, title: r.title, retrieval: 'search' });
        }
        return { ok: true, count: results.length, results: results.map((r) => ({ url: r.url, title: r.title, published: r.publishDate, excerpt: shortText(r.excerpts, 900) })) };
      },
    },
    {
      name: 'read_page',
      description: 'Read one web page in depth (Parallel Extract), focused on an objective. Use it to confirm details on an authoritative page before relying on or citing it. Only text you have read or seen in search results can be cited as evidence.',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' }, objective: { type: 'string', description: 'What to look for on this page.' } },
        required: ['url', 'objective'],
      },
      async handler(args) {
        if (session.reads >= A.maxReadsPerRun) return { ok: false, error: `Page-read budget used up (${A.maxReadsPerRun}).` };
        session.reads++;
        const { pages, errors } = await parallel.extract({ urls: [args.url], objective: args.objective });
        const page = pages[0];
        if (!page) return { ok: false, error: errors[0]?.error || 'Could not read that page' };
        const text = [page.fullContent, ...page.excerpts].filter(Boolean).join('\n');
        const seen = session.seen.get(args.url) || session.seen.get(page.url) || {};
        const h = hostnameOf(args.url); if (h) session.hosts.add(h);
        for (const key of new Set([args.url, page.url])) session.pages.set(key, { text, contentHash: sha256(page.fullContent || text), fetchedAt: new Date(), publishDate: seen.publishDate || null, title: page.title || seen.title || '', retrieval: 'extract' });
        return { ok: true, url: page.url, title: page.title, published: seen.publishDate || null, content: shortText(page.excerpts.length ? page.excerpts : page.fullContent, 5000) };
      },
    },
  ];
}

// ── Discovery tools ──────────────────────────────────────────────────────────

const VETTING_SYSTEM = `You are an independent, skeptical reviewer of prediction-market proposals. You have NO tools and have not seen the proposer's reasoning. Judge only what is written. Be strict: a bad market costs real money.`;

function vettingPrompt(p, nowIso) {
  return `Today is ${nowIso} (UTC).

Proposed market:
Question: ${p.question}
Resolution criteria: ${p.resolution_criteria}
Authority source: ${p.authority_source_url}
Event date: ${p.event_date}
Trading closes: ${p.trading_deadline}
Resolution deadline: ${p.resolution_deadline}

Answer independently, without assuming the proposer is right. Return JSON with exactly:
{
 "probability_yes": number 0..1  (your own honest estimate that the answer is YES),
 "outcome_already_known": boolean (true if the answer can already be determined or is effectively a certainty today),
 "event_in_future": boolean,
 "ambiguous": boolean (true if two reasonable people could disagree about how to resolve it),
 "ambiguity_reason": string,
 "manipulable": boolean (true if one person or party can decide the outcome at will, e.g. whether someone posts something),
 "notes": string
}`;
}

function discoveryTools(deps, session, { runId, quota }) {
  const { config, contract, generateJson, jobs } = deps;
  const s = guards.settings(config);
  const database = () => deps.db();

  async function recentQuestions() {
    const rows = await database().collection('predictions').find({}, { projection: { question: 1 } }).sort({ createdAt: -1 }).limit(400).toArray();
    const open = await database().collection('marketProposals').find({ state: { $in: ['pending', 'unconfirmed'] } }, { projection: { question: 1 } }).toArray();
    return [...rows.map((r) => r.question), ...open.map((r) => r.question), ...session.created.map((c) => c.question)].filter(Boolean);
  }

  return [
    {
      name: 'check_duplicate',
      description: 'Check a draft question against existing markets. Returns the closest matches with similarity scores (0-1). Anything at or above 0.75 will be rejected as a duplicate.',
      readOnly: true,
      parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      async handler({ question }) {
        const closest = guards.closestQuestions(question, await recentQuestions(), 5);
        return { ok: true, duplicate_threshold: s.dupSimilarity, closest };
      },
    },
    {
      name: 'create_market',
      description: 'Publish a market on-chain. Only call this for an event you have verified is in the FUTURE, whose outcome is genuinely uncertain (your honest probability must be between '
        + `${Math.round(s.minProb * 100)}% and ${Math.round(s.maxProb * 100)}%), and whose result will be published by the authority source you name. The proposal is checked by strict code rules and an independent reviewer; if it is rejected you get the exact reasons and can fix and resubmit. All dates are ISO 8601 UTC.`,
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'YES/NO question starting with "Will" and ending with "?", with exact thresholds and a date, e.g. "Will X exceed Y on date Z?"' },
          resolution_criteria: { type: 'string', description: 'Exactly when it resolves YES and when NO, the named source, timezone, and cutoff time.' },
          category: { type: 'string', enum: CATEGORIES },
          tags: { type: 'array', items: { type: 'string' } },
          authority_source_url: { type: 'string', description: 'URL of the official page that will publish the result. You must have found it via web_search or read_page.' },
          source_event_url: { type: 'string', description: 'URL of the article that told you about this event (used to avoid reusing an event).' },
          event_date: { type: 'string', description: 'When the outcome becomes knowable (ISO 8601 UTC). Must be in the future.' },
          trading_deadline: { type: 'string', description: 'When trading closes (ISO UTC). At least 24h from now and at least 1h BEFORE event_date.' },
          resolution_deadline: { type: 'string', description: 'Last moment to resolve (ISO UTC). 24h to 30 days after event_date.' },
          estimated_probability_yes: { type: 'number', description: 'Your honest probability (0-1) that the answer is YES.' },
          why_uncertain: { type: 'string', description: 'Why informed people genuinely disagree on this outcome.' },
          how_to_verify: { type: 'string', description: 'Where and how the answer will be found after the event.' },
        },
        required: ['question', 'resolution_criteria', 'category', 'authority_source_url', 'event_date', 'trading_deadline', 'resolution_deadline', 'estimated_probability_yes', 'why_uncertain', 'how_to_verify'],
      },
      async handler(p) {
        const nowMs = deps.now();
        const reject = (problems) => { session.rejected.push({ question: String(p.question || '').slice(0, 200), reasons: problems }); return { ok: false, problems, hint: 'Fix these and call create_market again, or choose a different event.' }; };

        if (session.created.length >= quota) return { ok: false, terminal: true, error: 'Daily quota reached. Stop.' };
        if (session.chainFailures >= 2) return { ok: false, terminal: true, error: 'Repeated on-chain failures. Stop.' };

        const problems = [...guards.textProblems(p, nowMs), ...guards.uncertaintyProblems(p, s)];
        const sched = guards.scheduleProblems(p, nowMs, s);
        problems.push(...sched.problems);
        if (p.authority_source_url && !hostSeen(session, p.authority_source_url)) problems.push('authority_source_url was not found in your research. Find or read that source with web_search/read_page first (do not guess URLs)');
        if (!CATEGORIES.includes(p.category)) problems.push(`category must be one of ${CATEGORIES.join(', ')}`);

        const existing = await recentQuestions();
        const near = guards.closestQuestions(p.question || '', existing, 1)[0];
        if (near && near.score >= s.dupSimilarity) problems.push(`near-duplicate of existing market "${near.question}" (similarity ${near.score})`);
        if (p.source_event_url) {
          const q = { 'source.eventUrl': p.source_event_url };
          const used = (await database().collection('predictions').findOne(q, { projection: { _id: 1 } })) || (await database().collection('marketProposals').findOne({ ...q, state: { $ne: 'failed' } }, { projection: { _id: 1 } }));
          if (used) problems.push('this source event was already used for another market');
        }
        if (problems.length) return reject(problems);

        // Independent second opinion (no tools, has not seen the proposer's reasoning).
        let vet;
        try { vet = await generateJson({ system: VETTING_SYSTEM, prompt: vettingPrompt(p, new Date(nowMs).toISOString()), model: config.gemini.verifierModel }); }
        catch (err) { return { ok: false, error: `Reviewer unavailable (${err.message}). Do not retry now; call finish_discovery.`, terminal: true }; }
        const vetProblems = guards.vettingProblems(vet, s);
        if (vetProblems.length) return reject(vetProblems);

        // Record the proposal first (so a crash between here and the chain leaves a trail), then go on-chain.
        // Only markets that really exist on-chain ever enter the public `predictions` collection.
        const fullCriteria = `${p.resolution_criteria.trim()}\n\nAuthority source: ${p.authority_source_url}\nHow the result is verified: ${p.how_to_verify.trim()}`.slice(0, 4000);
        const question = p.question.trim().slice(0, 1024);
        const proposals = database().collection('marketProposals');
        const predictions = database().collection('predictions');
        const now = new Date(nowMs);
        const meta = {
          question, resolutionCriteria: fullCriteria, category: p.category, tags: (p.tags || []).slice(0, 8).map(String),
          authoritySource: p.authority_source_url, verificationPlan: p.how_to_verify.trim(), whyUncertain: p.why_uncertain.trim(),
          tradingDeadline: new Date(sched.tradingTs * 1000), resolutionDeadline: new Date(sched.resolutionTs * 1000), eventDate: new Date(sched.eventTs * 1000),
          tradingDeadlineTs: sched.tradingTs, resolutionDeadlineTs: sched.resolutionTs, eventDateTs: sched.eventTs,
          assessment: { agentProbabilityYes: Number(p.estimated_probability_yes), verifierProbabilityYes: Number(vet.probability_yes) },
          source: { eventUrl: p.source_event_url || null }, discoveryRunId: runId,
        };
        const { insertedId } = await proposals.insertOne({ ...meta, state: 'pending', createdAt: now, updatedAt: now });

        try {
          const { txHash, marketId, blockNumber } = await contract.createMarket(question, fullCriteria, sched.tradingTs, sched.resolutionTs);
          await predictions.updateOne({ marketId }, { $set: { ...meta, marketId, createBlock: blockNumber, state: 'Open', outcome: 'UNRESOLVED', createTxHash: txHash, publishedAt: new Date(), updatedAt: new Date() }, $setOnInsert: { createdAt: now, yesPool: '0', noPool: '0', totalPool: '0' } }, { upsert: true });
          await proposals.updateOne({ _id: insertedId }, { $set: { state: 'created', marketId, createTxHash: txHash, updatedAt: new Date() } });
          session.created.push({ question, marketId, txHash });
          try { await jobs.scheduleResolution(marketId, { dueAt: sched.eventTs * 1000 + s.settleDelay, deadlineAt: sched.resolutionTs * 1000 }); }
          catch (err) { console.warn(`[tools] could not schedule resolution for market ${marketId} (the sweeper will still catch it): ${err.message}`); }
          console.log(`[discovery] Created market ${marketId}: "${question.slice(0, 80)}"`);
          return { ok: true, marketId, txHash, created_so_far: session.created.length, remaining_quota: Math.max(0, quota - session.created.length), terminal: session.created.length >= quota };
        } catch (err) {
          if (err.unconfirmed) { // broadcast but unconfirmed: never resubmit. The keeper adopts it when it lands.
            await proposals.updateOne({ _id: insertedId }, { $set: { state: 'unconfirmed', createTxHash: err.txHash, updatedAt: new Date() } });
            session.created.push({ question, marketId: null, txHash: err.txHash });
            return { ok: true, pending: true, txHash: err.txHash, terminal: session.created.length >= quota };
          }
          session.chainFailures++;
          await proposals.updateOne({ _id: insertedId }, { $set: { state: 'failed', error: String(err.message).slice(0, 300), updatedAt: new Date() } });
          return { ok: false, error: `On-chain creation failed: ${err.message}`.slice(0, 400) };
        }
      },
    },
    {
      name: 'finish_discovery',
      description: 'Call when you are done (quota filled, or you cannot find enough qualifying events). Give a one-line summary.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      async handler({ summary }) { return { ok: true, terminal: true, summary: String(summary || '').slice(0, 500) }; },
    },
  ];
}

// ── Resolution tools ─────────────────────────────────────────────────────────

const RESOLVER_SYSTEM = `You verify prediction-market outcomes independently. You see only the resolution criteria and quoted excerpts from web pages. Decide the outcome strictly from the quotes and criteria. If they do not clearly settle it, say UNDETERMINED. Never assume.`;

/**
 * ctx: { marketId, chain (fresh on-chain market), doc (db doc), runId, state: {outcome: null} }
 * ctx.result is filled in by the terminal tools so the orchestrator knows what happened.
 */
function resolutionTools(deps, session, ctx) {
  const { config, contract, generateJson, jobs } = deps;
  const s = guards.settings(config);
  const database = () => deps.db();
  const eventMs = (toDate(ctx.doc.eventDate) || toDate(ctx.chain.tradingDeadline) || new Date(deps.now())).getTime();
  const afterDate = new Date(eventMs - 24 * 3600 * 1000).toISOString().slice(0, 10);

  const tools = researchTools(deps, session, { afterDate });

  tools.push(
    {
      name: 'get_market_info',
      description: 'Fresh on-chain state and deadlines for the market you are resolving.',
      readOnly: true,
      parameters: { type: 'object', properties: {} },
      async handler() {
        const m = await contract.getMarket(ctx.marketId);
        const w = guards.resolutionWindow({ ...ctx.doc, tradingDeadline: m.tradingDeadline, resolutionDeadline: m.resolutionDeadline }, deps.now(), s);
        return { ok: true, state: m.state, question: m.question, resolution_criteria: m.resolutionCriteria, trading_deadline: m.tradingDeadline, resolution_deadline: m.resolutionDeadline, event_date: ctx.doc.eventDate || null, authority_source: ctx.doc.authoritySource || null, can_resolve_now: w.eligible, past_resolution_deadline: w.pastDeadline };
      },
    },
    {
      name: 'resolve_market',
      description: 'Submit the final outcome on-chain. Allowed only with solid evidence: at least '
        + `${s.minSources} independent websites published after the event, each with a VERBATIM quote (20+ characters) from a page you read, at least one official or major source, no credible conflict, and confidence >= ${s.minConfidence}. It is irreversible and can only happen once. If rejected you get the reasons; gather more evidence or call defer_resolution.`,
      parameters: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['YES', 'NO'] },
          confidence: { type: 'number', description: '0-1' },
          reasoning: { type: 'string', description: '2-4 sentences citing the evidence.' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: { url: { type: 'string' }, quote: { type: 'string', description: 'Exact text copied from the page (20+ characters).' }, supports: { type: 'string', enum: ['YES', 'NO', 'NEUTRAL'] } },
              required: ['url', 'quote', 'supports'],
            },
          },
        },
        required: ['outcome', 'confidence', 'reasoning', 'evidence'],
      },
      async handler(args) {
        // 1. Evidence rules (verbatim quotes from pages actually read, independence, credibility, freshness, conflicts).
        const check = guards.evidenceProblems({ outcome: args.outcome, confidence: args.confidence, evidence: args.evidence, pages: session.pages, authorityUrl: ctx.doc.authoritySource, eventMs }, s);
        if (check.problems.length) return { ok: false, problems: check.problems };

        // 2. Chain is the source of truth, right now, right before the irreversible write.
        const chain = await contract.getMarket(ctx.marketId);
        if (chain.state === 'Resolved' || chain.state === 'Refundable' || chain.state === 'Settled') { ctx.result = { type: 'already_final', state: chain.state }; return { ok: true, terminal: true, note: `Market is already ${chain.state}; nothing to do.` }; }
        const window = guards.resolutionWindow({ ...ctx.doc, tradingDeadline: chain.tradingDeadline, resolutionDeadline: chain.resolutionDeadline }, deps.now(), s);
        if (!window.eligible) return { ok: false, problems: [window.reason || 'not resolvable yet'] };
        if (window.pastDeadline) return { ok: false, problems: ['the resolution deadline has passed; the market can only be cancelled (refunded) now'], hint: 'Call cancel_market.' };

        // 3. Independent verification from the quotes alone.
        const quotes = check.sources.map((x, i) => `[${i + 1}] ${x.host} (${x.credibility}, published ${x.publishedAt ? x.publishedAt.toISOString().slice(0, 10) : 'unknown'}): "${x.excerpt}"`).join('\n');
        let ver;
        try {
          ver = await generateJson({
            system: RESOLVER_SYSTEM, model: config.gemini.verifierModel,
            prompt: `Market question: ${chain.question}\nResolution criteria: ${chain.resolutionCriteria}\n\nEvidence excerpts:\n${quotes}\n\nReturn JSON: {"outcome":"YES"|"NO"|"UNDETERMINED","confidence":0..1,"reason":"one sentence"}`,
          });
        } catch (err) { return { ok: false, problems: [`independent verification unavailable (${err.message}); call defer_resolution`] }; }
        if (ver.outcome !== args.outcome || !(Number(ver.confidence) >= s.minConfidence)) {
          return { ok: false, problems: [`independent verification did not agree (it said ${ver.outcome} at ${ver.confidence}: ${String(ver.reason).slice(0, 160)}). Find stronger evidence or call defer_resolution`] };
        }

        // 4. Persist the evidence BEFORE the chain write, so the audit trail exists no matter what happens next.
        const confidence = Math.min(Number(args.confidence), Number(ver.confidence));
        const evidenceDoc = {
          marketId: ctx.marketId, proposedOutcome: args.outcome, confidence, geminiReasoning: String(args.reasoning || '').slice(0, 1500),
          verifier: { outcome: ver.outcome, confidence: Number(ver.confidence), reason: String(ver.reason || '').slice(0, 300) },
          sources: check.sources.map(({ host, stale, ...rest }) => rest), runId: ctx.runId, createdAt: new Date(), submittedOnChain: false,
        };
        await database().collection('evidence').replaceOne({ marketId: ctx.marketId }, evidenceDoc, { upsert: true });

        const evidenceURI = buildEvidenceURI(ctx.marketId, { outcome: args.outcome, confidence, reasoning: args.reasoning, sources: evidenceDoc.sources });
        let txHash;
        try { ({ txHash } = await contract.resolveMarket(ctx.marketId, args.outcome === 'YES' ? 1 : 2, evidenceURI)); }
        catch (err) {
          if (err.unconfirmed) { ctx.result = { type: 'unconfirmed', txHash: err.txHash }; return { ok: true, terminal: true, note: 'Submitted; awaiting confirmation. Do not resubmit.' }; }
          if (err.errorName === 'InvalidMarketState') { ctx.result = { type: 'already_final' }; return { ok: true, terminal: true, note: 'Market was resolved concurrently.' }; }
          return { ok: false, problems: [`on-chain resolution failed: ${err.message}`.slice(0, 300)] };
        }
        const t = new Date();
        await database().collection('predictions').updateOne({ marketId: ctx.marketId }, { $set: { state: 'Resolved', outcome: args.outcome, resolvedAt: t, evidenceURI, resolveTxHash: txHash, updatedAt: t } });
        await database().collection('evidence').updateOne({ marketId: ctx.marketId }, { $set: { submittedOnChain: true, txHash, updatedAt: t } });
        ctx.result = { type: 'resolved', outcome: args.outcome, txHash, confidence };
        console.log(`[resolution] Market ${ctx.marketId} resolved ${args.outcome} (tx ${txHash})`);
        await queuePayout(deps, ctx.marketId);
        return { ok: true, terminal: true, txHash };
      },
    },
    {
      name: 'cancel_market',
      description: 'Cancel an unresolved market so every participant is refunded in full. The contract only allows this AFTER the resolution deadline. Use it when the deadline has passed and the outcome still cannot be established with confidence (or the event never happened). Before the deadline use defer_resolution instead.',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
      async handler({ reason }) {
        const chain = await contract.getMarket(ctx.marketId);
        if (chain.state === 'Resolved' || chain.state === 'Refundable' || chain.state === 'Settled') { ctx.result = { type: 'already_final', state: chain.state }; return { ok: true, terminal: true, note: `Already ${chain.state}.` }; }
        if (deps.now() <= chain.resolutionDeadline.getTime()) return { ok: false, error: `Cannot cancel before the resolution deadline (${chain.resolutionDeadline.toISOString()}). Use defer_resolution to try again later.` };
        try {
          const { txHash } = await contract.markRefundable(ctx.marketId);
          await database().collection('predictions').updateOne({ marketId: ctx.marketId }, { $set: { state: 'Refundable', markRefundableTxHash: txHash, cancelReason: String(reason).slice(0, 300), updatedAt: new Date() } });
          ctx.result = { type: 'cancelled', txHash, reason };
          console.log(`[resolution] Market ${ctx.marketId} cancelled / refundable (tx ${txHash})`);
          await queuePayout(deps, ctx.marketId);
          return { ok: true, terminal: true, txHash };
        } catch (err) {
          if (err.unconfirmed) { ctx.result = { type: 'unconfirmed', txHash: err.txHash }; return { ok: true, terminal: true }; }
          return { ok: false, error: `Cancel failed: ${err.message}`.slice(0, 300) };
        }
      },
    },
    {
      name: 'defer_resolution',
      description: 'Not enough evidence yet (for example official results are not published). Stop for now and have the worker try again later. Say when the result is likely to be available.',
      parameters: { type: 'object', properties: { reason: { type: 'string' }, retry_in_minutes: { type: 'number', description: '15 to 720' } }, required: ['reason'] },
      async handler({ reason, retry_in_minutes }) {
        const minutes = Math.min(720, Math.max(15, Number(retry_in_minutes) || 60));
        ctx.result = { type: 'deferred', reason: String(reason || '').slice(0, 400), minutes };
        return { ok: true, terminal: true };
      },
    },
  );
  return tools;
}

module.exports = { resolveDeps, defaultDeps, newSession, researchTools, discoveryTools, resolutionTools, CATEGORIES };
