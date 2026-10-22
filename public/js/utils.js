// ─── Chronos Utilities ───────────────────────────────────────────────────────

export function formatUsdc(raw, decimals = 2) {
  if (raw === undefined || raw === null || raw === '') return '—';
  try { return (Number(BigInt(raw)) / 1e6).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
  catch { return '—'; }
}

export function poolPercent(yesBig, noBig) {
  const yes = Number(BigInt(yesBig || '0'));
  const no  = Number(BigInt(noBig  || '0'));
  const total = yes + no;
  if (total === 0) return { yes: 50, no: 50 };
  return { yes: Math.round((yes / total) * 100), no: Math.round((no / total) * 100) };
}

export function formatDate(d, opts = {}) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...opts }); }
  catch { return '—'; }
}

export function formatDateTime(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return '—'; }
}

export function countdown(targetDate) {
  const diff = new Date(targetDate) - Date.now();
  if (diff <= 0) return { label: 'Ended', urgent: true };
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (d > 1) return { label: `${d}d ${h}h`, urgent: false };
  if (d === 1) return { label: `${d}d ${h}h ${m}m`, urgent: d < 1 };
  if (h > 0) return { label: `${h}h ${m}m`, urgent: h < 4 };
  return { label: `${m}m ${s}s`, urgent: true };
}

export function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '—';
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

export function explorerTxUrl(hash, explorerBase) {
  if (!hash || !explorerBase) return null;
  return `${explorerBase.replace(/\/$/, '')}/tx/${hash}`;
}

export function explorerAddrUrl(addr, explorerBase) {
  if (!addr || !explorerBase) return null;
  return `${explorerBase.replace(/\/$/, '')}/address/${addr}`;
}

export function stateClass(state) {
  const map = { Open: 'chip-state-open', TradingClosed: 'chip-state-closed', Resolved: 'chip-state-resolved', Refundable: 'chip-state-refundable', Settled: 'chip-state-settled', Pending: 'chip-state-closed' };
  return map[state] || 'chip-state-settled';
}

export function outcomeClass(outcome) {
  return outcome === 'YES' ? 'chip-outcome-yes' : outcome === 'NO' ? 'chip-outcome-no' : '';
}

let _toastEl;
function getToastContainer() {
  if (!_toastEl) {
    _toastEl = document.getElementById('toast-container');
    if (!_toastEl) { _toastEl = document.createElement('div'); _toastEl.id = 'toast-container'; document.body.appendChild(_toastEl); }
  }
  return _toastEl;
}

export function showToast(message, type = 'default', duration = 3500) {
  const container = getToastContainer();
  const el = document.createElement('div');
  el.className = `toast${type !== 'default' ? ' ' + type : ''}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => { requestAnimationFrame(() => { el.classList.add('show'); }); });
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, duration);
}

export function buildPagination(container, total, current, limit, onPage) {
  const pages = Math.ceil(total / limit);
  if (pages <= 1) { container.innerHTML = ''; return; }
  container.innerHTML = '';
  for (let i = 1; i <= pages; i++) {
    const btn = document.createElement('button');
    btn.className = `btn btn-sm btn-ghost${i === current ? ' active' : ''}`;
    btn.style.minWidth = '36px';
    btn.textContent = i;
    if (i === current) btn.style.background = 'var(--accent-bg)';
    btn.addEventListener('click', () => onPage(i));
    container.appendChild(btn);
  }
}
