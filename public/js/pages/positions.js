// ─── My positions ────────────────────────────────────────────────────────────
import { api } from '../api.js';
import { wallet } from '../wallet.js';
import { esc, shortAddr, formatUsdc, statusPill, outcomeTag, emptyState, buildPagination } from '../utils.js';
import { icon, onWallet, wireClaimButtons } from '../ui.js';

export async function renderPositions(view) {
  onWallet(view, () => renderPositions(view));

  if (!wallet.connected) {
    view.innerHTML = `
      <div class="page">
        <div class="page-head"><div><h1>My positions</h1><p>Your stakes, outcomes and claimable payouts.</p></div></div>
        <div class="card"><div class="empty" style="padding:72px 24px">
          ${icon.wallet}
          <h3>Connect your wallet</h3>
          <p>Connect a wallet to see your positions on Arc.</p>
          <button class="btn btn-primary" id="connect">Connect wallet</button>
        </div></div>
      </div>`;
    view.querySelector('#connect').addEventListener('click', () => wallet.connect());
    return;
  }

  view.innerHTML = `
    <div class="page">
      <div class="page-head"><div><h1>My positions</h1><p class="mono" style="font-size:13px">${esc(shortAddr(wallet.account))}</p></div></div>
      <div class="stack">
        <div id="claims" hidden></div>
        <section class="card">
          <div class="card-head"><h2 class="section-title">All positions</h2></div>
          <div class="table-wrap" id="table-wrap"><div style="padding:16px 20px"><div class="skeleton" style="height:44px"></div></div></div>
          <div class="pager" id="pager" hidden></div>
        </section>
      </div>
    </div>`;

  const $ = (s) => view.querySelector(s);
  const account = wallet.account;

  api.claimable(account).then(({ claimable = [] }) => {
    if (!claimable.length || !view.isConnected) return;
    const total = claimable.reduce((s, p) => s + BigInt(p.netPayout || '0'), 0n).toString();
    const sec = $('#claims');
    sec.hidden = false;
    sec.innerHTML = `
      <div class="notice">
        <div class="section-title">${claimable.length} payout${claimable.length > 1 ? 's' : ''} ready to claim</div>
        <div class="row-sub">${formatUsdc(total)} USDC in total</div>
        <ul class="rows" style="margin-top:8px">${claimable.map(p => `
          <li class="row">
            <div class="row-main"><div class="row-title">${esc(p.question)}</div></div>
            <span class="num" style="font-weight:600">${formatUsdc(p.netPayout)} USDC</span>
            <button class="btn btn-primary btn-sm" data-claim="${esc(p.marketId)}" data-state="${esc(p.marketState)}">Claim</button>
          </li>`).join('')}</ul>
      </div>`;
    wireClaimButtons(sec);
  }).catch(() => {});

  let page = 1;
  const limit = 20;
  const wrap = $('#table-wrap');

  wrap.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) window.chronosRouter('market', { id: tr.dataset.id });
  });

  async function load() {
    wrap.classList.add('loading');
    try {
      const { positions = [], total = 0 } = await api.positions(account, { page, limit });
      if (!view.isConnected) return;
      if (!positions.length) {
        wrap.innerHTML = emptyState('No positions yet', 'Browse markets and place your first prediction.', '<a class="btn btn-primary btn-sm" href="#markets">Explore markets</a>');
        $('#pager').hidden = true;
        return;
      }
      const amt = (raw) => { try { return BigInt(raw || '0') > 0n ? `${formatUsdc(raw)} USDC` : '<span style="color:var(--faint)">—</span>'; } catch { return '—'; } };
      wrap.innerHTML = `
        <table class="table">
          <thead><tr><th>Market</th><th class="r">Yes position</th><th class="r">No position</th><th>Status</th><th>Outcome</th><th>Payout</th></tr></thead>
          <tbody>${positions.map(p => `
            <tr data-id="${esc(p.marketId)}">
              <td><a class="cell-title" href="#market/${esc(p.marketId)}" style="display:block">${esc(p.question || 'Market #' + p.marketId)}</a></td>
              <td class="r num">${amt(p.yesShares)}</td>
              <td class="r num">${amt(p.noShares)}</td>
              <td>${statusPill(p.marketState || p.state)}</td>
              <td>${outcomeTag(p.outcome) || '<span style="color:var(--faint)">—</span>'}</td>
              <td>${p.claimed ? '<span class="tag">Claimed</span>' : '<span class="tag tag-outline">Unclaimed</span>'}</td>
            </tr>`).join('')}</tbody>
        </table>`;
      buildPagination($('#pager'), total, page, limit, (p) => { page = p; load(); });
    } catch (err) {
      wrap.innerHTML = emptyState('Could not load positions', err.message);
    } finally { wrap.classList.remove('loading'); }
  }
  load();
}
