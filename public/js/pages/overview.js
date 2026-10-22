// ─── Overview Page ───────────────────────────────────────────────────────────
import { api } from '../api.js';
import { formatUsdc, formatDate, stateClass, outcomeClass, countdown } from '../utils.js';
import { wallet } from '../wallet.js';

export async function renderOverview(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Overview</h1>
      <p class="page-subtitle">Protocol activity, open markets, and your positions</p>
    </div>

    <!-- Stats -->
    <div class="stat-grid" id="stat-grid">
      ${['', '', '', ''].map(() => `<div class="stat-card"><div class="skeleton" style="height:12px;width:80px;margin-bottom:10px"></div><div class="skeleton" style="height:32px;width:120px"></div></div>`).join('')}
    </div>

    <!-- Two-column layout -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px" class="two-col">
      <!-- Open markets -->
      <div class="card" style="padding:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <span style="font-weight:600;color:var(--ink)">Open Markets</span>
          <button class="btn btn-sm btn-ghost" data-page="markets">View All</button>
        </div>
        <div id="open-markets-list"></div>
      </div>

      <!-- Recent resolutions -->
      <div class="card" style="padding:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <span style="font-weight:600;color:var(--ink)">Recent Resolutions</span>
          <button class="btn btn-sm btn-ghost" data-page="resolutions">Archive</button>
        </div>
        <div id="recent-resolutions-list"></div>
      </div>
    </div>

    <!-- My positions (if connected) -->
    <div id="my-positions-section" style="display:none">
      <div class="card" style="padding:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <span style="font-weight:600;color:var(--ink)">My Active Positions</span>
          <button class="btn btn-sm btn-ghost" data-page="positions">All Positions</button>
        </div>
        <div id="my-positions-list"></div>
      </div>
    </div>
  `;

  // Wire nav buttons
  container.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => window.chronosRouter(btn.dataset.page));
  });

  // Load data concurrently
  const [protocolResult, marketsResult, resolutionsResult] = await Promise.allSettled([
    api.protocolStatus(),
    api.markets({ state: 'Open', limit: 5, sort: 'deadline' }),
    api.resolutions({ limit: 5 }),
  ]);

  // Render stats
  const stats = container.querySelector('#stat-grid');
  if (protocolResult.status === 'fulfilled') {
    const p = protocolResult.value;
    stats.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Open Markets</div>
        <div class="stat-value">${p.openMarkets ?? '—'}</div>
        <div class="stat-subtext">Accepting positions</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Resolved Markets</div>
        <div class="stat-value">${p.resolvedMarkets ?? '—'}</div>
        <div class="stat-subtext">Total lifecycle</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Volume</div>
        <div class="stat-value">${formatUsdc(p.totalVolumeUsdc, 0)} <span style="font-size:14px;font-weight:500;color:var(--muted)">USDC</span></div>
        <div class="stat-subtext">All-time staked</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Protocol Fee</div>
        <div class="stat-value">${(p.feeBps / 100).toFixed(1)}%</div>
        <div class="stat-subtext">On winners' profit</div>
      </div>
    `;
  } else {
    stats.innerHTML = `<div class="stat-card" style="grid-column:1/-1"><p style="color:var(--muted);font-size:13px;text-align:center">Protocol data unavailable — contract may not be deployed yet.</p></div>`;
  }

  // Render open markets
  const openList = container.querySelector('#open-markets-list');
  if (marketsResult.status === 'fulfilled' && marketsResult.value.markets?.length) {
    openList.innerHTML = marketsResult.value.markets.map(m => {
      const cd = countdown(m.tradingDeadline);
      return `
        <div style="padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer" class="market-row" data-market-id="${m.marketId}">
          <div style="font-size:13.5px;font-weight:600;color:var(--ink);margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${m.question}</div>
          <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted)">
            <span class="${cd.urgent ? 'countdown urgent' : 'countdown'}">${cd.label} left</span>
            <span>·</span>
            <span>${formatUsdc(m.totalPool)} USDC</span>
          </div>
        </div>
      `;
    }).join('') + (marketsResult.value.markets.length === 0 ? '<div class="empty-state" style="padding:30px"><p>No open markets yet.</p></div>' : '');
    openList.querySelectorAll('.market-row').forEach(row => {
      row.addEventListener('click', () => window.chronosRouter('market', { id: row.dataset.marketId }));
    });
  } else {
    openList.innerHTML = '<div class="empty-state" style="padding:30px 0"><p>No open markets found.</p></div>';
  }

  // Render recent resolutions
  const resList = container.querySelector('#recent-resolutions-list');
  if (resolutionsResult.status === 'fulfilled' && resolutionsResult.value.resolutions?.length) {
    resList.innerHTML = resolutionsResult.value.resolutions.map(m => `
      <div style="padding:12px 0;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:10px">
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${m.question}</div>
          <div style="font-size:11px;color:var(--muted)">${formatDate(m.resolvedAt)}</div>
        </div>
        <span class="chip ${outcomeClass(m.outcome)}">${m.outcome}</span>
      </div>
    `).join('');
  } else {
    resList.innerHTML = '<div class="empty-state" style="padding:30px 0"><p>No resolved markets yet.</p></div>';
  }

  // My positions
  if (wallet.connected) {
    const section = container.querySelector('#my-positions-section');
    section.style.display = 'block';
    try {
      const { claimable } = await api.claimable(wallet.account);
      const list = container.querySelector('#my-positions-list');
      if (claimable.length) {
        list.innerHTML = claimable.map(pos => `
          <div style="padding:12px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
            <div style="flex:1;font-size:13px;font-weight:600;color:var(--ink)">${pos.question}</div>
            <span style="font-size:12px;color:var(--success);font-weight:700">${formatUsdc(pos.netPayout)} USDC</span>
            <button class="btn btn-sm" style="background:var(--success-bg);color:var(--success)" data-claim-market="${pos.marketId}" data-market-state="${pos.marketState}">Claim</button>
          </div>
        `).join('');
      } else {
        list.innerHTML = '<p style="font-size:13px;color:var(--muted);padding:8px 0">No claimable positions.</p>';
      }
    } catch {}
  }
}
