// ─── Market detail ───────────────────────────────────────────────────────────
import { api } from '../api.js';
import { wallet } from '../wallet.js';
import { esc, formatUsdc, formatDate, formatDateTime, countdown, poolPercent, statusPill, outcomeTag, splitBar, emptyState, explorerTxUrl, showToast } from '../utils.js';
import { icon, onWallet } from '../ui.js';
import { recordPosition } from '../api2.js';
import { showPositionPlaced } from '../dialogs.js';
import { connectWallet, requireSignIn } from '../login.js';
import { resolveApi, session } from '../session.js';
import { timeAgo } from '../utils.js';

export async function renderMarketDetail(view, { id, trade }) {
  view.innerHTML = `
    <div class="page">
      <div class="page-head" style="margin-bottom:16px">
        <a class="btn btn-quiet btn-sm" href="#markets" style="margin-left:-10px">${icon.back} Markets</a>
      </div>
      <div id="detail"><div class="skeleton" style="height:240px"></div></div>
    </div>`;
  const detail = view.querySelector('#detail');

  const [mRes, eRes] = await Promise.allSettled([api.market(id), api.marketEvidence(id)]);
  const m = mRes.status === 'fulfilled' ? (mRes.value.market || mRes.value) : null;
  const ev = eRes.status === 'fulfilled' ? eRes.value.evidence : null;
  if (!m) { detail.innerHTML = `<div class="card">${emptyState('Market not found', 'It may not exist on-chain yet.')}</div>`; return; }

  const pct = poolPercent(m.yesPool, m.noPool);
  const open = m.state === 'Open', resolved = m.state === 'Resolved', refundable = m.state === 'Refundable';
  const cd = countdown(m.tradingDeadline), rcd = countdown(m.resolutionDeadline);

  detail.innerHTML = `
    <div class="stack">
      <section class="card card-pad">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          ${statusPill(m.state)} ${outcomeTag(m.outcome)} ${m.category ? `<span class="tag tag-outline">${esc(m.category)}</span>` : ''}
          <span class="hint" style="margin:0 0 0 auto">Market #${esc(m.marketId ?? id)}</span>
        </div>
        <h1 style="font-size:24px;line-height:1.3;margin:14px 0 20px;max-width:760px">${esc(m.question)}</h1>
        ${splitBar(pct, true)}
        <p class="hint">${BigInt(m.totalPool || '0') > 0n ? `${formatUsdc(m.yesPool || '0')} USDC on Yes, ${formatUsdc(m.noPool || '0')} USDC on No. ` : 'Nobody has staked yet. '}Volume ${formatUsdc(m.totalPool || '0')} USDC · ${m.stakerCount || 0} staker${(m.stakerCount || 0) === 1 ? '' : 's'} · ${m.tradeCount || 0} position${(m.tradeCount || 0) === 1 ? '' : 's'}.</p>
        <dl class="kv" style="margin-top:20px;padding-top:20px;border-top:1px solid var(--line)">
          <div><dt>Trading closes</dt><dd class="num">${formatDateTime(m.tradingDeadline)} <span class="countdown${open && cd.urgent ? ' urgent' : ''}" style="font-weight:400">${open ? '· ' + esc(cd.label) + ' left' : ''}</span></dd></div>
          <div><dt>Resolution deadline</dt><dd class="num">${formatDateTime(m.resolutionDeadline)} <span class="countdown" style="font-weight:400">${resolved ? '· resolved ' + formatDate(m.resolvedAt) : rcd.ended ? '' : '· ' + esc(rcd.label) + ' left'}</span></dd></div>
        </dl>
      </section>

      <div class="cols">
        <section class="card card-pad">
          <h2 class="section-title">Resolution criteria</h2>
          <p style="margin-top:10px;color:var(--ink-2);line-height:1.65">${esc(m.resolutionCriteria || 'No criteria provided.')}</p>
        </section>
        <section class="card card-pad">
          <h2 class="section-title">${open ? 'Place a position' : resolved ? 'Claim winnings' : refundable ? 'Claim refund' : 'Market closed'}</h2>
          <div id="trade-panel">${tradePanel(m)}</div>
        </section>
      </div>

      <section class="card card-pad" id="resolve-card" hidden aria-live="polite"></section>

      ${evidence(ev)}
    </div>`;

  wireTrade(view, m, !!trade);
  wireResolve(view, m);
}

function tradePanel(m) {
  if (m.state === 'Open') return `
    <div class="seg" role="group" aria-label="Outcome" style="margin-top:14px">
      <button type="button" id="pick-yes" aria-pressed="false">Yes</button>
      <button type="button" id="pick-no" aria-pressed="false">No</button>
    </div>
    <label class="field-label" for="amount">Amount</label>
    <div class="amount"><input class="input" id="amount" type="number" inputmode="decimal" min="0.1" step="0.1" placeholder="0.00" /><span>USDC</span></div>
    <p class="hint">Minimum 0.10 USDC.</p>
    <div id="estimate" class="estimate" hidden></div>
    <button class="btn btn-primary btn-lg btn-block" id="submit" style="margin-top:16px">Connect wallet</button>
    <div id="tx-status" class="tx-status" aria-live="polite"></div>`;
  if (m.state === 'Resolved') return `
    <p style="margin:12px 0 16px;color:var(--ink-2)">This market resolved ${m.outcome === 'YES' ? 'Yes' : 'No'}. Winners are paid automatically. If your payout hasn’t arrived yet, you can claim it yourself.</p>
    <button class="btn btn-primary btn-block" id="claim-win">Claim winnings</button><div id="tx-status" class="tx-status" aria-live="polite"></div>`;
  if (m.state === 'Refundable') return `
    <p style="margin:12px 0 16px;color:var(--ink-2)">The market was cancelled, so every stake is refunded in full and sent back automatically. If yours hasn’t arrived yet, you can claim it yourself.</p>
    <button class="btn btn-primary btn-block" id="claim-refund">Claim refund</button><div id="tx-status" class="tx-status" aria-live="polite"></div>`;
  return `<p style="margin-top:12px;color:var(--muted)">Trading is closed. The oracle will resolve this market after the deadline.</p>`;
}

function evidence(ev) {
  if (!ev || !ev.sources?.length) return '';
  return `
    <section class="card">
      <div class="card-head">
        <h2 class="section-title">Oracle evidence</h2>
        <div style="display:flex;gap:10px;align-items:center">${outcomeTag(ev.proposedOutcome)}${ev.confidence ? `<span class="hint" style="margin:0">${Math.round(ev.confidence * 100)}% confidence</span>` : ''}</div>
      </div>
      ${ev.geminiReasoning ? `<p style="padding:16px 20px;color:var(--ink-2);line-height:1.65;background:var(--bg-subtle)">${esc(ev.geminiReasoning)}</p>` : ''}
      ${ev.sources.map(s => `
        <div class="source">
          <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url.length > 80 ? s.url.slice(0, 80) + '…' : s.url)}</a>
          ${s.excerpt ? `<p>${esc(s.excerpt)}</p>` : ''}
          <div class="meta"><span>${esc(s.credibility || 'unrated')} credibility</span>${s.contentHash ? `<span class="mono">${esc(s.contentHash.slice(0, 10))}…</span>` : ''}</div>
        </div>`).join('')}
    </section>`;
}

function wireTrade(view, m, focusAmount) {
  const $ = (s) => view.querySelector(s);
  const status = $('#tx-status');
  const link = (label, hash) => { const u = explorerTxUrl(hash); return u ? `${label} <a href="${esc(u)}" target="_blank" rel="noopener">View transaction</a>` : label; };

  async function claim(btnSel, fn, doing, done, label) {
    const btn = $(btnSel);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!wallet.connected || !wallet.onRightChain) { await connectWallet(); if (!wallet.connected || !wallet.onRightChain) return; }
      btn.disabled = true; btn.textContent = doing;
      try { const tx = await fn(m.marketId); showToast(done, 'success'); status.innerHTML = link(done + '.', tx); btn.textContent = 'Done'; }
      catch (err) { showToast(`${label} failed: ${err.message}`, 'error'); btn.disabled = false; btn.textContent = label; }
    });
  }
  claim('#claim-win', (id) => wallet.claimWinnings(id), 'Claiming…', 'Winnings claimed', 'Claim winnings');
  claim('#claim-refund', (id) => wallet.claimRefund(id), 'Claiming…', 'Refund claimed', 'Claim refund');

  const yes = $('#pick-yes');
  if (!yes) return;
  const no = $('#pick-no'), amountEl = $('#amount'), submit = $('#submit'), est = $('#estimate');
  const feePct = Number(window.CHRONOS_FEE_PCT || 0);
  let side = null, busy = false;

  const pick = (s) => { side = s; yes.setAttribute('aria-pressed', String(s === 1)); no.setAttribute('aria-pressed', String(s === 2)); refresh(); };
  yes.addEventListener('click', () => pick(1));
  no.addEventListener('click', () => pick(2));
  amountEl.addEventListener('input', refresh);
  if (focusAmount) amountEl.focus();

  function estimate(amount) {
    const yesPool = Number(m.yesPool || 0) / 1e6, noPool = Number(m.noPool || 0) / 1e6;
    const sidePool = side === 1 ? yesPool : noPool;
    const payout = (amount / (sidePool + amount)) * (yesPool + noPool + amount);
    const fee = Math.max(0, payout - amount) * (feePct / 100);
    return { gross: payout, net: payout - fee, fee };
  }

  function refresh() {
    if (busy) return;
    const amount = parseFloat(amountEl.value || '0');
    const ready = side && amount >= 0.1;
    if (ready) {
      const e = estimate(amount);
      est.hidden = false;
      est.innerHTML = `<dl class="kv">
        <div><dt>Estimated payout if ${side === 1 ? 'Yes' : 'No'} wins</dt><dd class="num">${e.net.toFixed(2)} USDC</dd></div>
        <div><dt>Protocol fee (${feePct}% of profit)</dt><dd class="num">${e.fee.toFixed(2)} USDC</dd></div></dl>
        <p class="hint">An estimate based on current pools. It changes as others trade.</p>`;
    } else est.hidden = true;

    submit.disabled = false;
    if (!wallet.connected) submit.textContent = 'Connect wallet';
    else if (!wallet.onRightChain) submit.textContent = `Switch to ${wallet.networkName}`;
    else if (!side) { submit.textContent = 'Choose Yes or No'; submit.disabled = true; }
    else if (!(amount >= 0.1)) { submit.textContent = 'Enter at least 0.10 USDC'; submit.disabled = true; }
    else submit.textContent = `Buy ${side === 1 ? 'Yes' : 'No'} for ${amount} USDC`;
  }

  submit.addEventListener('click', async () => {
    if (!wallet.connected || !wallet.onRightChain) { await connectWallet(); if (!wallet.connected || !wallet.onRightChain) return; }
    const amount = parseFloat(amountEl.value || '0');
    if (!side || !(amount >= 0.1)) return;
    const micro = BigInt(Math.floor(amount * 1e6));
    busy = true; submit.disabled = true; submit.textContent = 'Confirm in your wallet…'; status.textContent = '';
    try {
      if (BigInt(await wallet.allowance()) < micro) {
        const approveTx = await wallet.approveUsdc(micro);
        status.innerHTML = link('USDC approved.', approveTx);
      }
      submit.textContent = 'Submitting position…';
      const tx = await wallet.buyShares(m.marketId, side, micro);
      status.innerHTML = link('Position confirmed on-chain.', tx);
      submit.textContent = 'Position placed';
      // Store it right away (the server re-reads the chain itself) so Overview, My positions and this market's stats update now.
      let saved = null;
      try { saved = await recordPosition(tx); } catch (e) { console.warn('recordPosition:', e.message); }
      const p = saved?.positions?.[0];
      const choice = await showPositionPlaced({ positionId: p?.positionId, marketId: m.marketId, outcome: side === 1 ? 'YES' : 'NO', amount: String(micro), txHash: tx, question: m.question, recorded: !!p });
      window.chronosRouter(choice === 'view' ? 'positions' : 'market', choice === 'view' ? {} : { id: m.marketId });
    } catch (err) {
      showToast(`Transaction failed: ${err.message}`, 'error');
      status.textContent = `Error: ${err.message}`;
      busy = false; refresh();
    }
  });

  onWallet(view, refresh);
  refresh();
}

// ── Resolve panel ────────────────────────────────────────────────────────────
const JOB_TEXT = {
  queued: 'Queued. The oracle will start in a moment.',
  running: 'The oracle is researching the result and checking sources.',
  deferred: 'The official result is not confirmed yet.',
  unresolved: 'The oracle could not verify the result with enough confidence yet.',
  failed: 'The last attempt hit an error and will be retried.',
  gave_up: 'Automatic attempts are finished. The market refunds at its resolution deadline.',
};

async function wireResolve(view, m) {
  const card = view.querySelector('#resolve-card');
  if (!card || (m.state !== 'Open' && m.state !== 'TradingClosed')) return;
  let timer, polls = 0, stopped = false;
  const alive = () => !stopped && view.isConnected;

  async function load() {
    try { return await resolveApi.status(m.marketId); } catch { return null; }
  }

  function paint(info, note) {
    if (!info) { card.hidden = true; return; }
    if (['Resolved', 'Refundable', 'Settled'].includes(info.state)) { card.hidden = true; return; }
    const job = info.job;
    const working = job && (job.status === 'queued' || job.status === 'running');
    card.hidden = false;

    let body, button = '';
    if (!info.eligible) {
      body = `<div class="resolve-state"><span class="status status-closed"><i></i></span><span>${info.reason ? esc(info.reason) + '. ' : ''}The oracle checks automatically${info.dueAt ? ` from <strong>${esc(new Date(info.dueAt).toUTCString())}</strong>` : ' once the event is over'}. This button unlocks then.</span></div>`;
    } else if (working) {
      body = `<div class="resolve-state"><span class="spin" aria-hidden="true"></span><span>${esc(JOB_TEXT[job.status])}</span></div>`;
    } else {
      const last = job && JOB_TEXT[job.status] ? `${JOB_TEXT[job.status]}${job.reason ? ' ' + esc(job.reason) : ''} Last checked ${timeAgo(job.updatedAt)}.` : '';
      const next = info.nextAttemptAt ? ` The oracle will try again automatically ${new Date(info.nextAttemptAt) > new Date() ? 'around ' + esc(new Date(info.nextAttemptAt).toUTCString()) : 'shortly'}.` : '';
      body = `<p class="resolve-state" style="margin:0">${info.pastDeadline ? 'The resolution deadline has passed. If no verified result exists, the market is cancelled and everyone is refunded.' : 'The event is over. The oracle researches the result, cites its sources and settles the market on-chain. A market can only be resolved once.'}</p>
        ${last || next ? `<p class="hint" style="margin-top:10px">${last}${next}</p>` : ''}`;
      button = `<button class="btn btn-primary" id="resolve-btn" style="margin-top:16px">${info.pastDeadline ? 'Settle market' : 'Resolve with oracle'}</button>
        <span class="hint" style="margin-left:10px">${session.user ? '' : 'You will be asked to sign in first.'}</span>`;
    }
    card.innerHTML = `<h2 class="section-title">Resolution</h2><div class="resolve-box" style="margin-top:12px">${body}${note ? `<p class="hint" style="margin-top:10px;font-weight:500;color:var(--ink)">${esc(note)}</p>` : ''}${button}</div>`;
    card.querySelector('#resolve-btn')?.addEventListener('click', start);
  }

  async function poll() {
    if (!alive()) return;
    const info = await load();
    if (!alive()) return;
    paint(info);
    if (!info) return;
    if (['Resolved', 'Refundable', 'Settled'].includes(info.state)) { showToast(info.state === 'Resolved' ? `Resolved: ${info.outcome}` : 'Market settled', 'success'); window.chronosRouter('market', { id: m.marketId }); return; }
    const job = info.job;
    if (job && (job.status === 'queued' || job.status === 'running') && ++polls < 75) timer = setTimeout(poll, 4000);
  }

  async function start() {
    const btn = card.querySelector('#resolve-btn');
    if (!(await requireSignIn())) return;
    btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const r = await resolveApi.start(m.marketId);
      if (r.status === 'already_final') { window.chronosRouter('market', { id: m.marketId }); return; }
      polls = 0; clearTimeout(timer); timer = setTimeout(poll, 1500);
      paint({ ...(await load()), job: { status: 'queued' } }, r.message);
    } catch (err) {
      if (err.status === 401) { showToast('Please sign in to resolve.', 'error'); }
      else paint(await load(), err.message);
      if (err.status !== 409 && err.status !== 429) showToast(err.message, 'error');
    }
  }

  paint(await load());
  const info = card.hidden ? null : await load();
  if (info?.job && (info.job.status === 'queued' || info.job.status === 'running')) timer = setTimeout(poll, 3000);
  const stop = new MutationObserver(() => { if (!view.isConnected) { stopped = true; clearTimeout(timer); stop.disconnect(); } });
  stop.observe(document.body, { childList: true, subtree: true });
}
