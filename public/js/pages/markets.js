// ─── Markets ─────────────────────────────────────────────────────────────────
import { api } from '../api.js';
import { esc, formatUsdc, formatDate, countdown, poolPercent, statusPill, splitBar, emptyState, buildPagination } from '../utils.js';
import { icon } from '../ui.js';

const DEFAULTS = { state: 'all', sort: 'newest', search: '', page: 1 };
let _state = { ...DEFAULTS };

const STATES = [['all', 'All states'], ['Open', 'Open'], ['TradingClosed', 'Awaiting oracle'], ['Resolved', 'Resolved'], ['Refundable', 'Refundable']];
const SORTS = [['newest', 'Newest'], ['deadline', 'Soonest deadline'], ['staked', 'Most staked']];
const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('');

export async function renderMarkets(view, params = {}) {
  if (params.reset) _state = { ...DEFAULTS };

  view.innerHTML = `
    <div class="page">
      <div class="page-head"><div><h1>Markets</h1><p>Browse open and settled prediction markets.</p></div></div>

      <div class="toolbar">
        <div class="search">${icon.search}<input class="input" id="q" type="search" placeholder="Search markets" aria-label="Search markets" value="${esc(_state.search)}" /></div>
        <select id="f-state" aria-label="Filter by state">${opts(STATES, _state.state)}</select>
        <select id="f-sort" aria-label="Sort markets">${opts(SORTS, _state.sort)}</select>
      </div>

      <div class="card">
        <div class="table-wrap" id="table-wrap"></div>
        <div class="pager" id="pager" hidden></div>
      </div>
    </div>`;

  const $ = (s) => view.querySelector(s);
  const wrap = $('#table-wrap');

  let timer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { _state.search = e.target.value.trim(); _state.page = 1; load(); }, 350);
  });
  $('#f-state').addEventListener('change', (e) => { _state.state = e.target.value; _state.page = 1; load(); });
  $('#f-sort').addEventListener('change', (e) => { _state.sort = e.target.value; _state.page = 1; load(); });

  wrap.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) window.chronosRouter('market', { id: tr.dataset.id });
  });

  let req = 0;
  async function load() {
    const mine = ++req;
    wrap.classList.add('loading');
    try {
      const data = await api.markets({ ..._state, limit: 15 });
      if (mine === req) draw(data);
    } catch (err) {
      if (mine === req) wrap.innerHTML = emptyState('Could not load markets', err.message);
    } finally { if (mine === req) wrap.classList.remove('loading'); }
  }

  function draw({ markets = [], total = 0, page = 1, limit = 15 }) {
    if (!markets.length) {
      wrap.innerHTML = emptyState('No markets found', 'Try a different search or filter.');
      $('#pager').hidden = true;
      return;
    }
    wrap.innerHTML = `
      <table class="table">
        <thead><tr><th>Market</th><th>Status</th><th>Prediction</th><th class="r">Volume</th><th class="r">Trading closes</th></tr></thead>
        <tbody>${markets.map(m => {
          const cd = countdown(m.tradingDeadline);
          const open = m.state === 'Open';
          return `<tr data-id="${esc(m.marketId)}">
            <td><a class="cell-title" href="#market/${esc(m.marketId)}" style="display:block">${esc(m.question)}</a>
                ${m.category ? `<span class="tag tag-outline" style="margin-top:6px">${esc(m.category)}</span>` : ''}</td>
            <td>${statusPill(m.state)}</td>
            <td style="min-width:150px">${splitBar(poolPercent(m.yesPool, m.noPool))}</td>
            <td class="r num">${formatUsdc(m.totalPool || '0')} USDC</td>
            <td class="r num"><span class="countdown${open && cd.urgent ? ' urgent' : ''}">${open ? esc(cd.label) : formatDate(m.tradingDeadline)}</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    buildPagination($('#pager'), total, page, limit, (p) => { _state.page = p; load(); });
  }

  wrap.innerHTML = `<div style="padding:12px 20px">${Array.from({ length: 5 }, () => '<div class="skeleton" style="height:44px;margin:8px 0"></div>').join('')}</div>`;
  load();
}
