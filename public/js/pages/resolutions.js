// ─── Resolution Archive Page ─────────────────────────────────────────────────
import { api } from '../api.js';
import { formatDate, formatUsdc, outcomeClass, stateClass, buildPagination } from '../utils.js';

let _state = { outcome: 'all', search: '', page: 1 };

export async function renderResolutions(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Resolution Archive</h1>
      <p class="page-subtitle">All resolved, cancelled, and disputed markets with oracle evidence</p>
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;align-items:center">
      <div class="search-input-wrap" style="flex:1;min-width:200px;max-width:340px">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="input search-input" id="res-search" placeholder="Search archive…" value="${_state.search}" />
      </div>
      <select class="select" id="res-outcome-filter">
        <option value="all">All Outcomes</option>
        <option value="YES">YES</option>
        <option value="NO">NO</option>
        <option value="UNRESOLVED">Refunded</option>
      </select>
    </div>

    <div class="card">
      <div id="resolutions-list"></div>
      <div id="resolutions-pagination" style="padding:12px 20px;display:flex;gap:6px"></div>
    </div>
  `;

  container.querySelector('#res-search').addEventListener('input', (e) => {
    clearTimeout(window._resSearchTimeout);
    window._resSearchTimeout = setTimeout(() => { _state.search = e.target.value; _state.page = 1; loadResolutions(); }, 400);
  });
  container.querySelector('#res-outcome-filter').addEventListener('change', (e) => { _state.outcome = e.target.value; _state.page = 1; loadResolutions(); });

  async function loadResolutions() {
    const list = container.querySelector('#resolutions-list');
    list.style.opacity = '0.5';
    try {
      const { resolutions = [], total = 0 } = await api.resolutions({ ..._state, limit: 20 });
      list.style.opacity = '1';

      if (!resolutions.length) {
        list.innerHTML = `<div class="empty-state" style="padding:50px"><h3>No resolved markets yet</h3><p>Markets appear here once the oracle resolves them.</p></div>`;
        return;
      }

      list.innerHTML = resolutions.map(m => `
        <div style="padding:18px 20px;border-bottom:1px solid var(--border);cursor:pointer" class="resolution-row" data-market-id="${m.marketId}">
          <div style="display:flex;align-items:flex-start;gap:12px">
            <div style="flex:1">
              <div style="font-size:14px;font-weight:600;color:var(--ink);margin-bottom:6px;line-height:1.4">${m.question}</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px">
                <span class="chip ${stateClass(m.state)}">${m.state}</span>
                ${m.outcome && m.outcome !== 'UNRESOLVED' ? `<span class="chip ${outcomeClass(m.outcome)}">${m.outcome}</span>` : ''}
                ${m.category ? `<span class="chip chip-category">${m.category}</span>` : ''}
              </div>
              <div style="font-size:11.5px;color:var(--muted)">
                Resolved ${formatDate(m.resolvedAt)} · ${formatUsdc(m.totalPool || '0')} USDC staked
                ${m.evidenceSummary ? ` · <span style="color:var(--accent)">Evidence available</span>` : ''}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              ${m.evidenceSummary?.confidence ? `
                <div style="font-size:11px;color:var(--muted)">Confidence</div>
                <div style="font-size:18px;font-weight:700;font-family:var(--font-display);color:var(--ink)">${Math.round(m.evidenceSummary.confidence * 100)}%</div>
              ` : ''}
            </div>
          </div>
        </div>
      `).join('');

      list.querySelectorAll('.resolution-row').forEach(row => {
        row.addEventListener('click', () => window.chronosRouter('market', { id: row.dataset.marketId }));
      });

      buildPagination(container.querySelector('#resolutions-pagination'), total, _state.page, 20, (p) => { _state.page = p; loadResolutions(); });
    } catch (err) {
      list.style.opacity = '1';
      list.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">${err.message}</p></div>`;
    }
  }

  loadResolutions();
}
