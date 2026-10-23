// ─── Wallet button + account menu ────────────────────────────────────────────
import { wallet } from './wallet.js';
import { shortAddr, explorerAddrUrl, esc } from './utils.js';
import { icon, openPopover, closePopover, popoverOpenFor, copyText } from './ui.js';

export function mountWalletButton(container) {
  function render() {
    closePopover();
    const connected = wallet.connected;
    const wrongChain = connected && !wallet.onRightChain;

    if (!connected || wrongChain) {
      container.innerHTML = `<button class="btn btn-primary btn-sm" id="wallet-btn">${connected ? 'Switch to Arc' : 'Connect wallet'}</button>`;
      container.querySelector('#wallet-btn').addEventListener('click', async () => {
        if (!wallet.connected) { const ok = await wallet.connect(); if (ok && !wallet.onRightChain) await wallet.switchToArc(); }
        else await wallet.switchToArc();
      });
      return;
    }

    container.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="wallet-btn" aria-haspopup="menu" aria-expanded="false">
        <span class="status"><i></i></span><span class="mono">${esc(shortAddr(wallet.account))}</span>${icon.chevron}
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
      <div class="menu-head"><div class="k">Connected wallet</div><div class="v">${esc(wallet.account)}</div></div>
      <button class="menu-item" role="menuitem" data-act="copy">${icon.copy}Copy address</button>
      ${url ? `<a class="menu-item" role="menuitem" href="${esc(url)}" target="_blank" rel="noopener">${icon.external}View on explorer</a>` : ''}`;
    el.querySelector('[data-act="copy"]').addEventListener('click', () => { closePopover(); copyText(wallet.account); });

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
  render();
}
