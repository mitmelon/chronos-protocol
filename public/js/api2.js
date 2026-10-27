// Calls for stakes, positions and protocol statistics.
async function get(path) { const r = await fetch(path, { credentials: 'same-origin' }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `Request failed (${r.status})`); return r.json(); }
export const getStats = () => get('/api/stats');
export const getMyPositions = (address, page = 1, limit = 20) => get(`/api/positions/${address}?page=${page}&limit=${limit}`);
export const getTrades = (address, page = 1, limit = 25) => get(`/api/positions/${address}/trades?page=${page}&limit=${limit}`);
/** Tell the server to read this transaction from the chain and store the position. Safe to repeat. */
export async function recordPosition(txHash) {
  const r = await fetch('/api/positions/record', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `Could not record the position (${r.status})`);
  return r.json();
}
