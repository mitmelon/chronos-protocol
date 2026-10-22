'use strict';

const config = require('../config');

const PARALLEL_API_BASE = 'https://api.parallel.ai/v1';

/**
 * Retry a fetch-based async call with exponential backoff + jitter.
 * Retries on: 429 (rate limit), 503/502/504 (server errors), 408 (timeout).
 */
async function withRetry(fn, { maxAttempts = 5, baseDelayMs = 2000, maxDelayMs = 60000, label = 'call' } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = err._retryable === true;
      if (!isRetryable || attempt === maxAttempts) throw err;
      const raw   = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = raw * 0.2 * (Math.random() * 2 - 1);
      const delay  = Math.min(Math.round(raw + jitter), maxDelayMs);
      console.warn(`[parallel] ${label} attempt ${attempt}/${maxAttempts} failed (${err.message}). Retrying in ${Math.round(delay / 1000)}s…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function searchEvents(query) {
  if (!config.parallel.apiKey) {
    console.warn('[parallel] PARALLEL_API_KEY not configured — returning empty results');
    return [];
  }

  return withRetry(async () => {
    const res = await fetch(`${PARALLEL_API_BASE}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.parallel.apiKey}`,
      },
      // Parallel AI v1 API only accepts search_queries array — no num_results or category
      body: JSON.stringify({ search_queries: [query] }),
    });

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Parallel Search API error ${res.status}: ${text}`);
      err._retryable = [429, 500, 502, 503, 504, 408].includes(res.status);
      throw err;
    }

    const data = await res.json();

    // Response may be: { results: [...] } OR { results: { [query]: [...] } }
    let rawResults = [];
    if (Array.isArray(data.results)) {
      rawResults = data.results;
    } else if (data.results && typeof data.results === 'object') {
      rawResults = Object.values(data.results).flat();
    }

    return rawResults.map(r => ({
      title:       r.title       || '',
      url:         r.url         || r.link || '',
      snippet:     r.snippet     || r.description || r.summary || '',
      publishedAt: r.published_at || r.date || r.publishedAt || null,
      source:      r.source      || (() => { try { return new URL(r.url || r.link || 'http://example.com').hostname; } catch { return 'unknown'; } })(),
      score:       r.score       || r.relevance_score || 0,
    }));
  }, { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60000, label: `search "${query.slice(0, 40)}"` });
}

async function discoverFutureEvents() {
  const queries = [
    'upcoming economic data release schedule next 30 days',
    'scheduled political events elections decisions next 60 days',
    'technology product launch announcement expected 2026',
    'sports championship tournament finals upcoming',
    'central bank interest rate decision upcoming meeting',
    'regulatory decision ruling expected upcoming',
  ];

  const allResults = [];
  for (const query of queries) {
    try {
      const results = await searchEvents(query);
      allResults.push(...results.map(r => ({ ...r, searchQuery: query })));
    } catch (err) {
      console.warn(`[parallel] Search failed for "${query}" (exhausted retries): ${err.message}`);
      // Continue with remaining queries — don't abort the whole discovery run
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return allResults.filter(r => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

async function fetchEvidence(question, authoritySource) {
  const queries = [
    question,
    `${question} result outcome confirmed`,
    authoritySource ? `site:${new URL(authoritySource).hostname} ${question}` : question,
  ];

  const allResults = [];
  for (const query of queries) {
    try {
      const results = await searchEvents(query);
      allResults.push(...results);
    } catch (err) {
      console.warn(`[parallel] Evidence search failed (exhausted retries): ${err.message}`);
    }
  }

  const seen = new Set();
  return allResults
    .filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; })
    .slice(0, 7);
}

module.exports = { searchEvents, discoverFutureEvents, fetchEvidence };
