// ─── Wallet button + account menu ────────────────────────────────────────────
import { wallet } from './wallet.js';
import { session, signOut } from './session.js';
import { openConnect } from './login.js';
import { shortAddr, explorerAddrUrl, esc, showToast } from './utils.js';
import { icon, openPopover, closePopover, popoverOpenFor, copyText } from './ui.js';

export function mountWalletButton(container) {
  function render() {
    closePopover();
    if (!wallet.connected) {
      container.innerHTML = `<button class="btn btn-primary btn-sm" id="wallet-btn">Connect wallet</button>`;
      container.querySelector('#wallet-btn').addEventListener('click', () => openConnect({ mode: 'connect' }));
      return;
    }
    if (!wallet.onRightChain) {
      container.innerHTML = `<button class="btn btn-primary btn-sm" id="wallet-btn">Switch to ${esc(wallet.networkName)}</button>`;
      container.querySelector('#wallet-btn').addEventListener('click', () => wallet.switchChain().catch((e) => showToast(e.message, 'error')));
      return;
    }
    container.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="wallet-btn" aria-haspopup="menu" aria-expanded="false">
        <span class="status${session.user ? '' : ' status-closed'}" title="${session.user ? 'Signed in' : 'Not signed in'}"><i></i></span>
        <span class="mono">${esc(shortAddr(wallet.account))}</span>${icon.chevron}
      </button>`;
    const btn = container.querySelector('#wallet-btn');
    btn.addEventListener('click', () => { popoverOpenFor(btn) ? closePopover() : openMenu(btn); });
  }

  function openMenu(btn) {
    const url = explorerAddrUrl(wallet.account);
    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = `
      <div class="menu-head">
        <div class="k">${esc(wallet.providerInfo?.name || 'Wallet')} on ${esc(wallet.networkName)}</div>
        <div class="v">${esc(wallet.account)}</div>
        <div style="margin-top:8px"><span class="tag ${session.user ? 'tag-yes' : ''}">${session.user ? 'Signed in' : 'Not signed in'}</span></div>
      </div>
      <button class="menu-item" role="menuitem" data-act="copy">${icon.copy}Copy address</button>
      ${url ? `<a class="menu-item" role="menuitem" href="${esc(url)}" target="_blank" rel="noopener">${icon.external}View on explorer</a>` : ''}
      ${session.user
        ? `<button class="menu-item" role="menuitem" data-act="signout">Sign out</button>`
        : `<button class="menu-item" role="menuitem" data-act="signin">Sign in</button>`}
      <button class="menu-item" role="menuitem" data-act="disconnect">Disconnect wallet</button>`;
    const act = (name, fn) => el.querySelector(`[data-act="${name}"]`)?.addEventListener('click', () => { closePopover(); fn(); });
    act('copy', () => copyText(wallet.account));
    act('signin', () => openConnect({ mode: 'signin' }));
    act('signout', () => signOut());
    act('disconnect', async () => { await signOut(); await wallet.disconnect(); });

    const items = () => [...el.querySelectorAll('[role="menuitem"]')];
    el.addEventListener('keydown', (e) => {
      const list = items(), i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Tab') closePopover();
    });
    openPopover(btn, el, { align: 'end' });
    items()[0]?.focus({ preventScroll: true });
  }

  wallet.onUpdate(render);
  session.onUpdate(render);
  render();
}
