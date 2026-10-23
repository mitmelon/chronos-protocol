// ─── Chronos UI primitives ───────────────────────────────────────────────────
// Popover positioning, an accessible custom <select>, icons, and shared helpers.
import { wallet } from './wallet.js';
import { esc, showToast } from './utils.js';

const svg = (body, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icon = {
  chevron: svg('<polyline points="6 9 12 15 18 9"/>', 14),
  check:   svg('<polyline points="20 6 9 17 4 12"/>', 14),
  copy:    svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 14),
  external: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>', 14),
  back:    svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>', 14),
  refresh: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', 14),
  search:  svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', 14),
  wallet:  svg('<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>', 28),
  markets: svg('<line x1="4" y1="20" x2="4" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="20" y1="20" x2="20" y2="14"/>', 28),
};

// ── Popover (one open at a time, rendered in <body> so nothing clips it) ──────

let _pop = null;

export function closePopover() { if (_pop) _pop.close(); }

export function openPopover(anchor, el, { align = 'start', matchWidth = false, gap = 6 } = {}) {
  closePopover();
  el.classList.add('popover');
  document.body.appendChild(el);

  const place = () => {
    const r = anchor.getBoundingClientRect();
    if (matchWidth) el.style.minWidth = `${r.width}px`;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + gap;
    if (top + h > window.innerHeight - 8 && r.top - gap - h > 8) top = r.top - gap - h;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  place();

  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus({ preventScroll: true }); } };
  const onScroll = (e) => { if (!el.contains(e.target)) close(); };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', close);
  anchor.setAttribute('aria-expanded', 'true');

  function close() {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
    anchor.setAttribute('aria-expanded', 'false');
    el.remove();
    if (_pop && _pop.el === el) _pop = null;
  }
  _pop = { anchor, el, close };
  return _pop;
}

export const popoverOpenFor = (anchor) => !!_pop && _pop.anchor === anchor;

// ── Select ────────────────────────────────────────────────────────────────────
// Progressive enhancement: the native <select> stays in the DOM (hidden), so
// page code keeps using select.value and the 'change' event unchanged.

export function enhanceSelects(root = document) {
  root.querySelectorAll('select:not([data-enhanced])').forEach(buildSelect);
}

let _uid = 0;

function buildSelect(select) {
  select.dataset.enhanced = '1';
  const uid = `sel${++_uid}`;
  const wrap = document.createElement('div');
  wrap.className = 'sel';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sel-trigger';
  btn.setAttribute('role', 'combobox');
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', `${uid}-list`);
  const name = select.getAttribute('aria-label');
  if (name) btn.setAttribute('aria-label', name);

  select.before(wrap);
  wrap.append(btn, select);
  select.classList.add('sr-only');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const sync = () => {
    const o = select.options[select.selectedIndex];
    btn.innerHTML = `<span>${esc(o ? o.textContent : '')}</span>${icon.chevron}`;
  };
  sync();
  select.addEventListener('change', sync);

  let active = -1, list = null, typed = '', typedAt = 0;

  const setActive = (i) => {
    const items = list ? [...list.children] : [];
    if (!items.length) return;
    active = Math.max(0, Math.min(i, items.length - 1));
    items.forEach((li, n) => li.dataset.active = String(n === active));
    btn.setAttribute('aria-activedescendant', items[active].id);
    items[active].scrollIntoView({ block: 'nearest' });
  };

  const choose = (i) => {
    closePopover();
    if (i >= 0 && select.selectedIndex !== i) {
      select.selectedIndex = i;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    btn.focus({ preventScroll: true });
  };

  const open = () => {
    list = document.createElement('ul');
    list.id = `${uid}-list`;
    list.className = 'sel-menu';
    list.setAttribute('role', 'listbox');
    [...select.options].forEach((o, i) => {
      const li = document.createElement('li');
      li.id = `${uid}-o${i}`;
      li.className = 'sel-opt';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === select.selectedIndex));
      li.innerHTML = `<span>${esc(o.textContent)}</span>${i === select.selectedIndex ? icon.check : ''}`;
      li.addEventListener('pointermove', () => setActive(i));
      li.addEventListener('click', () => choose(i));
      list.appendChild(li);
    });
    const pop = openPopover(btn, list, { matchWidth: true, gap: 4 });
    const origClose = pop.close;
    pop.close = () => { list = null; btn.removeAttribute('aria-activedescendant'); origClose(); };
    setActive(select.selectedIndex);
  };

  btn.addEventListener('click', () => { popoverOpenFor(btn) ? closePopover() : open(); });

  btn.addEventListener('keydown', (e) => {
    const isOpen = popoverOpenFor(btn);
    const n = select.options.length;
    if (!isOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Tab') { closePopover(); }
    else if (e.key.length === 1) {
      const now = Date.now();
      typed = now - typedAt > 600 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = now;
      const hit = [...select.options].findIndex(o => o.textContent.trim().toLowerCase().startsWith(typed));
      if (hit >= 0) setActive(hit);
    }
  });
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Subscribe to wallet changes for the lifetime of a page view. */
export function onWallet(view, fn) {
  const off = wallet.onUpdate(() => { if (!view.isConnected) { off(); return; } fn(); });
  return off;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showToast('Copied to clipboard'); }
  catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); showToast('Copied to clipboard'); } catch { showToast('Could not copy', 'error'); }
    t.remove();
  }
}

/** Claim winnings or a refund depending on market state. Returns the tx hash. */
export function claimPayout(marketId, state) {
  return state === 'Resolved' ? wallet.claimWinnings(marketId) : wallet.claimRefund(marketId);
}

/** Wire [data-claim] buttons inside root. */
export function wireClaimButtons(root) {
  root.querySelectorAll('[data-claim]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Claiming…';
      try {
        await claimPayout(btn.dataset.claim, btn.dataset.state);
        showToast('Claimed successfully', 'success');
        btn.textContent = 'Claimed';
      } catch (err) {
        showToast(`Claim failed: ${err.message}`, 'error');
        btn.disabled = false; btn.textContent = 'Claim';
      }
    });
  });
}
