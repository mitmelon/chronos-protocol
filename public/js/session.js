// ─── Session: sign in with your wallet, and the resolve API ──────────────────
import { wallet } from './wallet.js';

const listeners = new Set();
export const session = {
  user: null,        // { address, expiresAt } when signed in
  loaded: false,
  onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

async function json(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
  let body = null; try { body = await res.json(); } catch { /* empty body */ }
  if (!res.ok && !(options.allow || []).includes(res.status)) throw Object.assign(new Error(body?.message || `Request failed (${res.status})`), { status: res.status, body });
  return { status: res.status, body };
}

export async function refreshSession() {
  try {
    const { body } = await json('/api/auth/me');
    session.user = body?.authenticated ? { address: body.address, expiresAt: body.expiresAt } : null;
  } catch { session.user = null; }
  session.loaded = true; emit();
  return session.user;
}

/** Ask the server for a challenge, have the wallet sign it, and exchange the signature for a session cookie. */
export async function signIn() {
  if (!wallet.connected) throw new Error('Connect a wallet first');
  const { body: challenge } = await json('/api/auth/nonce', { method: 'POST', body: JSON.stringify({ address: wallet.account }) });
  const signature = await wallet.signMessage(challenge.message);
  await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ address: wallet.account, signature, nonce: challenge.nonce }) });
  return refreshSession();
}

export async function signOut() {
  try { await json('/api/auth/logout', { method: 'POST' }); } catch { /* cookie may already be gone */ }
  session.user = null; emit();
}

// If the wallet switches to a different account, the old session no longer matches it.
wallet.onUpdate((event) => {
  if (event === 'account' && session.user && wallet.account && wallet.account.toLowerCase() !== session.user.address) signOut();
});

// ── Resolve API ──────────────────────────────────────────────────────────────
export const resolveApi = {
  /** Ask the oracle to resolve now. Returns { status, message, ... }. Throws with .status on 401/409/429. */
  async start(marketId) { return (await json(`/api/markets/${marketId}/resolve`, { method: 'POST' })).body; },
  async status(marketId) { return (await json(`/api/markets/${marketId}/resolution`)).body; },
};
