// ─── Market detail ───────────────────────────────────────────────────────────
import { api } from '../api.js';
import { wallet } from '../wallet.js';
import { esc, formatUsdc, formatDate, formatDateTime, countdown, poolPercent, statusPill, outcomeTag, splitBar, emptyState, explorerTxUrl, showToast } from '../utils.js';
import { icon, onWallet } from '../ui.js';

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
        <p class="hint">${formatUsdc(m.yesPool || '0')} USDC on Yes, ${formatUsdc(m.noPool || '0')} USDC on No. ${formatUsdc(m.totalPool || '0')} USDC in total.</p>
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

      ${evidence(ev)}
    </div>`;

  wireTrade(view, m, !!trade);
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
    <p style="margin:12px 0 16px;color:var(--ink-2)">This market resolved ${m.outcome === 'YES' ? 'Yes' : 'No'}. If you held that side, your payout is ready.</p>
    <button class="btn btn-primary btn-block" id="claim-win">Claim winnings</button><div id="tx-status" class="tx-status" aria-live="polite"></div>`;
  if (m.state === 'Refundable') return `
    <p style="margin:12px 0 16px;color:var(--ink-2)">The oracle missed its deadline, so every stake is refunded in full.</p>
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
      if (!wallet.connected) { wallet.connect(); return; }
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
    else if (!wallet.onRightChain) submit.textContent = 'Switch to Arc Testnet';
    else if (!side) { submit.textContent = 'Choose Yes or No'; submit.disabled = true; }
    else if (!(amount >= 0.1)) { submit.textContent = 'Enter at least 0.10 USDC'; submit.disabled = true; }
    else submit.textContent = `Buy ${side === 1 ? 'Yes' : 'No'} for ${amount} USDC`;
  }

  submit.addEventListener('click', async () => {
    if (!wallet.connected) { wallet.connect(); return; }
    if (!wallet.onRightChain) { wallet.switchToArc(); return; }
    const amount = parseFloat(amountEl.value || '0');
    if (!side || !(amount >= 0.1)) return;
    const micro = BigInt(Math.floor(amount * 1e6));
    busy = true; submit.disabled = true; submit.textContent = 'Approving USDC…'; status.textContent = '';
    try {
      const approveTx = await wallet.approveUsdc(micro);
      status.innerHTML = link('USDC approved.', approveTx);
      submit.textContent = 'Submitting position…';
      const tx = await wallet.buyShares(m.marketId, side, micro);
      showToast('Position placed', 'success');
      status.innerHTML = link('Position confirmed.', tx);
      submit.textContent = 'Position placed';
    } catch (err) {
      showToast(`Transaction failed: ${err.message}`, 'error');
      status.textContent = `Error: ${err.message}`;
      busy = false; refresh();
    }
  });

  onWallet(view, refresh);
  refresh();
}
