// ─── Chronos app: router, shell, sidebar ─────────────────────────────────────
import { wallet } from './wallet.js';
import { mountWalletButton } from './wallet-menu.js';
import { enhanceSelects, closePopover } from './ui.js';
import { refreshSession } from './session.js';
import './landing.js';
import { formatUsdc } from './utils.js';
import { renderOverview }     from './pages/overview.js';
import { renderMarkets }      from './pages/markets.js';
import { renderMarketDetail } from './pages/market-detail.js';
import { renderPositions }    from './pages/positions.js';
import { renderResolutions }  from './pages/resolutions.js';
import { renderAgent }        from './pages/agent.js';
import { renderSettings }     from './pages/settings.js';

const $ = (id) => document.getElementById(id);
const landing = $('landing'), app = $('app'), root = $('page-root');
const sidebar = $('sidebar'), backdrop = $('sidebar-backdrop'), menuBtn = $('sidebar-toggle');

const PAGES = {
  overview:    { render: renderOverview,     title: 'Overview', nav: 'overview' },
  markets:     { render: renderMarkets,      title: 'Markets', nav: 'markets' },
  market:      { render: renderMarketDetail, title: 'Market', nav: 'markets' },
  positions:   { render: renderPositions,    title: 'My positions', nav: 'positions' },
  resolutions: { render: renderResolutions,  title: 'Resolutions', nav: 'resolutions' },
  agent:       { render: renderAgent,        title: 'Oracle', nav: 'agent' },
  settings:    { render: renderSettings,     title: 'Settings', nav: 'settings' },
};

// ── Landing ⇄ app ────────────────────────────────────────────────────────────
function showApp()     { landing.hidden = true;  app.hidden = false; }
function showLanding() { app.hidden = true; landing.hidden = false; closeSidebar(); }

document.querySelectorAll('[data-launch]').forEach(el => el.addEventListener('click', () => {
  showApp();
  if (!parseHash()) location.hash = '#overview'; else route();
  window.scrollTo(0, 0);
}));

// ── Routing: #page or #page/id (non-route hashes are plain landing anchors) ──
function parseHash() {
  const [page, id, flag] = location.hash.replace(/^#\/?/, '').split('/');
  return PAGES[page] ? { page, params: { id, trade: flag === 'trade' } } : null;
}

export function navigate(page, params = {}) {
  const hash = `#${page}${params.id !== undefined ? '/' + params.id : ''}`;
  if (location.hash === hash) route(); else location.hash = hash;
}
window.chronosRouter = navigate;

let _seq = 0;
async function route() {
  const r = parseHash();
  if (!r) return;
  showApp();
  const def = PAGES[r.page];
  document.querySelectorAll('.nav-item').forEach(a => {
    if (a.dataset.page === def.nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = `${def.title} · Chronos`;
  closePopover(); closeSidebar();

  // Every navigation gets a fresh container, so late async writes from a
  // previous page land in a detached node instead of the current screen.
  const view = document.createElement('div');
  root.replaceChildren(view);
  const mine = ++_seq;
  window.scrollTo(0, 0);
  try { await def.render(view, r.params); }
  catch (err) {
    if (mine === _seq) view.innerHTML = `<div class="empty"><h3>Something went wrong</h3><p>${String(err.message || err).replace(/[<>&]/g, '')}</p></div>`;
  }
}

window.addEventListener('hashchange', () => {
  if (parseHash()) route();
  else if (!location.hash) showLanding();
});

// Any select added to a page becomes the accessible custom select.
new MutationObserver(() => enhanceSelects(root)).observe(root, { childList: true, subtree: true });

// ── Sidebar (mobile) ─────────────────────────────────────────────────────────
function openSidebar() {
  sidebar.classList.add('open'); backdrop.classList.add('on');
  menuBtn.setAttribute('aria-expanded', 'true'); document.body.style.overflow = 'hidden';
}
function closeSidebar() {
  sidebar.classList.remove('open'); backdrop.classList.remove('on');
  menuBtn.setAttribute('aria-expanded', 'false'); document.body.style.overflow = '';
}
menuBtn.addEventListener('click', () => sidebar.classList.contains('open') ? closeSidebar() : openSidebar());
backdrop.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sidebar.classList.contains('open')) { closeSidebar(); menuBtn.focus(); } });
window.matchMedia('(min-width: 901px)').addEventListener('change', closeSidebar);

// ── Wallet + balance ─────────────────────────────────────────────────────────
mountWalletButton($('wallet-btn-container'));

async function refreshBalance() {
  const wrap = $('usdc-balance-display'), val = $('usdc-balance-value');
  if (!wallet.connected) { wrap.hidden = true; return; }
  wrap.hidden = false;
  try { val.textContent = formatUsdc(await wallet.usdcBalance()); } catch { val.textContent = '—'; }
}
wallet.onUpdate(refreshBalance);
setInterval(refreshBalance, 30000);
wallet.ready().then(refreshBalance);
refreshSession();

// ── Boot ─────────────────────────────────────────────────────────────────────
if (parseHash()) route();
