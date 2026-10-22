// ─── Explore Markets Page ────────────────────────────────────────────────────
import { api } from '../api.js';
import { formatUsdc, formatDate, stateClass, outcomeClass, countdown, buildPagination, poolPercent } from '../utils.js';

let _state = { state: 'all', category: 'all', sort: 'newest', search: '', page: 1 };

export async function renderMarkets(container, params = {}) {
  if (params.reset) _state = { state: 'all', category: 'all', sort: 'newest', search: '', page: 1 };

  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Explore Markets</h1>
      <p class="page-subtitle">Browse active and resolved prediction markets</p>
    </div>

    <!-- Filters -->
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;align-items:center">
      <div class="search-input-wrap" style="flex:1;min-width:200px;max-width:340px">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="input search-input" id="market-search" placeholder="Search markets…" value="${_state.search}" />
      </div>
      <select class="select" id="market-state-filter">
        <option value="all" ${_state.state==='all'?'selected':''}>All States</option>
        <option value="Open" ${_state.state==='Open'?'selected':''}>Open</option>
        <option value="TradingClosed" ${_state.state==='TradingClosed'?'selected':''}>Awaiting Oracle</option>
        <option value="Resolved" ${_state.state==='Resolved'?'selected':''}>Resolved</option>
        <option value="Refundable" ${_state.state==='Refundable'?'selected':''}>Refundable</option>
      </select>
      <select class="select" id="market-sort">
        <option value="newest" ${_state.sort==='newest'?'selected':''}>Newest</option>
        <option value="deadline" ${_state.sort==='deadline'?'selected':''}>Soonest Deadline</option>
        <option value="staked" ${_state.sort==='staked'?'selected':''}>Most Staked</option>
      </select>
    </div>

    <!-- Grid -->
    <div class="market-grid" id="markets-grid">
      ${[1,2,3,4,5,6].map(() => `
        <div class="market-card" style="pointer-events:none">
          <div class="skeleton" style="height:16px;border-radius:6px;margin-bottom:6px"></div>
          <div class="skeleton" style="height:16px;width:70%;border-radius:6px;margin-bottom:14px"></div>
          <div style="display:flex;gap:6px"><div class="skeleton" style="height:22px;width:50px;border-radius:12px"></div><div class="skeleton" style="height:22px;width:70px;border-radius:12px"></div></div>
        </div>
      `).join('')}
    </div>

    <div id="markets-pagination" style="display:flex;gap:6px;margin-top:20px;flex-wrap:wrap"></div>
    <div id="markets-total" style="font-size:12px;color:var(--subtle);margin-top:8px"></div>
  `;

  // Filters wiring
  const searchEl = container.querySelector('#market-search');
  const stateEl = container.querySelector('#market-state-filter');
  const sortEl = container.querySelector('#market-sort');

  let _searchTimeout;
  searchEl.addEventListener('input', () => {
    clearTimeout(_searchTimeout);
    _searchTimeout = setTimeout(() => { _state.search = searchEl.value; _state.page = 1; loadMarkets(); }, 400);
  });
  stateEl.addEventListener('change', () => { _state.state = stateEl.value; _state.page = 1; loadMarkets(); });
  sortEl.addEventListener('change', () => { _state.sort = sortEl.value; _state.page = 1; loadMarkets(); });

  async function loadMarkets() {
    const grid = container.querySelector('#markets-grid');
    grid.style.opacity = '0.5';
    try {
      const data = await api.markets({ ..._state, limit: 18 });
      renderGrid(data);
    } catch (err) {
      grid.style.opacity = '1';
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p style="color:var(--danger)">${err.message}</p></div>`;
    }
  }

  function renderGrid({ markets = [], total = 0, page = 1, limit = 18 }) {
    const grid = container.querySelector('#markets-grid');
    grid.style.opacity = '1';

    if (!markets.length) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
          <h3>No markets found</h3>
          <p>Try adjusting your filters or check back after the agent runs.</p>
        </div>
      `;
      container.querySelector('#markets-total').textContent = '';
      return;
    }

    grid.innerHTML = markets.map(m => {
      const pct = poolPercent(m.yesPool || '0', m.noPool || '0');
      const cd = countdown(m.tradingDeadline);
      const isOpen = m.state === 'Open';

      return `
        <div class="market-card" data-market-id="${m.marketId}" tabindex="0" role="button" aria-label="${m.question}">
          <!-- Question -->
          <div class="market-question">${m.question}</div>

          <!-- Meta -->
          <div class="market-meta">
            <span class="chip ${stateClass(m.state)}">${m.state === 'TradingClosed' ? 'Awaiting Oracle' : m.state}</span>
            ${m.outcome && m.outcome !== 'UNRESOLVED' ? `<span class="chip ${outcomeClass(m.outcome)}">${m.outcome}</span>` : ''}
            ${m.category ? `<span class="chip chip-category">${m.category}</span>` : ''}
          </div>

          <!-- Pool bar -->
          <div class="pool-bar-wrap">
            <div class="pool-bar-labels">
              <span class="pool-bar-label-yes">YES ${pct.yes}%</span>
              <span style="font-size:11px;color:var(--muted)">${formatUsdc(m.totalPool || '0')} USDC</span>
              <span class="pool-bar-label-no">${pct.no}% NO</span>
            </div>
            <div class="pool-bar-track">
              <div class="pool-bar-yes" style="width:${pct.yes}%"></div>
              <div class="pool-bar-no" style="flex:1"></div>
            </div>
          </div>

          <!-- Footer -->
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--muted)">
            <span class="${isOpen && cd.urgent ? 'countdown urgent' : 'countdown'}">
              ${isOpen ? `${cd.label} to trade` : formatDate(m.tradingDeadline)}
            </span>
            ${isOpen ? `<button class="btn btn-sm btn-primary" style="font-size:12px;padding:5px 12px" data-trade-market="${m.marketId}">Trade</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Wire clicks
    grid.querySelectorAll('.market-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-trade-market]')) return; // handled separately
        window.chronosRouter('market', { id: card.dataset.marketId });
      });
      card.addEventListener('keydown', e => { if (e.key === 'Enter') window.chronosRouter('market', { id: card.dataset.marketId }); });
    });

    grid.querySelectorAll('[data-trade-market]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.chronosRouter('market', { id: btn.dataset.tradeMarket, trade: true });
      });
    });

    // Pagination
    container.querySelector('#markets-total').textContent = `${total} market${total !== 1 ? 's' : ''} found`;
    buildPagination(container.querySelector('#markets-pagination'), total, page, limit, (p) => {
      _state.page = p;
      loadMarkets();
    });
  }

  loadMarkets();
}
