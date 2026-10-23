// ─── Resolutions ─────────────────────────────────────────────────────────────
import { api } from '../api.js';
import { esc, formatDate, formatUsdc, statusPill, outcomeTag, emptyState, buildPagination } from '../utils.js';
import { icon } from '../ui.js';

const DEFAULTS = { outcome: 'all', search: '', page: 1 };
let _state = { ...DEFAULTS };
const OUTCOMES = [['all', 'All outcomes'], ['YES', 'Yes'], ['NO', 'No'], ['UNRESOLVED', 'Refunded']];

export async function renderResolutions(view) {
  view.innerHTML = `
    <div class="page">
      <div class="page-head"><div><h1>Resolutions</h1><p>Every settled market, with the oracle’s evidence.</p></div></div>
      <div class="toolbar">
        <div class="search">${icon.search}<input class="input" id="q" type="search" placeholder="Search resolutions" aria-label="Search resolutions" value="${esc(_state.search)}" /></div>
        <select id="f-outcome" aria-label="Filter by outcome">
          ${OUTCOMES.map(([v, l]) => `<option value="${v}"${v === _state.outcome ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="card">
        <div id="list"></div>
        <div class="pager" id="pager" hidden></div>
      </div>
    </div>`;

  const $ = (s) => view.querySelector(s);
  const list = $('#list');

  let timer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { _state.search = e.target.value.trim(); _state.page = 1; load(); }, 350);
  });
  $('#f-outcome').addEventListener('change', (e) => { _state.outcome = e.target.value; _state.page = 1; load(); });

  let req = 0;
  async function load() {
    const mine = ++req;
    list.classList.add('loading');
    try {
      const { resolutions = [], total = 0 } = await api.resolutions({ ..._state, limit: 20 });
      if (mine !== req) return;
      if (!resolutions.length) {
        list.innerHTML = emptyState('No resolutions found', 'Markets appear here once the oracle resolves them.');
        $('#pager').hidden = true;
        return;
      }
      list.innerHTML = `<ul class="rows">${resolutions.map(m => `
        <li><a class="row" href="#market/${esc(m.marketId)}" style="align-items:flex-start;padding-top:16px;padding-bottom:16px">
          <div class="row-main">
            <div class="row-title" style="font-size:14px">${esc(m.question)}</div>
            <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:8px">
              ${statusPill(m.state)} ${outcomeTag(m.outcome)} ${m.category ? `<span class="tag tag-outline">${esc(m.category)}</span>` : ''}
            </div>
            <div class="row-sub" style="margin-top:8px">Resolved ${formatDate(m.resolvedAt)}. ${formatUsdc(m.totalPool || '0')} USDC staked.${m.evidenceSummary ? ' Evidence available.' : ''}</div>
          </div>
          ${m.evidenceSummary?.confidence ? `<div style="text-align:right;flex-shrink:0"><div class="row-sub" style="margin:0">Confidence</div><div style="font-size:20px;font-weight:600;letter-spacing:-.02em">${Math.round(m.evidenceSummary.confidence * 100)}%</div></div>` : ''}
        </a></li>`).join('')}</ul>`;
      buildPagination($('#pager'), total, _state.page, 20, (p) => { _state.page = p; load(); });
    } catch (err) {
      if (mine === req) list.innerHTML = emptyState('Could not load resolutions', err.message);
    } finally { if (mine === req) list.classList.remove('loading'); }
  }
  load();
}
