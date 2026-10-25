'use strict';
/**
 * src/agent/guards.js
 *
 * Deterministic rules, no I/O. The Gemini agent PROPOSES; these functions DECIDE whether a proposal
 * is allowed to touch the contract. Every function returns a list of problems (empty = OK) so the
 * agent is told everything wrong in one response and can fix it.
 */

const { toDate } = require('./lib');
const { hostnameOf, assessCredibility, quoteAppears } = require('../services/evidence');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MIN = 60 * 1000;

function settings(config) {
  const a = config.agent;
  let minConfidence = Number(a.minConfidence);
  if (minConfidence > 1) minConfidence /= 100;
  return {
    maxPerDay: a.maxMarketsPerDay,
    minProb: a.minProbability, maxProb: a.maxProbability,
    dupSimilarity: a.duplicateSimilarity,
    minTradingLead: a.minTradingLeadHours * HOUR,
    maxTradingLead: a.maxTradingLeadDays * DAY,
    tradingToEvent: 1 * HOUR,
    eventToResolution: 24 * HOUR,
    maxResolutionAfterEvent: 30 * DAY,
    minConfidence,
    minSources: a.minEvidenceSources,
    settleDelay: a.eventSettleDelayMinutes * MIN,
    maxAttempts: a.maxResolutionAttempts,
    maxPerSweep: a.maxResolutionsPerSweep,
  };
}

// ── Duplicate detection ───────────────────────────────────────────────────────

const STOP = new Set(['will', 'the', 'a', 'an', 'of', 'in', 'by', 'on', 'be', 'to', 'and', 'or', 'at', 'for', 'before', 'after', 'is', 'are', 'than', 'that', 'this', 'with', 'as', 'it', 'its']);
const tokens = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)));

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Top-n most similar existing questions with scores. */
function closestQuestions(question, existing, n = 5) {
  const t = tokens(question);
  return existing.map((q) => ({ question: q, score: Number(jaccard(t, tokens(q)).toFixed(2)) })).sort((a, b) => b.score - a.score).slice(0, n);
}

// ── Market proposal rules ─────────────────────────────────────────────────────

const SCHEDULED = /\b(as scheduled|on schedule|as planned|as expected|go ahead as|take place as)\b/i;
const SUBJECTIVE = /\b(significantly|substantially|dramatically|soon|recently|widely|many|several)\b/i;

function textProblems(p, nowMs) {
  const out = [];
  const q = String(p.question || '').trim();
  const c = String(p.resolution_criteria || '').trim();
  if (q.length < 25 || q.length > 300) out.push('question must be 25 to 300 characters');
  if (!/^will\b/i.test(q) || !q.endsWith('?')) out.push('question must be a YES/NO question that starts with "Will" and ends with "?"');
  if (c.length < 60 || c.length > 3000) out.push('resolution_criteria must be 60 to 3000 characters and state exactly when YES and when NO, the source, timezone and cutoff');
  if (SCHEDULED.test(q)) out.push('scheduled-occurrence questions ("as scheduled") are near-certain; pick a question with a genuinely uncertain outcome');
  if (SUBJECTIVE.test(q) || SUBJECTIVE.test(c)) out.push('remove subjective words (significantly, many, soon, ...) and use exact numbers or named conditions');
  const year = new Date(nowMs).getUTCFullYear();
  const years = (q.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
  if (years.length && years.every((y) => y < year)) out.push(`question refers only to past year(s) ${years.join(', ')}; it must be about a future event`);
  try { const u = new URL(p.authority_source_url); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(); } catch { out.push('authority_source_url must be a valid URL of the source that will publish the result'); }
  if (String(p.how_to_verify || '').trim().length < 20) out.push('how_to_verify must explain where and how the result will be found after the event');
  return out;
}

function scheduleProblems(p, nowMs, s) {
  const out = [];
  const trading = toDate(p.trading_deadline), event = toDate(p.event_date), resolution = toDate(p.resolution_deadline);
  if (!trading || !event || !resolution) return { problems: ['trading_deadline, event_date and resolution_deadline must be valid ISO 8601 UTC timestamps'] };
  const t = trading.getTime(), e = event.getTime(), r = resolution.getTime();
  if (e <= nowMs) out.push('event_date is in the past: only future events are allowed');
  if (t < nowMs + s.minTradingLead) out.push(`trading_deadline must be at least ${s.minTradingLead / HOUR}h from now`);
  if (t > nowMs + s.maxTradingLead) out.push(`trading_deadline must be within ${s.maxTradingLead / DAY} days from now`);
  if (e < t + s.tradingToEvent) out.push('trading must close at least 1 hour BEFORE the event happens (event_date must be later than trading_deadline)');
  if (r < e + s.eventToResolution) out.push('resolution_deadline must be at least 24h after event_date so the result is published and can be verified');
  if (r > e + s.maxResolutionAfterEvent) out.push('resolution_deadline must be within 30 days after event_date');
  return { problems: out, tradingTs: Math.floor(t / 1000), eventTs: Math.floor(e / 1000), resolutionTs: Math.floor(r / 1000) };
}

function uncertaintyProblems(p, s) {
  const out = [];
  const prob = Number(p.estimated_probability_yes);
  if (!Number.isFinite(prob) || prob < 0 || prob > 1) return ['estimated_probability_yes must be a number between 0 and 1'];
  if (prob < s.minProb || prob > s.maxProb) out.push(`outcome too predictable: your estimate ${Math.round(prob * 100)}% is outside the allowed ${Math.round(s.minProb * 100)}% to ${Math.round(s.maxProb * 100)}% range. Choose a more uncertain question`);
  if (String(p.why_uncertain || '').trim().length < 40) out.push('why_uncertain must explain, with specifics, why informed people genuinely disagree on this outcome');
  return out;
}

/** Independent vetting result from the verifier model. */
function vettingProblems(v, s) {
  const out = [];
  if (!v || typeof v !== 'object') return ['verifier returned nothing'];
  if (v.outcome_already_known === true) out.push('verifier: the outcome is already known or easily looked up now');
  if (v.event_in_future === false) out.push('verifier: the event is not in the future');
  if (v.ambiguous === true) out.push(`verifier: wording or resolution criteria are ambiguous${v.ambiguity_reason ? ' (' + v.ambiguity_reason + ')' : ''}`);
  if (v.manipulable === true) out.push('verifier: a single person or party can decide the outcome at will');
  const p = Number(v.probability_yes);
  if (!Number.isFinite(p)) out.push('verifier gave no probability');
  else if (p < s.minProb || p > s.maxProb) out.push(`verifier independently estimates ${Math.round(p * 100)}% YES, outside the allowed range: the outcome is too predictable`);
  return out;
}

// ── Resolution rules ──────────────────────────────────────────────────────────

/** When may this market be resolved? `market` has eventDate (Date|ms|null), tradingDeadline, resolutionDeadline. */
function resolutionWindow(market, nowMs, s) {
  const trading = toDate(market.tradingDeadline), resolution = toDate(market.resolutionDeadline);
  const event = toDate(market.eventDate) || toDate(market.eventDateTs);
  const base = event ? event.getTime() : trading ? trading.getTime() : null;
  if (base === null || !resolution) return { eligible: false, reason: 'Market has no usable dates' };
  const dueAt = base + s.settleDelay;
  const pastDeadline = nowMs >= resolution.getTime();
  if (trading && nowMs < trading.getTime()) return { eligible: false, dueAt, pastDeadline, reason: 'Trading is still open' };
  if (nowMs < dueAt) return { eligible: false, dueAt, pastDeadline, reason: 'The event has not finished yet' };
  return { eligible: true, dueAt, pastDeadline, reason: pastDeadline ? 'Resolution deadline has passed' : null };
}

/**
 * Validate the agent's cited evidence against what it actually read.
 * `pages`: Map(url -> { text, contentHash, fetchedAt, publishDate, title })
 */
function evidenceProblems({ outcome, confidence, evidence, pages, authorityUrl, eventMs }, s) {
  const out = [];
  if (outcome !== 'YES' && outcome !== 'NO') return { problems: ['outcome must be "YES" or "NO"'], sources: [] };
  const conf = Number(confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) out.push('confidence must be between 0 and 1');
  else if (conf < s.minConfidence) out.push(`confidence ${conf} is below the required ${s.minConfidence}. If you cannot reach it, call defer_resolution`);
  if (!Array.isArray(evidence) || evidence.length < s.minSources) return { problems: [...out, `provide at least ${s.minSources} evidence items`], sources: [] };

  const sources = [];
  for (const [i, ev] of evidence.entries()) {
    const url = String(ev.url || '');
    const page = pages.get(url);
    if (!page) { out.push(`evidence[${i}]: ${url || '(no url)'} was never read. Use read_page on it first`); continue; }
    if (!['YES', 'NO', 'NEUTRAL'].includes(ev.supports)) { out.push(`evidence[${i}]: supports must be YES, NO or NEUTRAL`); continue; }
    if (!quoteAppears(page.text, ev.quote)) { out.push(`evidence[${i}]: the quote was not found verbatim in the page. Quote exact text (20+ characters) from what you read`); continue; }
    const published = toDate(page.publishDate);
    const stale = published && eventMs && published.getTime() < eventMs - DAY;
    sources.push({
      url, title: page.title, host: hostnameOf(url), supports: ev.supports, excerpt: String(ev.quote).slice(0, 600),
      contentHash: page.contentHash, fetchedAt: page.fetchedAt, publishedAt: published, stale: !!stale,
      credibility: assessCredibility(url, { authorityUrl }),
    });
  }
  const supporting = sources.filter((x) => x.supports === outcome && !x.stale);
  const hosts = new Set(supporting.map((x) => x.host));
  if (hosts.size < s.minSources) out.push(`need ${s.minSources} independent sources (different websites) published after the event that support ${outcome}; found ${hosts.size}`);
  if (!supporting.some((x) => x.credibility === 'high' || x.credibility === 'medium')) out.push('at least one supporting source must be high or medium credibility (official or major outlet)');
  const opposite = outcome === 'YES' ? 'NO' : 'YES';
  if (sources.some((x) => x.supports === opposite && x.credibility === 'high' && !x.stale)) out.push(`a high-credibility source you cited supports ${opposite}: sources conflict, so this cannot be resolved now`);
  return { problems: out, sources };
}

module.exports = { settings, tokens, jaccard, closestQuestions, textProblems, scheduleProblems, uncertaintyProblems, vettingProblems, resolutionWindow, evidenceProblems, HOUR, DAY, MIN };
