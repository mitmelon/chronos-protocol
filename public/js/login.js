// ─── Connect / sign-in dialog ────────────────────────────────────────────────
// One dialog, three steps: choose wallet, switch to the right network, sign in (optional).
import { wallet } from './wallet.js';
import { session, signIn } from './session.js';
import { esc } from './utils.js';

const INSTALL = [['MetaMask', 'https://metamask.io/download/'], ['Rabby', 'https://rabby.io/'], ['Coinbase Wallet', 'https://www.coinbase.com/wallet']];
let _open = null;

function stepsFor(mode) { return mode === 'signin' ? ['Wallet', 'Network', 'Sign in'] : ['Wallet', 'Network']; }

function currentStep(mode) {
  if (!wallet.connected) return 0;
  if (!wallet.onRightChain) return 1;
  if (mode === 'signin' && !session.user) return 2;
  return 3; // done
}

/**
 * Open the dialog. mode: 'connect' (wallet + network) or 'signin' (also sign a message).
 * Resolves true when the requested state is reached, false if the user closes it.
 */
export function openConnect({ mode = 'connect' } = {}) {
  if (_open) return _open.promise;
  if (currentStep(mode) === 3) return Promise.resolve(true);

  const previouslyFocused = document.activeElement;
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-head">
        <div><h2 id="modal-title">${mode === 'signin' ? 'Sign in to Chronos' : 'Connect your wallet'}</h2>
        <p>${mode === 'signin' ? 'Sign in to resolve markets. It is free and never moves your funds.' : `Chronos runs on ${esc(wallet.networkName)}.`}</p></div>
        <button class="btn btn-quiet btn-icon" data-close aria-label="Close">&times;</button>
      </div>
      <ol class="steps" id="steps"></ol>
      <div class="modal-body" id="body" aria-live="polite"></div>
      <p class="modal-error" id="error" role="alert" hidden></p>
    </div>`;
  document.body.appendChild(root);
  document.body.style.overflow = 'hidden';

  let finish; const promise = new Promise((res) => { finish = res; });
  const $ = (s) => root.querySelector(s);
  let busy = false;

  const showError = (msg) => { const el = $('#error'); el.textContent = msg || ''; el.hidden = !msg; };
  const close = (result) => {
    if (!_open) return;
    unsubW(); unsubS(); document.removeEventListener('keydown', onKey, true);
    root.remove(); document.body.style.overflow = ''; _open = null;
    previouslyFocused?.focus?.({ preventScroll: true });
    finish(result);
  };
  const run = async (fn) => {
    if (busy) return; busy = true; showError(''); render();
    try { await fn(); } catch (err) { showError(err.message || 'Something went wrong'); }
    busy = false; render();
  };

  function render() {
    const step = currentStep(mode);
    $('#steps').innerHTML = stepsFor(mode).map((label, i) => `<li class="${i < step ? 'done' : i === step ? 'now' : ''}"><span>${i < step ? '&#10003;' : i + 1}</span>${label}</li>`).join('');
    const body = $('#body');
    const disabled = busy ? 'disabled' : '';

    if (step === 3) { body.innerHTML = `<div class="modal-done"><strong>${mode === 'signin' ? 'You are signed in' : 'Wallet connected'}</strong><span class="mono">${esc(wallet.account || '')}</span></div>`; setTimeout(() => close(true), 600); return; }

    if (step === 0) {
      const list = wallet.providerList;
      if (!list.length) {
        body.innerHTML = `<p class="modal-text">No browser wallet was detected. Install one, then reload this page.</p>
          <div class="wallet-list">${INSTALL.map(([n, u]) => `<a class="wallet-opt" href="${u}" target="_blank" rel="noopener"><span class="wallet-name">${n}</span><span class="wallet-hint">Install</span></a>`).join('')}</div>`;
        return;
      }
      body.innerHTML = `<p class="modal-text">Choose a wallet to connect.</p><div class="wallet-list">${list.map((w) => `
        <button class="wallet-opt" data-uuid="${esc(w.uuid)}" ${disabled}>
          ${w.icon ? `<img src="${esc(w.icon)}" alt="" width="28" height="28" />` : '<span class="wallet-ico"></span>'}
          <span class="wallet-name">${esc(w.name)}</span><span class="wallet-hint">${busy ? 'Waiting…' : ''}</span>
        </button>`).join('')}</div>`;
      body.querySelectorAll('[data-uuid]').forEach((b) => b.addEventListener('click', () => run(() => wallet.connect(b.dataset.uuid))));
      return;
    }

    if (step === 1) {
      body.innerHTML = `<p class="modal-text">Your wallet is on the wrong network. Switch to <strong>${esc(wallet.networkName)}</strong> to continue. If it isn’t in your wallet yet, we’ll add it.</p>
        <button class="btn btn-primary btn-lg btn-block" id="switch" ${disabled}>${busy ? 'Check your wallet…' : `Switch to ${esc(wallet.networkName)}`}</button>`;
      $('#switch').addEventListener('click', () => run(() => wallet.switchChain()));
      return;
    }

    body.innerHTML = `<p class="modal-text">Sign a short message to prove you own <span class="mono">${esc(wallet.account.slice(0, 6))}…${esc(wallet.account.slice(-4))}</span>. This is not a transaction: it costs nothing and can’t move funds.</p>
      <button class="btn btn-primary btn-lg btn-block" id="sign" ${disabled}>${busy ? 'Check your wallet…' : 'Sign message'}</button>`;
    $('#sign').addEventListener('click', () => run(() => signIn()));
  }

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(false); }
    if (e.key === 'Tab') { // keep focus inside the dialog
      const f = [...root.querySelectorAll('button:not([disabled]), a[href]')]; if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('pointerdown', (e) => { if (e.target === root) close(false); });
  root.querySelector('[data-close]').addEventListener('click', () => close(false));
  const unsubW = wallet.onUpdate(render);
  const unsubS = session.onUpdate(render);

  render();
  wallet.ready().then(render);
  (root.querySelector('.wallet-opt, #switch, #sign, [data-close]'))?.focus({ preventScroll: true });

  _open = { promise, close };
  return promise;
}

/** Connect (and switch network) if needed. Resolves true when ready to transact. */
export const connectWallet = () => openConnect({ mode: 'connect' });
/** Require a signed-in session (opens the dialog if needed). */
export async function requireSignIn() {
  if (session.user && wallet.connected && wallet.account.toLowerCase() === session.user.address) return true;
  return openConnect({ mode: 'signin' });
}
