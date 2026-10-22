'use strict';

const crypto = require('crypto');

async function processSearchResults(rawResults) {
  const sources = [];
  for (const result of rawResults) {
    let fullContent = result.snippet || '';
    let contentHash = '';
    try {
      const res = await fetch(result.url, { headers: { 'User-Agent': 'ChronosOracle/1.0' }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const text = await res.text();
        const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        fullContent = stripped.slice(0, 2000);
        contentHash = crypto.createHash('sha256').update(text).digest('hex');
      }
    } catch {
      contentHash = crypto.createHash('sha256').update(result.snippet || '').digest('hex');
    }
    sources.push({
      url: result.url,
      title: result.title,
      fetchedAt: new Date(),
      excerpt: fullContent.slice(0, 500),
      contentHash,
      source: result.source,
      publishedAt: result.publishedAt ? new Date(result.publishedAt) : null,
      credibility: assessCredibility(result.url),
    });
  }
  return sources;
}

function assessCredibility(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    const high = ['reuters.com','bloomberg.com','apnews.com','bbc.com','ft.com','wsj.com','nytimes.com','theguardian.com','economist.com','federalreserve.gov','bls.gov','sec.gov','ecb.europa.eu','coindesk.com','theblock.co','arxiv.org','nature.com'];
    const med  = ['techcrunch.com','wired.com','cnbc.com','cnn.com','forbes.com','businessinsider.com','marketwatch.com','investing.com'];
    if (high.some(d => hostname.includes(d))) return 'high';
    if (med.some(d => hostname.includes(d))) return 'medium';
    return 'low';
  } catch { return 'low'; }
}

async function buildEvidenceURI(marketId, evidenceBundle) {
  const summary = {
    marketId,
    proposedOutcome: evidenceBundle.proposedOutcome,
    confidence: evidenceBundle.confidence,
    reasoning: evidenceBundle.geminiReasoning,
    sourceCount: evidenceBundle.sources.length,
    sources: evidenceBundle.sources.map(s => ({ url: s.url, contentHash: s.contentHash, fetchedAt: s.fetchedAt })),
    generatedAt: new Date().toISOString(),
  };
  const json = JSON.stringify(summary);
  const b64 = Buffer.from(json).toString('base64');
  return `data:application/json;base64,${b64}`;
}

module.exports = { processSearchResults, assessCredibility, buildEvidenceURI };
