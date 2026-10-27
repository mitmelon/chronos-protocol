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
const { sha256, hostnameOf, matchesDomain, buildEvidence } = require('../services/evidence');
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
  return { searches: 0, reads: 0, proposals: 0, hosts: new Set(), seen: new Map(), pages: new Map(), staged: [], created: [], rejected: [], chainFailures: 0 };
}

/** Settled markets are paid out automatically by the payout agent (deduped per market). Never fails the caller. */
async function queuePayout(deps, marketId) {
  if (deps.config.agent.autoPayout === false) return;
  try { await deps.jobs.schedulePayout(marketId); } catch (err) { console.warn(`[tools] could not queue payout for market ${marketId} (the keeper will): ${err.message}`); }
}

const shortText = (arr, max) => (Array.isArray(arr) ? arr.join('\n') : String(arr || '')).slice(0, max);
const hostRead = (session, url) => { const h = hostnameOf(url); return !!h && [...session.pages.entries()].some(([u, pg]) => pg.retrieval === 'extract' && (() => { const x = hostnameOf(u); return !!x && (matchesDomain(h, x) || matchesDomain(x, h)); })()); };
const hostSeen = (session, url) => { const h = hostnameOf(url); return !!h && [...session.hosts].some((x) => matchesDomain(h, x) || matchesDomain(x, h)); };

// ── Research tools (Parallel) ────────────────────────────────────────────────

function researchTools(deps, session, { afterDate, budget } = {}) {
  const { parallel, config } = deps;
  const A = config.agent;
  const maxSearches = (budget && budget.searches) || A.maxSearchesPerRun;
  const maxReads = (budget && budget.reads) || A.maxReadsPerRun;
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
        if (session.searches >= maxSearches) return { ok: false, error: `Search budget used up (${maxSearches}). Work with what you have and finish.` };
        session.searches++;
        const results = await parallel.search({ objective: args.objective, queries: args.queries, afterDate: args.after_date || afterDate, includeDomains: args.include_domains, maxResults: 6, maxCharsPerResult: 900 });
        for (const r of results) {
          const h = hostnameOf(r.url); if (h) session.hosts.add(h);
          session.seen.set(r.url, { title: r.title, publishDate: r.publishDate });
          const text = shortText(r.excerpts, 6000);
          if (text && !session.pages.has(r.url)) session.pages.set(r.url, { text, contentHash: sha256(text), fetchedAt: new Date(), publishDate: r.publishDate, title: r.title, retrieval: 'search' });
        }
        return { ok: true, count: results.length, results: results.map((r) => ({ url: r.url, title: r.title, published: r.publishDate, excerpt: shortText(r.excerpts, 600) })) };
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
        if (session.reads >= maxReads) return { ok: false, error: `Page-read budget used up (${maxReads}).` };
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
  const { config, generateJson } = deps;
  const A = config.agent;
  const s = guards.settings(config);
  const database = () => deps.db();

  async function recentQuestions() {
    const rows = await database().collection('predictions').find({}, { projection: { question: 1 } }).sort({ createdAt: -1 }).limit(400).toArray();
    const open = await database().collection('marketProposals').find({ state: { $in: ['pending', 'unconfirmed'] } }, { projection: { question: 1 } }).toArray();
    return [...rows.map((r) => r.question), ...open.map((r) => r.question), ...session.staged.map((c) => c.question), ...session.created.map((c) => c.question)].filter(Boolean);
  }

  const tools = [
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
      description: 'Propose a market for today\'s batch. Approved markets are saved, then published together in ONE on-chain transaction when you finish. Only propose an event you have verified is in the FUTURE, whose outcome is genuinely uncertain (your honest probability must be between '
        + `${Math.round(s.minProb * 100)}% and ${Math.round(s.maxProb * 100)}%, backed by data you found), and whose result will be published by the authority source you name. The proposal is checked by strict code rules and an independent reviewer; if it is rejected you get the exact reasons. You have a limited number of proposals, so research before you propose. All dates are ISO 8601 UTC.`,
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: `YES/NO question starting with "Will" and ending with "?", at most ${s.maxQuestionChars} characters, with exact thresholds and a date.` },
          resolution_criteria: { type: 'string', description: `Stored on-chain, so at most ${s.maxCriteriaChars} characters: exactly when it resolves YES and when NO, the source, timezone, cutoff.` },
          category: { type: 'string', enum: CATEGORIES },
          tags: { type: 'array', items: { type: 'string' } },
          authority_source_url: { type: 'string', description: 'URL of the official page that will publish the result. You must have found it via web_search or read_page.' },
          source_event_url: { type: 'string', description: 'URL of the article that told you about this event (used to avoid reusing an event).' },
          event_date: { type: 'string', description: 'When the outcome becomes knowable (ISO 8601 UTC). Must be in the future.' },
          trading_deadline: { type: 'string', description: 'When trading closes (ISO UTC). At least 24h from now and at least 1h BEFORE event_date.' },
          resolution_deadline: { type: 'string', description: 'Last moment to resolve (ISO UTC): 24h to 30 days after event_date. Prefer about 7 days after the event unless the result is published instantly: the market resolves as soon as the answer is found, and the deadline only matters as the refund fallback.' },
          estimated_probability_yes: { type: 'number', description: 'Your honest probability (0-1) that the answer is YES.' },
          probability_basis: { type: 'string', description: 'The data behind that number (polls, market odds, forecasts, base rates) you found while researching.' },
          why_uncertain: { type: 'string', description: 'Why informed people genuinely disagree on this outcome.' },
          how_to_verify: { type: 'string', description: 'Where and how the answer will be found after the event (stored off-chain).' },
        },
        required: ['question', 'resolution_criteria', 'category', 'authority_source_url', 'event_date', 'trading_deadline', 'resolution_deadline', 'estimated_probability_yes', 'probability_basis', 'why_uncertain', 'how_to_verify'],
      },
      async handler(p) {
        const nowMs = deps.now();
        const reject = (problems, extra = {}) => { session.rejected.push({ question: String(p.question || '').slice(0, 200), reasons: problems }); console.log(`[discovery] create_market rejected: ${problems.join(' | ').slice(0, 600)}`); return { ok: false, problems, hint: 'Fix these and call create_market again, or choose a different event.', ...extra }; };

        if (session.staged.length >= quota) return { ok: false, terminal: true, error: 'The batch is full. Stop.' };
        if (++session.proposals > A.maxProposalsPerRun) return { ok: false, terminal: true, error: `Proposal budget used (${A.maxProposalsPerRun}). Stop.` };

        const problems = [...guards.textProblems(p, nowMs, s), ...guards.uncertaintyProblems(p, s)];
        const sched = guards.scheduleProblems(p, nowMs, s);
        problems.push(...sched.problems);
        let ungrounded = false;
        if (p.authority_source_url && !hostSeen(session, p.authority_source_url)) { ungrounded = true; problems.push('authority_source_url was not found in your research. Pick one of the seen_sources below, or find that source with web_search/read_page first (do not guess URLs)'); }
        if (p.authority_source_url && !ungrounded && !hostRead(session, p.authority_source_url)) problems.push('read the authority source with read_page first, to confirm it publishes this kind of result in a form you can quote. The answer must be findable when the market is due');
        if (!CATEGORIES.includes(p.category)) problems.push(`category must be one of ${CATEGORIES.join(', ')}`);

        const existing = await recentQuestions();
        const near = guards.closestQuestions(p.question || '', existing, 1)[0];
        if (near && near.score >= s.dupSimilarity) problems.push(`near-duplicate of existing market "${near.question}" (similarity ${near.score})`);
        if (p.source_event_url) {
          const q = { 'source.eventUrl': p.source_event_url };
          const used = (await database().collection('predictions').findOne(q, { projection: { _id: 1 } })) || (await database().collection('marketProposals').findOne({ ...q, state: { $in: ['pending', 'created', 'unconfirmed'] } }, { projection: { _id: 1 } })) || session.staged.find((x) => x.meta.source.eventUrl === p.source_event_url);
          if (used) problems.push('this source event was already used for another market');
        }
        if (problems.length) return reject(problems, ungrounded ? { seen_sources: [...session.seen.keys()].slice(0, 12) } : {});

        // Independent second opinion (no tools, has not seen the proposer's reasoning). Only reached when every free code check passed.
        let vet;
        try { vet = await generateJson({ system: VETTING_SYSTEM, prompt: vettingPrompt(p, new Date(nowMs).toISOString()), model: config.gemini.verifierModel }); }
        catch (err) { return reject([`independent reviewer call failed: ${err.message}`.slice(0, 300)]); }
        const vetProblems = guards.vettingProblems(vet, s);
        if (vetProblems.length) return reject(vetProblems);

        // Approved: add to today's batch. Nothing touches the chain until the whole batch is published in one transaction.
        const criteria = `${p.resolution_criteria.trim()}\nSource: ${p.authority_source_url}`.slice(0, 1024);
        const question = p.question.trim();
        const meta = {
          question, resolutionCriteria: criteria, category: p.category, tags: (p.tags || []).slice(0, 8).map(String),
          authoritySource: p.authority_source_url, verificationPlan: p.how_to_verify.trim(), whyUncertain: p.why_uncertain.trim(), probabilityBasis: p.probability_basis.trim(),
          tradingDeadline: new Date(sched.tradingTs * 1000), resolutionDeadline: new Date(sched.resolutionTs * 1000), eventDate: new Date(sched.eventTs * 1000),
          tradingDeadlineTs: sched.tradingTs, resolutionDeadlineTs: sched.resolutionTs, eventDateTs: sched.eventTs,
          assessment: { agentProbabilityYes: Number(p.estimated_probability_yes), verifierProbabilityYes: Number(vet.probability_yes) },
          source: { eventUrl: p.source_event_url || null },
        };
        // Save it now, as 'pending'. From here on the database owns it: the publisher puts pending questions on-chain
        // in one transaction and keeps retrying until they land, so an RPC or gas problem never loses a good question.
        const t0 = new Date(nowMs);
        await database().collection('marketProposals').insertOne({ ...meta, question, resolutionCriteria: criteria, discoveryRunId: runId, state: 'pending', attempts: 0, createdAt: t0, updatedAt: t0 });
        session.staged.push({ question, criteria, tradingTs: sched.tradingTs, resolutionTs: sched.resolutionTs, meta });
        console.log(`[discovery] Approved and saved as pending (${session.staged.length}/${quota}): "${question.slice(0, 80)}"`);
        const full = session.staged.length >= quota;
        return { ok: true, staged: session.staged.length, remaining_quota: quota - session.staged.length, terminal: full, message: full ? 'Batch complete.' : 'Added to the batch. Find the next one, or call finish_discovery.' };
      },
    },
    {
      name: 'finish_discovery',
      description: 'Call when you are done (quota filled, or you cannot find enough qualifying events). Give a one-line summary.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      async handler({ summary }) { return { ok: true, terminal: true, summary: String(summary || '').slice(0, 500) }; },
    },
  ];

  const create = tools.find((t) => t.name === 'create_market');
  const inner = create.handler;
  create.handler = async (p) => {
    try { return await inner(p); }
    catch (err) {
      session.rejected.push({ question: String((p && p.question) || '').slice(0, 200), reasons: [`unexpected error: ${err.message}`.slice(0, 300)] });
      console.error('[discovery] create_market error:', err);
      return { ok: false, error: String(err.message).slice(0, 300) };
    }
  };
  return tools;
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

  const tools = researchTools(deps, session, { afterDate, budget: ctx.budget });

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

        const built = buildEvidence(ctx.marketId, { outcome: args.outcome, confidence, reasoning: args.reasoning, sources: evidenceDoc.sources });
        const evidenceURI = built.uri;
        await database().collection('evidence').updateOne({ marketId: ctx.marketId }, { $set: { canonicalJson: built.canonicalJson, evidenceHash: built.hash, evidenceURI } });
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
      description: 'LAST RESORT: cancel the market so every participant is refunded in full. The contract only allows this AFTER the resolution deadline, and only when the market cannot be settled: the event was cancelled or void, the outcome is neutral under the criteria, or no evidence of the result exists. Before the deadline use defer_resolution instead.',
      parameters: { type: 'object', properties: { reason: { type: 'string' }, category: { type: 'string', enum: ['no_evidence', 'event_cancelled', 'neutral_outcome'] } }, required: ['reason', 'category'] },
      async handler({ reason, category }) {
        const chain = await contract.getMarket(ctx.marketId);
        if (chain.state === 'Resolved' || chain.state === 'Refundable' || chain.state === 'Settled') { ctx.result = { type: 'already_final', state: chain.state }; return { ok: true, terminal: true, note: `Already ${chain.state}.` }; }
        if (deps.now() <= chain.resolutionDeadline.getTime()) return { ok: false, error: `Cannot cancel before the resolution deadline (${chain.resolutionDeadline.toISOString()}). Use defer_resolution to try again later.` };
        try {
          const { txHash } = await contract.markRefundable(ctx.marketId);
          await database().collection('predictions').updateOne({ marketId: ctx.marketId }, { $set: { state: 'Refundable', markRefundableTxHash: txHash, cancelReason: String(reason).slice(0, 300), cancelCategory: category || 'no_evidence', updatedAt: new Date() } });
          ctx.result = { type: 'cancelled', txHash, reason, category: category || 'no_evidence' };
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
      description: 'The answer is not available yet (results not published, sources still conflicting, event postponed). Stop for now; the worker tries again later, and keeps trying until the deadline, so use this instead of giving up. Say when the result is likely to be published. If the event was definitively cancelled or void, use reason_code "event_cancelled": the market will then be refunded at the deadline.',
      parameters: { type: 'object', properties: { reason: { type: 'string' }, reason_code: { type: 'string', enum: ['not_published_yet', 'event_postponed', 'event_cancelled', 'conflicting_sources', 'insufficient_evidence', 'other'] }, retry_in_minutes: { type: 'number', description: '15 to 240' } }, required: ['reason', 'reason_code'] },
      async handler({ reason, reason_code, retry_in_minutes }) {
        const minutes = Math.min(Math.floor(s.retryCap / 60000), Math.max(15, Number(retry_in_minutes) || 60));
        ctx.result = { type: 'deferred', reason: String(reason || '').slice(0, 400), code: reason_code || 'other', minutes };
        return { ok: true, terminal: true };
      },
    },
  );
  return tools;
}


module.exports = { resolveDeps, defaultDeps, newSession, researchTools, discoveryTools, resolutionTools, CATEGORIES };
