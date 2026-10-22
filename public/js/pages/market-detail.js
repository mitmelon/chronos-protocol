// ─── Market Detail Page ──────────────────────────────────────────────────────
import { api } from '../api.js';
import { formatUsdc, formatDate, formatDateTime, stateClass, outcomeClass, countdown, poolPercent, shortAddr, explorerTxUrl } from '../utils.js';
import { wallet } from '../wallet.js';
import { showToast } from '../utils.js';

export async function renderMarketDetail(container, { id }) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
      <button class="btn btn-sm btn-ghost" id="back-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Markets
      </button>
      <span style="font-size:12px;color:var(--subtle)">Market #${id}</span>
    </div>
    <div id="market-detail-inner">
      <div class="empty-state"><div class="skeleton" style="width:100%;height:200px;border-radius:var(--r-xl)"></div></div>
    </div>
  `;

  container.querySelector('#back-btn').addEventListener('click', () => window.chronosRouter('markets'));

  try {
    const [marketData, evidenceData] = await Promise.allSettled([
      api.market(id),
      api.marketEvidence(id),
    ]);

    const m = marketData.status === 'fulfilled' ? (marketData.value.market || marketData.value) : null;
    const ev = evidenceData.status === 'fulfilled' ? evidenceData.value.evidence : null;

    if (!m) {
      container.querySelector('#market-detail-inner').innerHTML = `<div class="empty-state"><h3>Market not found</h3><p>This market may not exist on-chain yet.</p></div>`;
      return;
    }

    const pct = poolPercent(m.yesPool || '0', m.noPool || '0');
    const cd = countdown(m.tradingDeadline);
    const resCD = countdown(m.resolutionDeadline);
    const isOpen = m.state === 'Open';
    const isResolved = m.state === 'Resolved';
    const isRefundable = m.state === 'Refundable';

    container.querySelector('#market-detail-inner').innerHTML = `
      <!-- Header -->
      <div class="card" style="padding:24px;margin-bottom:16px">
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;align-items:center">
          <span class="chip ${stateClass(m.state)}">${m.state === 'TradingClosed' ? 'Awaiting Oracle' : m.state}</span>
          ${m.outcome && m.outcome !== 'UNRESOLVED' ? `<span class="chip ${outcomeClass(m.outcome)}">${m.outcome}</span>` : ''}
          ${m.category ? `<span class="chip chip-category">${m.category}</span>` : ''}
        </div>

        <h2 style="font-family:var(--font-display);font-size:20px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);margin:0 0 16px;line-height:1.4">${m.question}</h2>

        <!-- Pool bar -->
        <div class="pool-bar-wrap" style="margin-bottom:16px">
          <div class="pool-bar-labels">
            <span class="pool-bar-label-yes">YES ${pct.yes}% · ${formatUsdc(m.yesPool || '0')} USDC</span>
            <span style="font-size:11px;color:var(--muted)">${formatUsdc(m.totalPool || '0')} total</span>
            <span class="pool-bar-label-no">${formatUsdc(m.noPool || '0')} USDC · ${pct.no}% NO</span>
          </div>
          <div class="pool-bar-track" style="height:10px">
            <div class="pool-bar-yes" style="width:${pct.yes}%"></div>
            <div class="pool-bar-no" style="flex:1"></div>
          </div>
        </div>

        <!-- Deadlines -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="card-inner">
            <div class="stat-label">Trading Deadline</div>
            <div style="font-size:14px;font-weight:600;color:var(--ink)">${formatDateTime(m.tradingDeadline)}</div>
            <div class="${isOpen && cd.urgent ? 'countdown urgent' : 'countdown'}" style="margin-top:3px">${isOpen ? cd.label + ' remaining' : 'Closed'}</div>
          </div>
          <div class="card-inner">
            <div class="stat-label">Resolution Deadline</div>
            <div style="font-size:14px;font-weight:600;color:var(--ink)">${formatDateTime(m.resolutionDeadline)}</div>
            <div class="countdown" style="margin-top:3px">${isResolved ? 'Resolved ' + formatDate(m.resolvedAt) : resCD.label + ' remaining'}</div>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <!-- Resolution criteria -->
        <div class="card" style="padding:20px">
          <div style="font-weight:600;color:var(--ink);margin-bottom:12px;font-size:13.5px">Resolution Criteria</div>
          <p style="font-size:13px;color:var(--ink-2);line-height:1.6;margin:0">${m.resolutionCriteria || '—'}</p>
        </div>

        <!-- Trade panel -->
        <div class="card" style="padding:20px">
          <div style="font-weight:600;color:var(--ink);margin-bottom:14px;font-size:13.5px">
            ${isOpen ? 'Place a Position' : isResolved ? 'Claim Winnings' : isRefundable ? 'Claim Refund' : 'Market Closed'}
          </div>
          <div id="trade-panel">
            ${renderTradePanel(m)}
          </div>
        </div>
      </div>

      <!-- Evidence -->
      ${ev ? renderEvidence(ev) : ''}
    `;

    // Wire trade panel
    wireTrade(container, m);

  } catch (err) {
    container.querySelector('#market-detail-inner').innerHTML = `<div class="empty-state"><h3>Failed to load market</h3><p style="color:var(--danger)">${err.message}</p></div>`;
  }
}

function renderTradePanel(m) {
  if (m.state === 'Open') {
    return `
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button class="btn btn-yes" style="flex:1" id="select-yes">YES</button>
        <button class="btn btn-no" style="flex:1" id="select-no">NO</button>
      </div>
      <input class="input input-amount" type="number" id="trade-amount" placeholder="0.00" min="0" step="1" />
      <div style="font-size:11px;color:var(--muted);margin:6px 0 14px">USDC — minimum 1.00</div>
      <div id="trade-preview" style="margin-bottom:14px"></div>
      <button class="btn btn-primary btn-full" id="trade-submit" disabled>
        Connect Wallet to Trade
      </button>
      <div id="trade-status" style="margin-top:10px;font-size:12px;color:var(--muted)"></div>
    `;
  }
  if (m.state === 'Resolved') {
    const isYes = m.outcome === 'YES';
    return `
      <div style="text-align:center;padding:12px 0;margin-bottom:14px">
        <span class="chip ${outcomeClass(m.outcome)}" style="font-size:16px;padding:8px 20px">${m.outcome}</span>
        <p style="font-size:13px;color:var(--muted);margin:10px 0 0">This market resolved ${m.outcome}.</p>
      </div>
      <button class="btn btn-primary btn-full" id="claim-winnings-btn">Claim Winnings</button>
      <div id="trade-status" style="margin-top:10px;font-size:12px;color:var(--muted)"></div>
    `;
  }
  if (m.state === 'Refundable') {
    return `
      <div style="text-align:center;padding:12px 0;margin-bottom:14px">
        <p style="font-size:13px;color:var(--warning);margin:0">The oracle did not resolve in time.</p>
        <p style="font-size:12px;color:var(--muted);margin:6px 0 0">Your original stake will be returned in full.</p>
      </div>
      <button class="btn btn-primary btn-full" id="claim-refund-btn">Claim Full Refund</button>
      <div id="trade-status" style="margin-top:10px;font-size:12px;color:var(--muted)"></div>
    `;
  }
  return `<p style="font-size:13px;color:var(--muted);text-align:center;padding:20px 0">This market is settled.</p>`;
}

function renderEvidence(ev) {
  if (!ev || !ev.sources?.length) return '';
  return `
    <div class="card" style="padding:20px;margin-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <span style="font-weight:600;color:var(--ink);font-size:13.5px">Oracle Evidence</span>
        <div style="display:flex;align-items:center;gap:8px">
          ${ev.proposedOutcome ? `<span class="chip ${outcomeClass(ev.proposedOutcome)}">${ev.proposedOutcome}</span>` : ''}
          ${ev.confidence ? `<span style="font-size:11px;color:var(--muted)">Confidence: ${(ev.confidence * 100).toFixed(0)}%</span>` : ''}
        </div>
      </div>
      ${ev.geminiReasoning ? `<p style="font-size:13px;color:var(--ink-2);line-height:1.6;margin:0 0 14px;padding:12px;background:var(--surface-muted);border-radius:var(--r-lg)">${ev.geminiReasoning}</p>` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">
        ${ev.sources.map(s => `
          <div class="source-card">
            <a href="${s.url}" target="_blank" rel="noopener" style="font-size:12.5px;font-weight:600;color:var(--accent);text-decoration:none;word-break:break-word">${s.url.length > 60 ? s.url.slice(0, 60) + '…' : s.url}</a>
            ${s.excerpt ? `<p style="font-size:12px;color:var(--muted);margin:4px 0 0;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${s.excerpt}</p>` : ''}
            <div style="display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--subtle)">
              <span class="source-credibility-${s.credibility || 'low'}">${s.credibility || '—'} credibility</span>
              ${s.contentHash ? `<span class="mono" style="font-size:10px">${s.contentHash.slice(0, 10)}…</span>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function wireTrade(container, m) {
  let selectedOutcome = null;

  const yesBtn = container.querySelector('#select-yes');
  const noBtn = container.querySelector('#select-no');
  const amountEl = container.querySelector('#trade-amount');
  const submitBtn = container.querySelector('#trade-submit');
  const statusEl = container.querySelector('#trade-status');

  if (yesBtn) {
    yesBtn.addEventListener('click', () => { selectedOutcome = 1; yesBtn.style.opacity='1'; noBtn.style.opacity='0.5'; updateSubmit(); });
    noBtn.addEventListener('click', () => { selectedOutcome = 2; noBtn.style.opacity='1'; yesBtn.style.opacity='0.5'; updateSubmit(); });
    if (amountEl) amountEl.addEventListener('input', updateSubmit);
  }

  function updateSubmit() {
    if (!submitBtn) return;
    const amount = parseFloat(amountEl?.value || '0');
    if (!wallet.connected) { submitBtn.textContent = 'Connect Wallet'; submitBtn.disabled = true; return; }
    if (!wallet.onRightChain) { submitBtn.textContent = 'Switch to Arc Testnet'; submitBtn.disabled = false; return; }
    if (!selectedOutcome) { submitBtn.textContent = 'Select YES or NO'; submitBtn.disabled = true; return; }
    if (!amount || amount < 1) { submitBtn.textContent = 'Enter amount (min 1 USDC)'; submitBtn.disabled = true; return; }
    submitBtn.textContent = `Place ${selectedOutcome === 1 ? 'YES' : 'NO'} · ${amount} USDC`;
    submitBtn.disabled = false;
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      if (!wallet.connected) { wallet.connect(); return; }
      if (!wallet.onRightChain) { wallet.switchToArc(); return; }
      if (!selectedOutcome) return;
      const amount = parseFloat(amountEl.value || '0');
      if (amount < 1) return;

      const amountMicro = BigInt(Math.floor(amount * 1e6));
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span style="opacity:0.7">Approving USDC…</span>';
      if (statusEl) statusEl.textContent = '';

      try {
        // Step 1: approve
        const approveTx = await wallet.approveUsdc(amountMicro);
        if (statusEl) statusEl.innerHTML = `Approved. <a href="${wallet.explorerTx(approveTx)}" target="_blank" style="color:var(--accent)">View tx</a>`;

        // Step 2: buy shares
        submitBtn.innerHTML = '<span style="opacity:0.7">Submitting position…</span>';
        const tradeTx = await wallet.buyShares(m.marketId, selectedOutcome, amountMicro);
        showToast('Position placed successfully!', 'success');
        if (statusEl) statusEl.innerHTML = `Position confirmed. <a href="${wallet.explorerTx(tradeTx)}" target="_blank" style="color:var(--accent)">View tx</a>`;
        submitBtn.textContent = 'Position Placed';
      } catch (err) {
        showToast('Transaction failed: ' + err.message, 'error');
        if (statusEl) statusEl.textContent = 'Error: ' + err.message;
        updateSubmit();
      }
    });
  }

  // Claim winnings
  const claimBtn = container.querySelector('#claim-winnings-btn');
  if (claimBtn) {
    claimBtn.addEventListener('click', async () => {
      if (!wallet.connected) { wallet.connect(); return; }
      claimBtn.disabled = true; claimBtn.textContent = 'Claiming…';
      try {
        const tx = await wallet.claimWinnings(m.marketId);
        showToast('Winnings claimed!', 'success');
        container.querySelector('#trade-status').innerHTML = `Claimed. <a href="${wallet.explorerTx(tx)}" target="_blank" style="color:var(--accent)">View tx</a>`;
      } catch (err) {
        showToast('Claim failed: ' + err.message, 'error');
        claimBtn.disabled = false; claimBtn.textContent = 'Claim Winnings';
      }
    });
  }

  // Claim refund
  const refundBtn = container.querySelector('#claim-refund-btn');
  if (refundBtn) {
    refundBtn.addEventListener('click', async () => {
      if (!wallet.connected) { wallet.connect(); return; }
      refundBtn.disabled = true; refundBtn.textContent = 'Claiming Refund…';
      try {
        const tx = await wallet.claimRefund(m.marketId);
        showToast('Refund claimed!', 'success');
        container.querySelector('#trade-status').innerHTML = `Refunded. <a href="${wallet.explorerTx(tx)}" target="_blank" style="color:var(--accent)">View tx</a>`;
      } catch (err) {
        showToast('Refund failed: ' + err.message, 'error');
        refundBtn.disabled = false; refundBtn.textContent = 'Claim Full Refund';
      }
    });
  }

  // Update on wallet changes
  wallet.onUpdate(updateSubmit);
  updateSubmit();
}
