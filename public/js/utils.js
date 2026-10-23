// ─── Chronos utilities ───────────────────────────────────────────────────────

/** Escape untrusted text before putting it in an innerHTML template. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatUsdc(raw, decimals = 2) {
  if (raw === undefined || raw === null || raw === '') return '—';
  try {
    return (Number(BigInt(raw)) / 1e6).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  } catch { return '—'; }
}

export function poolPercent(yesRaw, noRaw) {
  let yes = 0, no = 0;
  try { yes = Number(BigInt(yesRaw || '0')); no = Number(BigInt(noRaw || '0')); } catch {}
  const total = yes + no;
  if (total === 0) return { yes: 50, no: 50 };
  const y = Math.round((yes / total) * 100);
  return { yes: y, no: 100 - y };
}

export function formatDate(d, opts = {}) {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date)) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...opts });
}

export function formatDateTime(d) {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date)) return '—';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function timeAgo(d) {
  const date = new Date(d);
  if (!d || isNaN(date)) return '—';
  const s = Math.max(0, Math.round((Date.now() - date) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function countdown(target) {
  const diff = new Date(target) - Date.now();
  if (!target || isNaN(diff)) return { label: '—', urgent: false, ended: false };
  if (diff <= 0) return { label: 'Ended', urgent: false, ended: true };
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (d >= 2) return { label: `${d}d ${h}h`, urgent: false, ended: false };
  if (d === 1) return { label: `1d ${h}h`, urgent: false, ended: false };
  if (h > 0) return { label: `${h}h ${m}m`, urgent: h < 4, ended: false };
  return { label: `${m}m`, urgent: true, ended: false };
}

export function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '—';
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

export function explorerTxUrl(hash, base = window.CHRONOS_EXPLORER) {
  return hash && base ? `${base.replace(/\/$/, '')}/tx/${hash}` : null;
}

export function explorerAddrUrl(addr, base = window.CHRONOS_EXPLORER) {
  return addr && base ? `${base.replace(/\/$/, '')}/address/${addr}` : null;
}

// ── Status, outcome and split-bar markup ──────────────────────────────────────

const STATE = {
  Open:          { key: 'open',       label: 'Open' },
  TradingClosed: { key: 'closed',     label: 'Awaiting oracle' },
  Resolved:      { key: 'resolved',   label: 'Resolved' },
  Refundable:    { key: 'refundable', label: 'Refundable' },
  Settled:       { key: 'settled',    label: 'Settled' },
  Pending:       { key: 'closed',     label: 'Pending' },
};

export function stateLabel(state) { return (STATE[state] || { label: state || '—' }).label; }

export function statusPill(state) {
  const s = STATE[state] || { key: 'settled', label: state || '—' };
  return `<span class="status status-${s.key}"><i></i>${esc(s.label)}</span>`;
}

export function outcomeTag(outcome) {
  if (outcome === 'YES') return '<span class="tag tag-yes">Yes</span>';
  if (outcome === 'NO')  return '<span class="tag tag-no">No</span>';
  return '';
}

export function splitBar(pct, large = false) {
  return `
    <div class="split${large ? ' split-lg' : ''}" role="img" aria-label="Yes ${pct.yes}%, No ${pct.no}%">
      <div class="split-track"><div class="split-yes" style="width:${pct.yes}%"></div></div>
      <div class="split-labels"><span>Yes ${pct.yes}%</span><span>No ${pct.no}%</span></div>
    </div>`;
}

export function emptyState(title, text = '', action = '') {
  return `<div class="empty"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
}

export function skeletonRows(n = 4, h = 44) {
  return Array.from({ length: n }, () => `<div style="padding:8px 20px"><div class="skeleton" style="height:${h}px"></div></div>`).join('');
}

// ── Toasts ────────────────────────────────────────────────────────────────────

export function showToast(message, type = 'info', duration = 3800) {
  let box = document.getElementById('toast-container');
  if (!box) { box = document.createElement('div'); box.id = 'toast-container'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast toast-${type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── Pagination ────────────────────────────────────────────────────────────────

export function buildPagination(container, total, current, limit, onPage) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) { container.innerHTML = ''; container.hidden = true; return; }
  container.hidden = false;
  container.innerHTML = `
    <span>Page ${current} of ${pages}</span>
    <div>
      <button class="btn btn-secondary btn-sm" data-dir="-1" ${current <= 1 ? 'disabled' : ''}>Previous</button>
      <button class="btn btn-secondary btn-sm" data-dir="1" ${current >= pages ? 'disabled' : ''}>Next</button>
    </div>`;
  container.querySelectorAll('button').forEach(b => b.addEventListener('click', () => onPage(current + Number(b.dataset.dir))));
}

// Kept for any older imports; they now map to the new markup helpers.
export const stateClass = (s) => `status-${(STATE[s] || { key: 'settled' }).key}`;
export const outcomeClass = (o) => (o === 'YES' ? 'tag-yes' : o === 'NO' ? 'tag-no' : '');
