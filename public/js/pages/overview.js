// ─── Overview ────────────────────────────────────────────────────────────────
import { api } from '../api.js';
import { wallet } from '../wallet.js';
import { esc, formatUsdc, formatDate, countdown, outcomeTag, emptyState, skeletonRows } from '../utils.js';
import { onWallet, wireClaimButtons } from '../ui.js';

export async function renderOverview(view) {
  view.innerHTML = `
    <div class="page">
      <div class="page-head"><div><h1>Overview</h1><p>Protocol activity, open markets and your payouts.</p></div></div>
      <div class="stack">
        <div class="metrics" id="metrics">
          ${[0, 1, 2, 3].map(() => `<div class="metric"><div class="skeleton" style="height:14px;width:90px"></div><div class="skeleton" style="height:28px;width:70px;margin-top:10px"></div></div>`).join('')}
        </div>

        <div id="claim-section" hidden></div>

        <div class="cols">
          <section class="card">
            <div class="card-head"><h2 class="section-title">Open markets</h2><a class="btn btn-quiet btn-sm" href="#markets">View all</a></div>
            <div id="open-list">${skeletonRows(3)}</div>
          </section>
          <section class="card">
            <div class="card-head"><h2 class="section-title">Recent resolutions</h2><a class="btn btn-quiet btn-sm" href="#resolutions">View all</a></div>
            <div id="res-list">${skeletonRows(3)}</div>
          </section>
        </div>
      </div>
    </div>`;

  const $ = (s) => view.querySelector(s);

  const [protocol, markets, resolutions] = await Promise.allSettled([
    api.protocolStatus(),
    api.markets({ state: 'Open', limit: 5, sort: 'deadline' }),
    api.resolutions({ limit: 5 }),
  ]);

  if (protocol.status === 'fulfilled') {
    const p = protocol.value;
    $('#metrics').innerHTML = `
      <div class="metric"><div class="k">Open markets</div><div class="v">${esc(p.openMarkets ?? '—')}</div><div class="n">Accepting positions</div></div>
      <div class="metric"><div class="k">Resolved markets</div><div class="v">${esc(p.resolvedMarkets ?? '—')}</div><div class="n">Settled on-chain</div></div>
      <div class="metric"><div class="k">Total volume</div><div class="v">${formatUsdc(p.totalVolumeUsdc, 0)} <small>USDC</small></div><div class="n">Staked all-time</div></div>
      <div class="metric"><div class="k">Protocol fee</div><div class="v">${(p.feeBps / 100).toFixed(1)}%</div><div class="n">On winners’ profit only</div></div>`;
  } else {
    $('#metrics').innerHTML = `<div class="metric" style="grid-column:1/-1"><div class="n">Protocol data is unavailable. The contract may not be deployed yet.</div></div>`;
  }

  const open = markets.status === 'fulfilled' ? markets.value.markets || [] : [];
  $('#open-list').innerHTML = open.length
    ? `<ul class="rows">${open.map(m => {
        const cd = countdown(m.tradingDeadline);
        return `<li><a class="row" href="#market/${esc(m.marketId)}">
          <div class="row-main">
            <div class="row-title">${esc(m.question)}</div>
            <div class="row-sub"><span class="countdown${cd.urgent ? ' urgent' : ''}">${esc(cd.label)} left</span> &nbsp;${formatUsdc(m.totalPool)} USDC staked</div>
          </div></a></li>`;
      }).join('')}</ul>`
    : emptyState('No open markets', 'New markets appear when the oracle publishes them.');

  const done = resolutions.status === 'fulfilled' ? resolutions.value.resolutions || [] : [];
  $('#res-list').innerHTML = done.length
    ? `<ul class="rows">${done.map(m => `<li><a class="row" href="#market/${esc(m.marketId)}">
          <div class="row-main"><div class="row-title">${esc(m.question)}</div><div class="row-sub">${formatDate(m.resolvedAt)}</div></div>
          ${outcomeTag(m.outcome)}</a></li>`).join('')}</ul>`
    : emptyState('Nothing resolved yet', 'Resolved markets and their outcomes show up here.');

  // Claimable payouts (only when a wallet is connected)
  async function loadClaims() {
    const sec = $('#claim-section');
    if (!sec) return;
    if (!wallet.connected) { sec.hidden = true; return; }
    try {
      const { claimable = [] } = await api.claimable(wallet.account);
      if (!claimable.length) { sec.hidden = true; return; }
      const total = claimable.reduce((s, p) => s + BigInt(p.netPayout || '0'), 0n).toString();
      sec.hidden = false;
      sec.innerHTML = `
        <div class="notice">
          <div class="notice-head">
            <div><div class="section-title">${claimable.length} payout${claimable.length > 1 ? 's' : ''} ready to claim</div>
            <div class="row-sub">${formatUsdc(total)} USDC in total</div></div>
          </div>
          <ul class="rows" style="margin-top:8px">${claimable.map(p => `
            <li class="row">
              <div class="row-main"><div class="row-title">${esc(p.question)}</div></div>
              <span class="num" style="font-weight:600">${formatUsdc(p.netPayout)} USDC</span>
              <button class="btn btn-primary btn-sm" data-claim="${esc(p.marketId)}" data-state="${esc(p.marketState)}">Claim</button>
            </li>`).join('')}</ul>
        </div>`;
      wireClaimButtons(sec);
    } catch { sec.hidden = true; }
  }
  loadClaims();
  onWallet(view, loadClaims);
}
