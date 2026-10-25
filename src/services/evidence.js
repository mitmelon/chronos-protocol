'use strict';
/**
 * src/services/evidence.js
 *
 * Helpers for evidence integrity. Pages are read through Parallel Extract (the agent's read_page tool);
 * this module hashes what was read, scores source credibility, checks that quoted text really
 * appears in a page the agent read, and builds the compact on-chain evidence URI.
 */

const crypto = require('crypto');

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

const HIGH = ['reuters.com', 'bloomberg.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'ft.com', 'wsj.com', 'nytimes.com', 'theguardian.com', 'economist.com',
  'federalreserve.gov', 'bls.gov', 'sec.gov', 'ecb.europa.eu', 'bankofengland.co.uk', 'imf.org', 'worldbank.org', 'who.int', 'un.org',
  'coindesk.com', 'theblock.co', 'arxiv.org', 'nature.com', 'science.org', 'espn.com', 'fifa.com', 'uefa.com', 'nba.com', 'nfl.com'];
const MEDIUM = ['techcrunch.com', 'wired.com', 'cnbc.com', 'cnn.com', 'forbes.com', 'businessinsider.com', 'marketwatch.com', 'investing.com', 'theverge.com', 'axios.com', 'politico.com', 'aljazeera.com'];

const hostnameOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const matchesDomain = (host, domain) => host === domain || host.endsWith('.' + domain);

/**
 * 'high' | 'medium' | 'low'. Suffix-matched (so "notreuters.com" does not match "reuters.com").
 * The market's own authority source counts as high: it is the source the resolution criteria name.
 */
function assessCredibility(url, { authorityUrl } = {}) {
  const host = hostnameOf(url);
  if (!host) return 'low';
  const authHost = authorityUrl ? hostnameOf(authorityUrl) : null;
  if (authHost && matchesDomain(host, authHost)) return 'high';
  if (/\.(gov|mil)$/.test(host) || /\.gov\.[a-z]{2}$/.test(host) || host.endsWith('.europa.eu') || host.endsWith('.int')) return 'high';
  if (HIGH.some((d) => matchesDomain(host, d))) return 'high';
  if (MEDIUM.some((d) => matchesDomain(host, d))) return 'medium';
  return 'low';
}

const normalize = (t) => String(t).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();

/** True only if `quote` (>= minLen chars) appears verbatim in `pageText`. Stops fabricated quotes. */
function quoteAppears(pageText, quote, minLen = 20) {
  const q = normalize(quote).replace(/[.…]+$/, '');
  if (q.length < minLen) return false;
  return normalize(pageText).includes(q);
}

/** On-chain evidence summary: a compact data URI (kept small: it is stored in contract state). */
function buildEvidenceURI(marketId, bundle) {
  const summary = {
    marketId,
    outcome: bundle.outcome,
    confidence: bundle.confidence,
    reasoning: String(bundle.reasoning || '').slice(0, 500),
    sources: (bundle.sources || []).slice(0, 6).map((s) => ({ url: String(s.url).slice(0, 200), hash: s.contentHash, supports: s.supports, at: s.fetchedAt instanceof Date ? s.fetchedAt.toISOString() : s.fetchedAt })),
    generatedAt: new Date().toISOString(),
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(summary)).toString('base64')}`;
}

module.exports = { sha256, hostnameOf, matchesDomain, assessCredibility, quoteAppears, buildEvidenceURI };
