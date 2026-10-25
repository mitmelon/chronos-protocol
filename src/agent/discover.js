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
const { resolveDeps, newSession, researchTools, discoveryTools } = require('./tools');
const { acquireLock, releaseLock, failStaleRuns, finishRun, ensureAgentIndexes, pushCapped } = require('./lib');
const guards = require('./guards');

const LOCK_TTL_MS = 25 * 60 * 1000;

function systemPrompt(now, s) {
  return `You are Chronos, an autonomous prediction-market agent. Today is ${now.toISOString()} (UTC).

Your job: find real, FUTURE events and publish YES/NO markets about them. You work by using your tools: web_search and read_page to research the live web, check_duplicate to avoid repeats, create_market to publish. You decide what to search for and what to read. Research like an analyst, not a summarizer.

A market is only acceptable if ALL of these hold:
1. FUTURE: the event has not happened yet and will happen at least ${Math.ceil(s.minTradingLead / guards.HOUR) + 2} hours from now. Trading must close at least 1 hour before the event.
2. GENUINELY UNCERTAIN: informed people disagree. Your honest probability for YES must be between ${Math.round(s.minProb * 100)}% and ${Math.round(s.maxProb * 100)}%. Reject questions whose answer is obvious, scheduled ("will it take place as planned"), already effectively decided by polls/odds/leaks, or that the status quo almost always answers. Prefer close votes, competitive finals, measurable thresholds with real variance, rulings, decisions where forecasts are split.
3. HARD TO GUESS BUT EASY TO VERIFY: the answer can't be looked up today, but after the event an authoritative page (named in authority_source_url) will state the result plainly. You must have actually found that source with your tools.
4. UNAMBIGUOUS: exact numbers, exact dates, named sources, timezone. No subjective words. One person or party must not be able to decide the outcome at will.
5. NOT A DUPLICATE: use check_duplicate before creating.

Process: brainstorm several categories (finance and central banks, elections and votes, courts and regulators, sports finals, technology and science milestones, crypto and markets), search for upcoming events in the next 2 to 10 weeks, read the best candidates to confirm dates and the authority source, estimate probabilities honestly, then create_market. If create_market rejects a proposal you receive every reason; fix them or move on. Stop with finish_discovery when your quota is filled or you have exhausted good options. Quality beats quantity: publishing nothing is better than publishing a bad market.`;
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

    const dayStart = new Date(deps.now()); dayStart.setUTCHours(0, 0, 0, 0);
    const publishedToday = await database.collection('marketProposals').countDocuments({ state: { $in: ['pending', 'created', 'unconfirmed'] }, createdAt: { $gte: dayStart } });
    if (publishedToday >= s.maxPerDay) {
      run.status = 'skipped'; run.skipReason = `Already published ${publishedToday} markets today (max: ${s.maxPerDay})`; run.completedAt = new Date();
      return run;
    }
    const quota = s.maxPerDay - publishedToday;

    const recent = await database.collection('predictions').find({}, { projection: { question: 1 } }).sort({ createdAt: -1 }).limit(30).toArray();
    const goal = `Publish up to ${quota} new market${quota > 1 ? 's' : ''} today. Existing markets to avoid repeating:\n${recent.map((r) => `- ${r.question}`).join('\n') || '(none yet)'}\n\nBegin by researching.`;

    const tools = [...researchTools(deps, session), ...discoveryTools(deps, session, { runId, quota })];
    const result = await runAgent({
      system: systemPrompt(new Date(deps.now()), s), goal, tools, label: 'discovery',
      onStep: (e) => console.log(`[discovery] step ${e.step}: ${e.tool} ${e.ok ? 'ok' : 'refused'} (${e.ms}ms)`),
    });

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
    run.marketsRejected = session.rejected.length;
    for (const r of session.rejected) pushCapped(run.rejectionReasons, { event: r.question, reason: r.reasons.join('; ').slice(0, 400) });
    await finishRun(agentRuns, run);
    await releaseLock(database, 'discovery', owner);
  }
  return run;
}

module.exports = { runDiscovery, systemPrompt };
