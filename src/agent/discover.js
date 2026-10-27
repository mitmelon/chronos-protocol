'use strict';
/**
 * src/agent/discover.js
 *
 * Discovery is an AGENT, not a prompt pipeline. Gemini is given a goal and tools. It searches the
 * live web through Parallel, reads pages, checks for duplicates and proposes markets through
 * create_market. Code-level guards (guards.js) and an independent reviewer decide whether each
 * proposal is allowed on-chain, and tell the agent exactly why when it is not.
 */

const { v4: uuidv4 } = require('uuid');
const { runAgent } = require('../services/gemini');
const { publishPending } = require('./publish');
const { resolveDeps, newSession, researchTools, discoveryTools } = require('./tools');
const { acquireLock, releaseLock, failStaleRuns, finishRun, ensureAgentIndexes, pushCapped } = require('./lib');
const guards = require('./guards');

const LOCK_TTL_MS = 25 * 60 * 1000;

const REGIONS = ['North America', 'Latin America and the Caribbean', 'Western Europe', 'Eastern Europe and Central Asia', 'the Middle East', 'North Africa', 'Sub-Saharan Africa', 'South Asia', 'East Asia', 'Southeast Asia', 'Oceania', 'global and multilateral bodies'];
const THEMES = ['central banks and inflation data', 'elections, referendums and parliamentary votes', 'court rulings and regulator decisions', 'sports finals and tournaments', 'technology, space and science milestones', 'crypto and market thresholds', 'energy, commodities and trade', 'public health and climate data', 'awards, rankings and census releases'];
/** A different slice of the world each run, so discovery never settles into one country, outlet or topic. */
function pickSeeds(n = 3, rng = Math.random) {
  const pick = (list) => { const a = [...list]; return Array.from({ length: Math.min(n, a.length) }, () => a.splice(Math.floor(rng() * a.length), 1)[0]); };
  return { regions: pick(REGIONS), themes: pick(THEMES) };
}

function systemPrompt(now, s) {
  return `You are Chronos, an autonomous prediction-market agent. Today is ${now.toISOString()} (UTC).

Your job: find real, FUTURE events and publish YES/NO markets about them. You work by using your tools: web_search and read_page to research the live web, check_duplicate to avoid repeats, create_market to publish. You decide what to search for and what to read. Research like an analyst, not a summarizer.

A market is only acceptable if ALL of these hold:
1. FUTURE: the event has not happened yet and will happen at least ${Math.ceil(s.minTradingLead / guards.HOUR) + 2} hours from now. Trading must close at least 1 hour before the event.
2. GENUINELY UNCERTAIN: informed people disagree. Your honest probability for YES must be between ${Math.round(s.minProb * 100)}% and ${Math.round(s.maxProb * 100)}%. Reject questions whose answer is obvious, scheduled ("will it take place as planned"), already effectively decided by polls/odds/leaks, or that the status quo almost always answers. Prefer close votes, competitive finals, measurable thresholds with real variance, rulings, decisions where forecasts are split.
3. HARD TO GUESS BUT EASY TO VERIFY: the answer can't be looked up today, but after the event an official page (named in authority_source_url) will state the result plainly and promptly. You must have actually READ that source with read_page and confirmed it publishes this kind of result in text you could quote. The oracle must be able to find the answer when the market is due: a refund is a last resort, so prefer events with an official results page. Give the market a resolution_deadline of about 7 days after the event (unless the result is published instantly): it resolves the moment the answer is found, and the deadline only matters as the refund fallback.
4. UNAMBIGUOUS: exact numbers, exact dates, named sources, timezone. No subjective words. One person or party must not be able to decide the outcome at will.
5. NOT A DUPLICATE: use check_duplicate before creating.

Cover the WHOLE WORLD. Do not favour any country, language, outlet or platform, and do not rely on any fixed list of websites: find events from news and official sources in many regions, and use whatever authoritative source is right for each event (a government statistics office, an electoral commission, a court, a league, an agency). Prefer events whose result will be published promptly by an official body. Search for upcoming events in the next 2 to 10 weeks (use after_date to keep results recent), read the best candidates to confirm dates and the authority source, estimate probabilities honestly, then create_market. If create_market rejects a proposal you receive every reason; fix them or move on. Stop with finish_discovery when your quota is filled or you have exhausted good options. Quality beats quantity: publishing nothing is better than publishing a bad market.`;
}

async function runDiscovery(overrides = {}) {
  const deps = resolveDeps(overrides);
  const { config } = deps;
  const database = deps.db();
  const agentRuns = database.collection('agentRuns');
  const s = guards.settings(config);

  const runId = uuidv4();
  const owner = await acquireLock(database, 'discovery', LOCK_TTL_MS);
  if (!owner) { console.log('[discovery] Another discovery run is in progress. Skipping.'); return { runId, type: 'discovery', status: 'skipped', skipReason: 'Another discovery run is in progress' }; }

  const run = { runId, type: 'discovery', startedAt: new Date(), status: 'running', marketsConsidered: 0, marketsPublished: 0, marketsRejected: 0, rejectionReasons: [], errors: [], steps: [] };
  const session = newSession();

  try {
    await ensureAgentIndexes(database);
    await failStaleRuns(agentRuns, 'discovery', LOCK_TTL_MS);
    await agentRuns.insertOne(run);

    // Questions left over from an earlier run (the chain was unreachable, gas too high, ...) go first.
    const leftover = await publishPending(overrides);
    if (leftover.published || leftover.adopted) console.log(`[discovery] published ${leftover.published + leftover.adopted} earlier pending market(s) before researching`);

    const dayStart = new Date(deps.now()); dayStart.setUTCHours(0, 0, 0, 0);
    const publishedToday = await database.collection('marketProposals').countDocuments({ state: { $in: ['pending', 'created', 'unconfirmed'] }, createdAt: { $gte: dayStart } });
    if (publishedToday >= s.maxPerDay) {
      run.status = 'skipped'; run.skipReason = `Already published ${publishedToday} markets today (max: ${s.maxPerDay})`; run.completedAt = new Date();
      return run;
    }
    const quota = s.maxPerDay - publishedToday;

    const recent = await database.collection('predictions').find({}, { projection: { question: 1 } }).sort({ createdAt: -1 }).limit(30).toArray();
    const seeds = pickSeeds();
    const goal = `Publish up to ${quota} new market${quota > 1 ? 's' : ''} today. For variety, start by exploring these regions: ${seeds.regions.join('; ')}, and these themes: ${seeds.themes.join('; ')} (go beyond them if better events exist; never limit yourself to one region). Every event must still be in the future. Existing markets to avoid repeating:\n${recent.map((r) => `- ${r.question}`).join('\n') || '(none yet)'}\n\nBegin by researching.`;

    const tools = [...researchTools(deps, session), ...discoveryTools(deps, session, { runId, quota })];
    const result = await runAgent({
      system: systemPrompt(new Date(deps.now()), s), goal, tools, label: 'discovery',
      onStep: (e) => console.log(`[discovery] step ${e.step}: ${e.tool} ${e.ok ? 'ok' : 'refused: ' + String(e.result).slice(0, 300)} (${e.ms}ms)`),
    });

    // Everything the agent approved is already saved as 'pending'. Put it all on-chain in ONE transaction (retried later if it fails).
    const pub = await publishPending(overrides);
    run.publish = { status: pub.status, txHash: pub.txHash, marketIds: pub.marketIds, pending: pub.pending };
    if (pub.error) pushCapped(run.errors, { step: 'publish', error: pub.error });
    for (const id of pub.marketIds || []) session.created.push({ marketId: id });
    if (pub.status === 'unconfirmed') session.created.push({ marketId: null, txHash: pub.txHash });
    run.marketsPending = pub.pending;

    run.steps = result.trace.slice(0, 60);
    run.agentStop = result.stopReason;
    run.agentSummary = result.terminalResult?.summary || result.text?.slice(0, 400) || '';
    run.status = 'completed'; run.completedAt = new Date();
  } catch (err) {
    console.error('[discovery] Fatal error:', err);
    run.status = 'failed'; run.error = err.message; run.completedAt = new Date();
  } finally {
    run.marketsConsidered = session.seen.size;
    run.marketsPublished = session.created.length;
    run.marketsApproved = session.staged.length;
    run.marketsRejected = session.rejected.length;
    for (const r of session.rejected) pushCapped(run.rejectionReasons, { event: r.question, reason: r.reasons.join('; ').slice(0, 400) });
    await finishRun(agentRuns, run);
    await releaseLock(database, 'discovery', owner);
  }
  return run;
}

module.exports = { runDiscovery, systemPrompt, pickSeeds };
