'use strict';
/**
 * src/services/gemini.js
 *
 * Built on the current Google Gen AI SDK (@google/genai), not hand-rolled REST.
 *
 *   runAgent()      a real tool-calling loop: Gemini decides which tools to call (web search, page
 *                   reads, contract actions), sees each result, and keeps going until it finishes
 *                   or calls a terminal tool. Code-level guards live INSIDE the tool handlers, so
 *                   the model can propose actions but can never bypass the rules.
 *   generateJson()  one-shot structured call, used for independent verification.
 *
 * Gemini 3 requires thought signatures to be echoed back during function calling. We append the
 * model's returned content to the history unchanged, which preserves them.
 */

const { GoogleGenAI, FunctionCallingConfigMode } = require('@google/genai');
const config = require('../config');
const { withTimeout, retry } = require('../agent/lib');

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY not configured');
  _client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return _client;
}
/** Test hook: inject a fake client. */
function setClientForTests(client) { _client = client; }

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT_STATUS.has(err.status)) return true;
  return /fetch failed|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|overloaded|UNAVAILABLE/i.test(err.message || '');
}

function textOf(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
}

async function callModel({ model, contents, system, tools, temperature, json, schema }) {
  const cfg = { systemInstruction: system, temperature, maxOutputTokens: 8192 };
  if (tools && tools.length) {
    cfg.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
    cfg.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
  }
  if (json) { cfg.responseMimeType = 'application/json'; if (schema) cfg.responseJsonSchema = schema; }

  const response = await retry(
    () => withTimeout(getClient().models.generateContent({ model, contents, config: cfg }), 120000, 'Gemini generateContent'),
    { tries: 4, baseMs: 2500, label: `gemini:${model}`, shouldRetry: isTransient }
  );
  if (response.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt: ${response.promptFeedback.blockReason}`);
  const cand = response.candidates?.[0];
  if (!cand?.content?.parts?.length) throw new Error(`Gemini returned no content (finishReason: ${cand?.finishReason || 'unknown'})`);
  return response;
}

/** One-shot structured call. Returns the parsed JSON object. */
async function generateJson({ system, prompt, schema, model = config.gemini.verifierModel, temperature = 0 }) {
  const response = await callModel({ model, system, contents: [{ role: 'user', parts: [{ text: prompt }] }], temperature, json: true, schema });
  const raw = textOf(response);
  try { return JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    throw new Error(`Gemini returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}

const clip = (value, max = 12000) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + `…[truncated ${s.length - max} chars]` : s;
};

/**
 * The agent loop.
 *
 * tools: [{ name, description, parameters (JSON Schema), readOnly?, handler(args) -> object }]
 *   A handler returns a plain object. Return { ok:false, ... } to refuse; the model sees the reason
 *   and can adjust. If a handler returns { terminal: true } the loop ends after that call.
 *
 * Returns { finished, terminalTool, terminalResult, text, steps, trace, stopReason }.
 */
async function runAgent({ system, goal, tools, model = config.gemini.model, maxSteps = config.agent.maxSteps, temperature = 0.3, onStep, label = 'agent' }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const contents = [{ role: 'user', parts: [{ text: goal }] }];
  const trace = [];
  let steps = 0;

  while (steps < maxSteps) {
    steps++;
    const response = await callModel({ model, system, contents, tools, temperature });
    contents.push(response.candidates[0].content); // unchanged: keeps thought signatures

    const calls = response.functionCalls || [];
    if (!calls.length) return { finished: false, text: textOf(response), steps, trace, stopReason: 'model_stopped' };

    const remaining = maxSteps - steps;
    const run = async (call) => {
      const tool = byName.get(call.name);
      const started = Date.now();
      let result;
      if (!tool) result = { ok: false, error: `Unknown tool "${call.name}". Available: ${[...byName.keys()].join(', ')}` };
      else {
        try { result = await withTimeout(() => tool.handler(call.args || {}), 180000, `tool ${call.name}`); }
        catch (err) { result = { ok: false, error: String(err.message || err).slice(0, 500) }; }
      }
      if (result === undefined || result === null) result = { ok: true };
      const entry = { step: steps, tool: call.name, args: clip(call.args || {}, 400), ok: result.ok !== false, ms: Date.now() - started, result: clip(result, 400) };
      trace.push(entry);
      if (onStep) { try { onStep(entry); } catch { /* never let logging break the agent */ } }
      return { call, result };
    };

    const executed = [];
    if (calls.every((c) => byName.get(c.name)?.readOnly)) executed.push(...await Promise.all(calls.map(run)));
    else for (const c of calls) executed.push(await run(c)); // side-effecting tools run one at a time, in order

    const terminal = executed.find((e) => e.result && e.result.terminal === true);
    if (terminal) return { finished: true, terminalTool: terminal.call.name, terminalResult: terminal.result, text: '', steps, trace, stopReason: 'terminal' };

    const parts = executed.map(({ call, result }) => {
      const out = remaining <= 2 ? { ...result, budget_warning: `Only ${remaining} step(s) left. Finish now by calling a final tool.` } : result;
      const json = JSON.stringify(out);
      const fr = { name: call.name, response: { output: json.length > 12000 ? { truncated: true, preview: json.slice(0, 12000) } : out } };
      if (call.id) fr.id = call.id;
      return { functionResponse: fr };
    });
    contents.push({ role: 'user', parts });
  }
  return { finished: false, text: '', steps, trace, stopReason: 'max_steps' };
}

module.exports = { runAgent, generateJson, getClient, setClientForTests, isTransient, textOf };
