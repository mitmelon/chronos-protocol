'use strict';
/**
 * src/services/parallel.js
 *
 * Thin client for Parallel's v1 Search and Extract APIs. It makes NO decisions: no query lists,
 * no event selection, no filtering by topic. The Gemini agent decides what to search and read;
 * these functions are the tools it calls (see src/agent/tools.js).
 *
 * Docs: POST /v1/search (x-api-key), POST /v1/extract (x-api-key).
 */

const config = require('../config');
const { withTimeout, retry } = require('../agent/lib');

class ParallelError extends Error {
  constructor(message, status) { super(message); this.name = 'ParallelError'; this.status = status; }
}

const transient = (err) => !err.status || [408, 425, 429, 500, 502, 503, 504].includes(err.status);

async function post(path, body, { timeoutMs = 45000 } = {}) {
  if (!config.parallel.apiKey) throw new ParallelError('PARALLEL_API_KEY not configured');
  return retry(async () => {
    const res = await withTimeout(
      fetch(`${config.parallel.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': config.parallel.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs + 2000, `Parallel ${path}`
    );
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 400);
      throw new ParallelError(`Parallel ${path} failed (${res.status}): ${text}`, res.status);
    }
    return res.json();
  }, { tries: 3, baseMs: 1500, label: `parallel${path}`, shouldRetry: transient });
}

/**
 * Web search. `afterDate` (YYYY-MM-DD) limits to content published on or after that date.
 * Returns [{ url, title, publishDate, excerpts: [string] }] ordered by relevance.
 */
async function search({ objective, queries, afterDate, includeDomains, maxResults = 8, mode = 'advanced', maxCharsPerResult = 1800 }) {
  const search_queries = (queries || []).map((q) => String(q).trim()).filter(Boolean).slice(0, 5);
  if (!search_queries.length) throw new ParallelError('At least one search query is required');

  const advanced_settings = { max_results: Math.min(Math.max(maxResults, 1), 10), excerpt_settings: { max_chars_per_result: maxCharsPerResult } };
  const source_policy = {};
  if (afterDate && /^\d{4}-\d{2}-\d{2}$/.test(afterDate)) source_policy.after_date = afterDate;
  if (Array.isArray(includeDomains) && includeDomains.length) source_policy.include_domains = includeDomains.slice(0, 20);
  if (Object.keys(source_policy).length) advanced_settings.source_policy = source_policy;

  const data = await post('/v1/search', { objective: objective || undefined, search_queries, mode, client_model: config.gemini.model, advanced_settings });
  return (data.results || []).map((r) => ({
    url: r.url,
    title: r.title || '',
    publishDate: r.publish_date || null,
    excerpts: Array.isArray(r.excerpts) ? r.excerpts : [],
  }));
}

/**
 * Read specific pages. Returns { pages: [{ url, title, excerpts, fullContent }], errors: [{ url, error }] }.
 * `fullContent` is what the evidence hash is computed from.
 */
async function extract({ urls, objective, maxChars = 20000 }) {
  const list = (urls || []).filter((u) => /^https?:\/\//i.test(u)).slice(0, 5);
  if (!list.length) throw new ParallelError('At least one http(s) URL is required');
  const data = await post('/v1/extract', {
    urls: list,
    objective: objective || undefined,
    client_model: config.gemini.model,
    advanced_settings: { full_content: true },
  }, { timeoutMs: 60000 });
  return {
    pages: (data.results || []).map((r) => ({ url: r.url, title: r.title || '', excerpts: r.excerpts || [], fullContent: String(r.full_content || '').slice(0, maxChars) })),
    errors: (data.errors || []).map((e) => ({ url: e.url, error: e.content || e.error_type || 'fetch error' })),
  };
}

module.exports = { search, extract, ParallelError };
