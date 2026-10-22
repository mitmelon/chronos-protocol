// ─── Settings Page ───────────────────────────────────────────────────────────
import { api } from '../api.js';
import { shortAddr, explorerAddrUrl } from '../utils.js';
import { wallet } from '../wallet.js';

export async function renderSettings(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Settings</h1>
      <p class="page-subtitle">Protocol configuration and wallet information</p>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <!-- Wallet section -->
      <div class="card" style="padding:22px">
        <div style="font-weight:600;color:var(--ink);margin-bottom:16px;font-size:13.5px">Wallet</div>
        <div id="wallet-info">
          ${wallet.connected ? renderWalletInfo() : '<button class="btn btn-primary btn-full" id="connect-btn">Connect Wallet</button>'}
        </div>
      </div>

      <!-- Protocol settings -->
      <div class="card" style="padding:22px">
        <div style="font-weight:600;color:var(--ink);margin-bottom:16px;font-size:13.5px">Protocol Settings</div>
        <div id="protocol-settings">
          <div class="skeleton" style="height:120px;border-radius:var(--r-lg)"></div>
        </div>
      </div>

      <!-- Network -->
      <div class="card" style="padding:22px">
        <div style="font-weight:600;color:var(--ink);margin-bottom:16px;font-size:13.5px">Network</div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="card-inner">
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Chain</div>
            <div style="font-size:13.5px;font-weight:600;color:var(--ink)">Arc Testnet</div>
            <div style="font-size:11px;font-family:var(--font-mono);color:var(--subtle);margin-top:2px">Chain ID: 5042002</div>
          </div>
          <div class="card-inner">
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px">USDC Address</div>
            <div style="font-size:12px;font-family:var(--font-mono);color:var(--ink-2);word-break:break-all">${window.CHRONOS_USDC || '0x3600000000000000000000000000000000000000'}</div>
          </div>
          <div class="card-inner">
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Contract Address</div>
            <div style="font-size:12px;font-family:var(--font-mono);color:${window.CHRONOS_CONTRACT ? 'var(--ink-2)' : 'var(--subtle)'};word-break:break-all">
              ${window.CHRONOS_CONTRACT || 'Not deployed yet'}
            </div>
            ${window.CHRONOS_CONTRACT && window.CHRONOS_EXPLORER ? `<a href="${window.CHRONOS_EXPLORER}/address/${window.CHRONOS_CONTRACT}" target="_blank" style="font-size:11px;color:var(--accent);margin-top:4px;display:inline-block">View on Explorer</a>` : ''}
          </div>
        </div>
      </div>

      <!-- Resources -->
      <div class="card" style="padding:22px">
        <div style="font-weight:600;color:var(--ink);margin-bottom:16px;font-size:13.5px">Resources</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <a href="https://explorer.testnet.arc.io" target="_blank" class="btn btn-ghost" style="justify-content:flex-start;gap:8px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Arc Testnet Explorer
          </a>
          <a href="https://faucet.circle.com" target="_blank" class="btn btn-ghost" style="justify-content:flex-start;gap:8px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            Get Testnet USDC
          </a>
          <a href="https://docs.arc.io" target="_blank" class="btn btn-ghost" style="justify-content:flex-start;gap:8px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            Arc Documentation
          </a>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#connect-btn')?.addEventListener('click', async () => {
    await wallet.connect();
    container.querySelector('#wallet-info').innerHTML = renderWalletInfo();
  });

  // Load USDC balance
  if (wallet.connected) {
    const balanceEl = document.createElement('div');
    balanceEl.style.cssText = 'font-size:11px;color:var(--muted);margin-top:8px';
    balanceEl.textContent = 'Loading USDC balance…';
    container.querySelector('#wallet-info').appendChild(balanceEl);
    const bal = await wallet.usdcBalance();
    const formatted = (Number(BigInt(bal)) / 1e6).toFixed(2);
    balanceEl.innerHTML = `USDC Balance: <span style="color:var(--ink);font-weight:600">${formatted} USDC</span>`;
  }

  // Protocol settings
  try {
    const settings = await api.publicSettings();
    const sec = container.querySelector('#protocol-settings');
    sec.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px">
        <div class="card-inner" style="display:flex;justify-content:space-between">
          <span style="font-size:12px;color:var(--muted)">Protocol Fee</span>
          <span style="font-size:13px;font-weight:600;color:var(--ink)">${(settings.feeBps / 100).toFixed(1)}% on profit</span>
        </div>
        <div class="card-inner" style="display:flex;justify-content:space-between">
          <span style="font-size:12px;color:var(--muted)">Grace Period</span>
          <span style="font-size:13px;font-weight:600;color:var(--ink)">${settings.gracePeriodDays} days</span>
        </div>
        <div class="card-inner" style="display:flex;justify-content:space-between">
          <span style="font-size:12px;color:var(--muted)">Protocol Status</span>
          <span style="font-size:13px;font-weight:600;color:${settings.paused ? 'var(--danger)' : 'var(--success)'}">
            ${settings.paused ? 'Paused' : 'Active'}
          </span>
        </div>
        ${settings.oracle ? `
          <div class="card-inner">
            <div style="font-size:11px;color:var(--muted);margin-bottom:3px">Oracle Address</div>
            <div style="font-size:12px;font-family:var(--font-mono);color:var(--ink-2)">${shortAddr(settings.oracle)}</div>
          </div>
        ` : ''}
        ${settings.treasury ? `
          <div class="card-inner">
            <div style="font-size:11px;color:var(--muted);margin-bottom:3px">Treasury Address</div>
            <div style="font-size:12px;font-family:var(--font-mono);color:var(--ink-2)">${shortAddr(settings.treasury)}</div>
          </div>
        ` : ''}
      </div>
    `;
  } catch (err) {
    container.querySelector('#protocol-settings').innerHTML = `<p style="font-size:12px;color:var(--muted)">Contract not yet deployed or reachable.</p>`;
  }
}

function renderWalletInfo() {
  if (!wallet.connected) return '';
  return `
    <div class="card-inner" style="margin-bottom:10px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:3px">Connected Address</div>
      <div style="font-size:13px;font-family:var(--font-mono);color:var(--ink)">${wallet.account}</div>
    </div>
    <div class="card-inner" style="margin-bottom:10px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:3px">Network</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:13px;color:${wallet.onRightChain ? 'var(--success)' : 'var(--danger)'}">
        <div class="dot ${wallet.onRightChain ? 'dot-green' : 'dot-red'}"></div>
        ${wallet.onRightChain ? 'Arc Testnet' : 'Wrong Network'}
      </div>
    </div>
    ${!wallet.onRightChain ? `<button class="btn btn-primary btn-sm" onclick="window.ethereum && window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x4CEF52'}]})">Switch to Arc Testnet</button>` : ''}
  `;
}
