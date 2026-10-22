// ─── My Positions Page ──────────────────────────────────────────────────────
import { api } from '../api.js';
import { formatUsdc, formatDate, stateClass, outcomeClass, buildPagination } from '../utils.js';
import { wallet } from '../wallet.js';
import { showToast } from '../utils.js';

export async function renderPositions(container) {
  const renderNotConnected = () => {
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">My Positions</h1>
        <p class="page-subtitle">Stakes, outcomes, and claimable payouts</p>
      </div>
      <div class="empty-state" style="padding:80px 20px">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <h3>Connect your wallet</h3>
        <p>Connect your wallet to see your prediction market positions on Arc.</p>
        <button class="btn btn-primary" id="connect-wallet-btn">Connect Wallet</button>
      </div>
    `;
    container.querySelector('#connect-wallet-btn').addEventListener('click', () => wallet.connect());
    wallet.onUpdate(() => { if (wallet.connected) renderPositions(container); });
  };

  if (!wallet.connected) { renderNotConnected(); return; }

  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">My Positions</h1>
      <p class="page-subtitle">${wallet.account ? wallet.account.slice(0,6) + '…' + wallet.account.slice(-4) : ''}</p>
    </div>

    <!-- Claimable summary -->
    <div id="claimable-section" style="margin-bottom:20px"></div>

    <!-- Positions table -->
    <div class="card">
      <div style="padding:18px 20px;border-bottom:1px solid var(--border);font-weight:600;color:var(--ink)">All Positions</div>
      <div id="positions-table-wrap">
        <div class="empty-state"><div class="skeleton" style="width:100%;height:60px;border-radius:var(--r-lg)"></div></div>
      </div>
      <div id="positions-pagination" style="padding:12px 20px;display:flex;gap:6px"></div>
    </div>
  `;

  // Load claimable
  try {
    const { claimable } = await api.claimable(wallet.account);
    const sec = container.querySelector('#claimable-section');
    if (claimable.length) {
      sec.innerHTML = `
        <div class="card" style="padding:20px;border:1px solid rgba(74,222,128,0.25)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div>
              <div style="font-weight:700;color:var(--success);font-size:14px">You have ${claimable.length} claimable payout${claimable.length > 1 ? 's' : ''}</div>
              <div style="font-size:12px;color:var(--muted);margin-top:2px">
                Total: ${formatUsdc(claimable.reduce((sum, p) => sum + BigInt(p.netPayout || '0'), 0n).toString())} USDC
              </div>
            </div>
          </div>
          ${claimable.map(pos => `
            <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--border)">
              <div style="flex:1;font-size:13px;color:var(--ink)">${pos.question}</div>
              <span style="font-size:12px;font-weight:700;color:var(--success)">${formatUsdc(pos.netPayout)} USDC</span>
              <button class="btn btn-sm" style="background:var(--success-bg);color:var(--success)" data-claim="${pos.marketId}" data-state="${pos.marketState}">Claim</button>
            </div>
          `).join('')}
        </div>
      `;

      sec.querySelectorAll('[data-claim]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const marketId = btn.dataset.claim;
          const state = btn.dataset.state;
          btn.disabled = true; btn.textContent = 'Claiming…';
          try {
            let tx;
            if (state === 'Resolved') tx = await wallet.claimWinnings(marketId);
            else tx = await wallet.claimRefund(marketId);
            showToast('Claimed successfully!', 'success');
            btn.textContent = 'Claimed';
          } catch (err) {
            showToast('Claim failed: ' + err.message, 'error');
            btn.disabled = false; btn.textContent = 'Claim';
          }
        });
      });
    }
  } catch {}

  // Load positions table
  let page = 1;
  const limit = 20;

  async function loadPositions() {
    const wrap = container.querySelector('#positions-table-wrap');
    wrap.style.opacity = '0.5';
    try {
      const { positions = [], total = 0 } = await api.positions(wallet.account, { page, limit });
      wrap.style.opacity = '1';

      if (!positions.length) {
        wrap.innerHTML = `<div class="empty-state" style="padding:40px"><h3>No positions yet</h3><p>Browse markets and place your first prediction.</p><button class="btn btn-primary btn-sm" data-page="markets">Explore Markets</button></div>`;
        wrap.querySelector('[data-page]')?.addEventListener('click', () => window.chronosRouter('markets'));
        return;
      }

      wrap.innerHTML = `
        <div class="table-wrap" style="border:none;border-radius:0">
          <table>
            <thead><tr>
              <th>Market</th>
              <th>YES Position</th>
              <th>NO Position</th>
              <th>State</th>
              <th>Outcome</th>
              <th>Status</th>
            </tr></thead>
            <tbody>
              ${positions.map(pos => `
                <tr style="cursor:pointer" data-market-id="${pos.marketId}">
                  <td style="max-width:280px">
                    <div style="font-weight:600;color:var(--ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px">${pos.question || 'Market #' + pos.marketId}</div>
                  </td>
                  <td style="font-variant-numeric:tabular-nums;color:${BigInt(pos.yesShares||'0')>0n?'var(--yes)':'var(--subtle)'}">
                    ${BigInt(pos.yesShares||'0')>0n ? formatUsdc(pos.yesShares) + ' USDC' : '—'}
                  </td>
                  <td style="font-variant-numeric:tabular-nums;color:${BigInt(pos.noShares||'0')>0n?'var(--no)':'var(--subtle)'}">
                    ${BigInt(pos.noShares||'0')>0n ? formatUsdc(pos.noShares) + ' USDC' : '—'}
                  </td>
                  <td><span class="chip ${stateClass(pos.marketState || pos.state)}">${pos.marketState || pos.state || '—'}</span></td>
                  <td>${pos.outcome && pos.outcome !== 'UNRESOLVED' ? `<span class="chip ${outcomeClass(pos.outcome)}">${pos.outcome}</span>` : '<span style="color:var(--subtle)">—</span>'}</td>
                  <td>${pos.claimed ? '<span style="color:var(--muted);font-size:12px">Claimed</span>' : '<span style="color:var(--accent);font-size:12px">Active</span>'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      wrap.querySelectorAll('[data-market-id]').forEach(row => {
        row.addEventListener('click', () => window.chronosRouter('market', { id: row.dataset.marketId }));
      });

      buildPagination(container.querySelector('#positions-pagination'), total, page, limit, (p) => { page = p; loadPositions(); });
    } catch (err) {
      wrap.style.opacity = '1';
      wrap.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">${err.message}</p></div>`;
    }
  }

  loadPositions();
}
