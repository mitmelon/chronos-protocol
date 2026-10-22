// ─── Chronos App Router ──────────────────────────────────────────────────────
import { mountWalletButton, wallet } from './wallet.js';
import { renderOverview }     from './pages/overview.js';
import { renderMarkets }      from './pages/markets.js';
import { renderMarketDetail } from './pages/market-detail.js';
import { renderPositions }    from './pages/positions.js';
import { renderResolutions }  from './pages/resolutions.js';
import { renderAgent }        from './pages/agent.js';
import { renderSettings }     from './pages/settings.js';
import { formatUsdc }         from './utils.js';

mountWalletButton(document.getElementById('wallet-btn-container'));

async function refreshUsdcDisplay() {
  const wrap = document.getElementById('usdc-balance-display');
  const val  = document.getElementById('usdc-balance-value');
  if (!wrap || !val) return;
  if (!wallet.connected) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  try { val.textContent = formatUsdc(await wallet.usdcBalance()); } catch { val.textContent = '—'; }
}

wallet.onUpdate(() => refreshUsdcDisplay());

const PAGE_ROOT = document.getElementById('page-root');

const PAGES = {
  overview: renderOverview, markets: renderMarkets, market: renderMarketDetail,
  positions: renderPositions, resolutions: renderResolutions, agent: renderAgent, settings: renderSettings,
};

function navigate(page, params = {}) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  const hash = page + (params.id !== undefined ? '/' + params.id : '');
  history.replaceState({ page, params }, '', '#' + hash);
  PAGE_ROOT.scrollTop = 0;
  (PAGES[page] || renderOverview)(PAGE_ROOT, params);
}

window.chronosRouter = navigate;

// Wire nav item click → navigate + close sidebar on mobile
document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => {
    navigate(btn.dataset.page);
    if (window.innerWidth <= 768 && window._closeSidebar) window._closeSidebar();
  });
});

function parseHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return { page: 'overview', params: {} };
  const parts = hash.split('/');
  return { page: parts[0] || 'overview', params: parts[1] ? { id: parts[1] } : {} };
}

window.addEventListener('popstate', (e) => { const { page, params } = e.state || parseHash(); navigate(page, params); });

const { page, params } = parseHash();
navigate(page, params);
setInterval(refreshUsdcDisplay, 30000);
