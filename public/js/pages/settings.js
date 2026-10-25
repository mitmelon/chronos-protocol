// ─── Settings ────────────────────────────────────────────────────────────────
import { api } from '../api.js';
import { wallet } from '../wallet.js';
import { esc, shortAddr, formatUsdc, explorerAddrUrl } from '../utils.js';
import { icon, onWallet } from '../ui.js';
import { openConnect } from '../login.js';
import { session, signOut } from '../session.js';

const USDC = () => wallet.usdc || window.CHRONOS_USDC || '';

export async function renderSettings(view) {
  const contract = window.CHRONOS_CONTRACT;
  const contractUrl = explorerAddrUrl(contract);

  view.innerHTML = `
    <div class="page">
      <div class="page-head"><div><h1>Settings</h1><p>Wallet, network and protocol configuration.</p></div></div>
      <div class="cols">
        <section class="card card-pad"><h2 class="section-title">Account</h2><div id="wallet" style="margin-top:14px"></div></section>
        <section class="card card-pad"><h2 class="section-title">Protocol</h2><div id="protocol" style="margin-top:14px"><div class="skeleton" style="height:120px"></div></div></section>
        <section class="card card-pad">
          <h2 class="section-title">Network</h2>
          <dl class="kv" style="margin-top:14px">
            <div><dt>Chain</dt><dd>${esc(wallet.networkName)}</dd></div>
            <div><dt>Chain ID</dt><dd class="num">${esc(wallet.chain?.id || window.CHRONOS_CHAIN_ID || '')}</dd></div>
            <div><dt>USDC</dt><dd class="mono">${esc(USDC())}</dd></div>
            <div><dt>Contract</dt><dd class="mono">${contract ? esc(contract) : 'Not deployed yet'}</dd></div>
          </dl>
          ${contractUrl ? `<a class="btn btn-secondary btn-sm" style="margin-top:16px" href="${esc(contractUrl)}" target="_blank" rel="noopener">View contract ${icon.external}</a>` : ''}
        </section>
        <section class="card card-pad">
          <h2 class="section-title">Resources</h2>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px">
            <a class="btn btn-secondary" style="justify-content:space-between" href="${esc(window.CHRONOS_EXPLORER || 'https://explorer.testnet.arc.io')}" target="_blank" rel="noopener">Arc explorer ${icon.external}</a>
            <a class="btn btn-secondary" style="justify-content:space-between" href="https://faucet.circle.com" target="_blank" rel="noopener">Get testnet USDC ${icon.external}</a>
            <a class="btn btn-secondary" style="justify-content:space-between" href="https://docs.arc.io" target="_blank" rel="noopener">Arc documentation ${icon.external}</a>
          </div>
        </section>
      </div>
    </div>`;

  const box = view.querySelector('#wallet');

  async function drawWallet() {
    if (!wallet.connected) {
      box.innerHTML = `<p class="hint" style="margin:0 0 14px">Connect a wallet to trade and sign in.</p><button class="btn btn-primary" id="connect">Connect wallet</button>`;
      box.querySelector('#connect').addEventListener('click', () => openConnect({ mode: 'connect' }));
      return;
    }
    const signed = !!session.user;
    box.innerHTML = `
      <dl class="kv">
        <div><dt>Address</dt><dd class="mono">${esc(wallet.account)}</dd></div>
        <div><dt>Wallet</dt><dd>${esc(wallet.providerInfo?.name || 'Browser wallet')}</dd></div>
        <div><dt>Network</dt><dd>${wallet.onRightChain ? esc(wallet.networkName) : 'Wrong network'}</dd></div>
        <div><dt>Session</dt><dd>${signed ? 'Signed in' : 'Not signed in'}</dd></div>
        <div><dt>USDC balance</dt><dd class="num" id="bal">…</dd></div>
      </dl>
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        ${wallet.onRightChain ? '' : `<button class="btn btn-primary btn-sm" id="switch">Switch to ${esc(wallet.networkName)}</button>`}
        ${signed ? '<button class="btn btn-secondary btn-sm" id="signout">Sign out</button>' : '<button class="btn btn-primary btn-sm" id="signin">Sign in</button>'}
        <button class="btn btn-quiet btn-sm" id="disconnect">Disconnect</button>
      </div>`;
    box.querySelector('#switch')?.addEventListener('click', () => wallet.switchChain().catch(() => {}));
    box.querySelector('#signin')?.addEventListener('click', () => openConnect({ mode: 'signin' }));
    box.querySelector('#signout')?.addEventListener('click', () => signOut());
    box.querySelector('#disconnect')?.addEventListener('click', async () => { await signOut(); await wallet.disconnect(); });
    try { const b = await wallet.usdcBalance(); const el = box.querySelector('#bal'); if (el) el.textContent = `${formatUsdc(b)} USDC`; }
    catch { const el = box.querySelector('#bal'); if (el) el.textContent = '—'; }
  }
  drawWallet();
  onWallet(view, drawWallet);
  const offSession = session.onUpdate(() => { if (view.isConnected) drawWallet(); else offSession(); });

  try {
    const s = await api.publicSettings();
    view.querySelector('#protocol').innerHTML = `
      <dl class="kv">
        <div><dt>Protocol fee</dt><dd>${(s.feeBps / 100).toFixed(1)}% of profit</dd></div>
        <div><dt>Refund grace period</dt><dd>${esc(s.gracePeriodDays)} days</dd></div>
        <div><dt>Status</dt><dd>${s.paused ? 'Paused' : 'Active'}</dd></div>
        ${s.oracle ? `<div><dt>Oracle</dt><dd class="mono">${esc(shortAddr(s.oracle))}</dd></div>` : ''}
        ${s.treasury ? `<div><dt>Treasury</dt><dd class="mono">${esc(shortAddr(s.treasury))}</dd></div>` : ''}
      </dl>`;
  } catch {
    const el = view.querySelector('#protocol');
    if (el) el.innerHTML = '<p class="hint" style="margin:0">The contract is not deployed or can’t be reached.</p>';
  }
}
