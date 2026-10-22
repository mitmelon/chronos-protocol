// ─── Chronos API Client ──────────────────────────────────────────────────────

const API_BASE = window.CHRONOS_API_URL || '/api';

class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'Content-Type': 'application/json', ...options.headers }, ...options });
  if (!res.ok) { let body = {}; try { body = await res.json(); } catch {} throw new ApiError(body.message || `HTTP ${res.status}`, res.status, body.code); }
  return res.json();
}

export const api = {
  async protocolStatus() { return apiFetch('/protocol/status'); },
  async publicSettings() { return apiFetch('/settings/public'); },
  async markets(params = {}) {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== 'all' && v !== ''))).toString();
    return apiFetch(`/markets${qs ? '?' + qs : ''}`);
  },
  async market(id) { return apiFetch(`/markets/${id}`); },
  async marketEvidence(id) { return apiFetch(`/markets/${id}/evidence`); },
  async marketTrades(id, params = {}) { const qs = new URLSearchParams(params).toString(); return apiFetch(`/markets/${id}/trades${qs ? '?' + qs : ''}`); },
  async positions(address, params = {}) { const qs = new URLSearchParams(params).toString(); return apiFetch(`/positions/${address}${qs ? '?' + qs : ''}`); },
  async claimable(address) { return apiFetch(`/positions/${address}/claimable`); },
  async resolutions(params = {}) {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== 'all' && v !== ''))).toString();
    return apiFetch(`/resolutions${qs ? '?' + qs : ''}`);
  },
  async agentRuns(params = {}) { const qs = new URLSearchParams(params).toString(); return apiFetch(`/agent/runs${qs ? '?' + qs : ''}`); },
  async agentRun(runId) { return apiFetch(`/agent/runs/${runId}`); },
  async dailyReport() { return apiFetch(`/agent/daily-report`); },
};

export { ApiError };
