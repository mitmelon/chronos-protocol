'use strict';

const config = require('../config');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Retry a fetch-based async call with exponential backoff + jitter.
 * Retries on: 429 (rate limit), 503 (overloaded), 502 (gateway), 408 (timeout).
 */
async function withRetry(fn, { maxAttempts = 5, baseDelayMs = 2000, maxDelayMs = 60000, label = 'call' } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = err._retryable === true;
      if (!isRetryable || attempt === maxAttempts) throw err;
      // Exponential backoff with ±20% jitter
      const raw   = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = raw * 0.2 * (Math.random() * 2 - 1);
      const delay  = Math.min(Math.round(raw + jitter), maxDelayMs);
      console.warn(`[gemini] ${label} attempt ${attempt}/${maxAttempts} failed (${err.message}). Retrying in ${Math.round(delay / 1000)}s…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function generateContent(prompt, systemInstruction) {
  if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY not configured');

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
  };
  if (systemInstruction) body.system_instruction = { parts: [{ text: systemInstruction }] };

  const url = `${GEMINI_API_BASE}/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;

  return withRetry(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Gemini API error ${res.status}: ${text}`);
      // Mark retryable status codes
      err._retryable = [429, 500, 502, 503, 504, 408].includes(res.status);
      throw err;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned empty response');
    return { text, tokensUsed: data?.usageMetadata?.totalTokenCount || 0 };
  }, { maxAttempts: 5, baseDelayMs: 3000, maxDelayMs: 90000, label: 'generateContent' });
}

async function generateMarketQuestion(eventData) {
  const system = `You are an expert at creating precise, objectively verifiable YES/NO prediction market questions.
Rules:
- Questions must have a definitive YES or NO answer based on publicly verifiable facts
- Never create questions about opinions, subjective judgments, or ambiguous outcomes
- Include exact metrics, thresholds, timezones, and authoritative sources in resolution criteria
- Resolution criteria must be testable by any independent observer using the named sources`;

  const prompt = `Create a prediction market question from this event data:
${JSON.stringify(eventData, null, 2)}

Return a JSON object with exactly these fields:
{
  "question": "Will [exact verifiable event] by [specific date/time]?",
  "resolutionCriteria": "This market resolves YES if [exact condition with source]. Resolves NO if [exact condition]. Source: [specific authoritative source URL or publication]. Timezone: [timezone]. Cutoff: [exact date/time].",
  "category": "Finance|Politics|Technology|Sports|Science|Other",
  "tags": ["tag1", "tag2"],
  "tradingDeadlineDaysFromNow": 1,
  "resolutionDeadlineDaysFromNow": 7,
  "authoritySource": "URL of primary authoritative source",
  "verifiable": true,
  "rejectionReason": null
}

If the event cannot be turned into a valid verifiable question, set verifiable: false and rejectionReason to a short explanation.`;

  const result = await generateContent(prompt, system);
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    return { parsed: JSON.parse(jsonMatch[0]), tokensUsed: result.tokensUsed };
  } catch (err) {
    throw new Error(`Failed to parse Gemini market question: ${err.message}\nRaw: ${result.text}`);
  }
}

async function proposeResolution(market, evidence) {
  const system = `You are an AI oracle for a prediction market. Your job is to determine the correct outcome based strictly on the resolution criteria and the evidence provided.
Rules:
- Only use the provided evidence. Never invent or assume facts not present in the evidence.
- If evidence is insufficient or conflicting, output UNRESOLVABLE.
- If confidence is below 0.85, output UNRESOLVABLE.
- Never fabricate sources, quotes, or outcomes.`;

  const prompt = `Prediction market question: "${market.question}"

Resolution criteria: "${market.resolutionCriteria}"

Evidence gathered:
${evidence.sources.map((s, i) => `[${i + 1}] ${s.url} (fetched ${s.fetchedAt})
Excerpt: ${s.excerpt}
Content hash: ${s.contentHash}`).join('\n\n')}

Based strictly on the evidence above and the resolution criteria, determine the outcome.

Return a JSON object with exactly these fields:
{
  "proposedOutcome": "YES" | "NO" | "UNRESOLVABLE",
  "confidence": 0.0-1.0,
  "reasoning": "Explain your conclusion in 2-3 sentences, citing specific evidence.",
  "conflictDetected": true | false,
  "insufficientEvidence": true | false
}`;

  const result = await generateContent(prompt, system);
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    return { parsed: JSON.parse(jsonMatch[0]), tokensUsed: result.tokensUsed };
  } catch (err) {
    throw new Error(`Failed to parse Gemini resolution proposal: ${err.message}\nRaw: ${result.text}`);
  }
}

async function validateQuestion(question, resolutionCriteria, existingQuestions) {
  const system = `You are a strict quality checker for prediction market questions.`;
  const prompt = `Check this prediction market question for quality issues:

Question: "${question}"
Resolution criteria: "${resolutionCriteria}"

Existing questions to check for duplicates:
${existingQuestions.slice(0, 20).map((q, i) => `[${i + 1}] ${q}`).join('\n')}

Return a JSON object:
{
  "valid": true | false,
  "isDuplicate": true | false,
  "rejectionReason": "null or short reason",
  "similarTo": "null or similar existing question"
}

Reject if: duplicate/similar, outcome already known, subjective/opinion-based, no verifiable source, ambiguous YES/NO, question >1024 chars.`;

  const result = await generateContent(prompt, system);
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    return { parsed: JSON.parse(jsonMatch[0]), tokensUsed: result.tokensUsed };
  } catch (err) {
    throw new Error(`Failed to parse Gemini validation: ${err.message}`);
  }
}

module.exports = { generateContent, generateMarketQuestion, proposeResolution, validateQuestion };
