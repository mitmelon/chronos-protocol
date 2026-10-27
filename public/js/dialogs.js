// ─── Big confirmation dialog shown when a position is placed ─────────────────
import { esc, formatUsdc, explorerTxUrl } from './utils.js';

/** Resolves 'view' (go to My positions) or 'close'. */
export function showPositionPlaced({ positionId, marketId, outcome, amount, txHash, question, recorded }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    const url = explorerTxUrl(txHash);
    root.innerHTML = `
      <div class="modal big-ok" role="alertdialog" aria-modal="true" aria-labelledby="ok-title" aria-describedby="ok-id">
        <div class="ok-badge" aria-hidden="true"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
        <h2 id="ok-title">Position placed</h2>
        <p class="ok-sub">${recorded ? 'It is confirmed on-chain and saved to your positions.' : 'It is confirmed on-chain. It will appear in My positions within a minute.'}</p>
        ${positionId ? `<div class="ok-id"><span class="k">Position ID</span><span id="ok-id" class="mono">${esc(positionId)}</span><button class="btn btn-secondary btn-sm" id="ok-copy" type="button">Copy</button></div>` : ''}
        <dl class="kv ok-kv">
          <div><dt>Market</dt><dd>#${esc(marketId)}${question ? ` · ${esc(question.length > 90 ? question.slice(0, 90) + '…' : question)}` : ''}</dd></div>
          <div><dt>You backed</dt><dd><span class="tag ${outcome === 'YES' ? 'tag-yes' : 'tag-no'}">${outcome === 'YES' ? 'Yes' : 'No'}</span></dd></div>
          <div><dt>Amount</dt><dd class="num">${formatUsdc(amount)} USDC</dd></div>
          ${txHash ? `<div><dt>Transaction</dt><dd class="mono">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener" style="text-decoration:underline">${esc(txHash.slice(0, 10))}…${esc(txHash.slice(-6))}</a>` : esc(txHash.slice(0, 18) + '…')}</dd></div>` : ''}
        </dl>
        <div class="ok-actions"><button class="btn btn-primary btn-lg" id="ok-view" type="button">View my positions</button><button class="btn btn-secondary btn-lg" id="ok-close" type="button">Close</button></div>
      </div>`;
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';
    const done = (r) => { document.removeEventListener('keydown', onKey, true); root.remove(); document.body.style.overflow = ''; prev?.focus?.({ preventScroll: true }); resolve(r); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done('close'); } };
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('pointerdown', (e) => { if (e.target === root) done('close'); });
    root.querySelector('#ok-view').addEventListener('click', () => done('view'));
    root.querySelector('#ok-close').addEventListener('click', () => done('close'));
    root.querySelector('#ok-copy')?.addEventListener('click', (e) => { navigator.clipboard?.writeText(positionId); e.target.textContent = 'Copied'; });
    root.querySelector('#ok-view').focus({ preventScroll: true });
  });
}
