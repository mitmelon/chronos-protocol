'use strict';

const config = require('../config');

const PARALLEL_API_BASE = 'https://api.parallel.ai/v1';

async function searchEvents(query, options = {}) {
  if (!config.parallel.apiKey) {
    console.warn('[parallel] PARALLEL_API_KEY not configured — returning empty results');
    return [];
  }
  const { numResults = 10, category = 'news' } = options;
  const res = await fetch(`${PARALLEL_API_BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.parallel.apiKey}` },
    body: JSON.stringify({ query, num_results: numResults, category }),
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Parallel Search API error ${res.status}: ${text}`); }
  const data = await res.json();
  return (data.results || []).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.snippet || r.description || '',
    publishedAt: r.published_at || r.date || null,
    source: r.source || new URL(r.url || 'http://example.com').hostname,
    score: r.score || 0,
  }));
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
      const results = await searchEvents(query, { numResults: 5 });
      allResults.push(...results.map(r => ({ ...r, searchQuery: query })));
    } catch (err) {
      console.warn(`[parallel] Search failed for "${query}": ${err.message}`);
    }
  }
  const seen = new Set();
  return allResults.filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; });
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
      const results = await searchEvents(query, { numResults: 5, category: 'news' });
      allResults.push(...results);
    } catch (err) {
      console.warn(`[parallel] Evidence search failed: ${err.message}`);
    }
  }
  const seen = new Set();
  return allResults.filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; }).slice(0, 7);
}

module.exports = { searchEvents, discoverFutureEvents, fetchEvidence };
