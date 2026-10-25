'use strict';
// Minimal in-memory stand-ins for Mongo, the chain, Parallel and Gemini, so the agent can be exercised end to end.
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const ms = (v) => (v instanceof Date ? v.getTime() : v);
const eq = (a, b) => (b === null ? a == null : ms(a) === ms(b));
function cond(val, c) {
  if (c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c) && Object.keys(c).some((k) => k.startsWith('$'))) {
    return Object.entries(c).every(([op, v]) => {
      if (op === '$ne') return !eq(val, v);
      if (op === '$in') return v.some((x) => eq(val, x));
      if (op === '$nin') return !v.some((x) => eq(val, x));
      if (op === '$exists') return (val !== undefined) === v;
      if (op === '$lt') return val != null && ms(val) < ms(v);
      if (op === '$lte') return val != null && ms(val) <= ms(v);
      if (op === '$gt') return val != null && ms(val) > ms(v);
      if (op === '$gte') return val != null && ms(val) >= ms(v);
      throw new Error('unsupported op ' + op);
    });
  }
  return eq(val, c);
}
const match = (doc, f) => Object.entries(f || {}).every(([k, c]) => (k === '$or' ? c.some((sub) => match(doc, sub)) : cond(get(doc, k), c)));
function setPath(o, p, v) { const ks = p.split('.'); let t = o; ks.slice(0, -1).forEach((k) => (t = t[k] = t[k] || {})); t[ks.at(-1)] = v; }
function applyUpdate(doc, upd, inserting) {
  for (const [k, v] of Object.entries(upd.$set || {})) setPath(doc, k, v);
  if (inserting) for (const [k, v] of Object.entries(upd.$setOnInsert || {})) setPath(doc, k, v);
  for (const [k, v] of Object.entries(upd.$inc || {})) setPath(doc, k, (get(doc, k) || 0) + v);
  for (const k of Object.keys(upd.$unset || {})) delete doc[k];
}
class Coll {
  constructor() { this.docs = []; this.n = 0; }
  _ins(d) { if (d._id === undefined) d._id = ++this.n; if (this.docs.some((x) => x._id === d._id)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); this.docs.push(d); return d; }
  async insertOne(d) { this._ins(d); return { insertedId: d._id }; }
  _sort(rows, s) { if (!s) return rows; const [[k, dir]] = Object.entries(s); return [...rows].sort((a, b) => (ms(get(a, k)) > ms(get(b, k)) ? 1 : -1) * dir); }
  find(f) { let rows = this.docs.filter((d) => match(d, f)); const cur = { sort: (s) => { rows = this._sort(rows, s); return cur; }, limit: (n) => { rows = rows.slice(0, n); return cur; }, toArray: async () => rows }; return cur; }
  async findOne(f, o = {}) { return this._sort(this.docs.filter((d) => match(d, f)), o.sort)[0] || null; }
  async countDocuments(f) { return this.docs.filter((d) => match(d, f)).length; }
  async updateOne(f, upd, o = {}) {
    const d = this.docs.find((x) => match(x, f));
    if (d) { applyUpdate(d, upd, false); return { matchedCount: 1, modifiedCount: 1 }; }
    if (o.upsert) { const base = {}; for (const [k, v] of Object.entries(f)) if (!k.startsWith('$') && !(v && typeof v === 'object' && !(v instanceof Date))) setPath(base, k, v); applyUpdate(base, upd, true); this._ins(base); return { matchedCount: 0, upsertedCount: 1 }; }
    return { matchedCount: 0 };
  }
  async updateMany(f, upd) { const rows = this.docs.filter((d) => match(d, f)); rows.forEach((d) => applyUpdate(d, upd, false)); return { matchedCount: rows.length }; }
  async replaceOne(f, doc, o = {}) { const i = this.docs.findIndex((x) => match(x, f)); if (i >= 0) this.docs[i] = { _id: this.docs[i]._id, ...doc }; else if (o.upsert) this._ins({ ...doc }); }
  async deleteOne(f) { const i = this.docs.findIndex((x) => match(x, f)); if (i >= 0) this.docs.splice(i, 1); }
  async findOneAndUpdate(f, upd, o = {}) {
    const d = this.docs.find((x) => match(x, f));
    if (d) { applyUpdate(d, upd, false); return d; }
    if (o.upsert) { if (f._id !== undefined && this.docs.some((x) => x._id === f._id)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); const nd = { _id: f._id }; applyUpdate(nd, upd, true); this._ins(nd); return nd; }
    return null;
  }
  async findOneAndDelete(f) { const i = this.docs.findIndex((x) => match(x, f)); return i >= 0 ? this.docs.splice(i, 1)[0] : null; }
  async createIndex() {}
}
function fakeDb() { const c = {}; return { collection: (n) => (c[n] = c[n] || new Coll()), _c: c }; }

function fakeChain(clock) {
  const markets = []; const calls = { resolve: 0, refund: 0, create: 0 };
  const FINAL = ['Resolved', 'Refundable'];
  const api = {
    markets, calls,
    async getMarketCount() { return markets.length; },
    async getMarket(id) { const m = markets[id]; if (!m) throw new Error('no market ' + id); return { marketId: id, ...m, tradingDeadline: new Date(m.tradingTs * 1000), resolutionDeadline: new Date(m.resolutionTs * 1000), yesPool: '0', noPool: '0', totalPool: '0', resolvedAt: null, evidenceURI: m.evidenceURI || '', swept: false, creator: '0x0', feeBps: 500 }; },
    async createMarket(question, resolutionCriteria, tradingTs, resolutionTs) { calls.create++; markets.push({ question, resolutionCriteria, tradingTs, resolutionTs, state: 'Open', outcome: 'UNRESOLVED' }); return { txHash: '0xcreate' + markets.length, marketId: markets.length - 1 }; },
    async closeTrading(id) { markets[id].state = 'TradingClosed'; return { txHash: '0xclose' }; },
    async resolveMarket(id, outcome, uri) { const m = markets[id]; if (FINAL.includes(m.state)) throw Object.assign(new Error('would revert (InvalidMarketState)'), { errorName: 'InvalidMarketState' }); calls.resolve++; m.state = 'Resolved'; m.outcome = outcome === 1 ? 'YES' : 'NO'; m.evidenceURI = uri; return { txHash: '0xresolve' + calls.resolve }; },
    async markRefundable(id) { const m = markets[id]; if (FINAL.includes(m.state)) throw Object.assign(new Error('InvalidMarketState'), { errorName: 'InvalidMarketState' }); if (clock.t <= m.resolutionTs * 1000) throw Object.assign(new Error('InvalidDeadline'), { errorName: 'InvalidDeadline' }); calls.refund++; m.state = 'Refundable'; return { txHash: '0xrefund' }; },
  };
  return api;
}

const fc = (name, args) => ({ functionCall: { name, args } });
function fakeGemini(script) {
  const queue = [...script]; const log = [];
  return {
    log,
    models: {
      async generateContent({ contents, config }) {
        const step = queue.shift();
        if (!step) throw new Error('fake Gemini script exhausted');
        const parts = Array.isArray(step) ? step : [{ text: step }];
        log.push(parts.map((p) => p.functionCall?.name || 'text'));
        return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], functionCalls: parts.filter((p) => p.functionCall).map((p) => p.functionCall) };
      },
    },
  };
}

module.exports = { fakeDb, fakeChain, fakeGemini, fc };
