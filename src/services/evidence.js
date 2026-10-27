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

// Wire services and public broadcasters only BOOST credibility; they are not a whitelist. Any other outlet, in any country or
// language, is 'medium'. Only self-published / anonymous platforms are 'low'.
const WIRE = ['reuters.com', 'apnews.com', 'afp.com', 'bloomberg.com', 'bbc.com', 'bbc.co.uk', 'aljazeera.com', 'dw.com', 'nhk.or.jp', 'xinhuanet.com', 'kyodonews.net', 'thehindu.com', 'ft.com', 'economist.com'];
const LOW = ['blogspot.', 'wordpress.com', 'medium.com', 'substack.com', 'tumblr.com', 'reddit.com', 'quora.com', 'facebook.com', 'x.com', 'twitter.com', 't.me', 'telegram.', 'tiktok.com', 'youtube.com', 'pinterest.', 'wattpad.', 'fandom.com'];
const OFFICIAL = /(^|\.)(gov|mil|int|edu)$|(^|\.)(gov|gob|gouv|go|gv|govt|admin|bund|public)\.[a-z]{2,3}$|(^|\.)europa\.eu$|(^|\.)(un|who|imf|worldbank|wto|oecd|nato)\.(org|int)$/;

/**
 * 'high' | 'medium' | 'low'. The market's own authority source counts as high: it is what the resolution criteria name.
 */
function assessCredibility(url, { authorityUrl } = {}) {
  const host = hostnameOf(url);
  if (!host) return 'low';
  const authHost = authorityUrl ? hostnameOf(authorityUrl) : null;
  if (authHost && matchesDomain(host, authHost)) return 'high';
  if (OFFICIAL.test(host) || WIRE.some((d) => matchesDomain(host, d))) return 'high';
  if (LOW.some((d) => host.includes(d))) return 'low';
  return 'medium';
}

const normalize = (t) => String(t).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();

/** True only if `quote` (>= minLen chars) appears verbatim in `pageText`. Stops fabricated quotes. */
function quoteAppears(pageText, quote, minLen = 20) {
  const q = normalize(quote).replace(/[.…]+$/, '');
  if (q.length < minLen) return false;
  return normalize(pageText).includes(q);
}

/** JSON with keys sorted recursively, so the same evidence always hashes to the same value. */
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object' && !(v instanceof Date)) return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v instanceof Date ? v.toISOString() : v);
}

/**
 * Evidence is stored in full off-chain (database + public API). On-chain we store only a short pointer that commits to it:
 *   chronos:v1:<marketId>:<sha256 of the canonical evidence JSON>      (about 80 bytes, a few thousand gas)
 * Anyone can fetch GET /api/markets/:id/evidence.json, hash the canonicalJson, and compare it with the on-chain value.
 * (Writing a multi-KB evidence blob on-chain would cost roughly 10x more gas for no extra verifiability.)
 */
function buildEvidence(marketId, bundle) {
  const body = {
    marketId, outcome: bundle.outcome, confidence: bundle.confidence,
    reasoning: String(bundle.reasoning || '').slice(0, 1500),
    sources: (bundle.sources || []).map((s) => ({ url: s.url, contentHash: s.contentHash, supports: s.supports, quote: s.excerpt, publishedAt: s.publishedAt || null, fetchedAt: s.fetchedAt || null })),
  };
  const canonicalJson = stableStringify(body);
  const hash = sha256(canonicalJson);
  return { uri: `chronos:v1:${marketId}:${hash}`, canonicalJson, hash };
}

const buildEvidenceURI = (marketId, bundle) => buildEvidence(marketId, bundle).uri;

module.exports = { stableStringify, buildEvidence, sha256, hostnameOf, matchesDomain, assessCredibility, quoteAppears, buildEvidenceURI };
