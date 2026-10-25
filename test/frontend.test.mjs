import { JSDOM } from 'jsdom';
import assert from 'assert';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of ['window', 'document', 'Event', 'KeyboardEvent', 'localStorage', 'HTMLElement', 'Node']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true });
dom.window.Element.prototype.scrollIntoView = () => {};
const CHAIN = { id: 5042, hex: '0x13b2', name: 'Arc', network: 'mainnet', rpcUrl: 'https://rpc.mainnet.arc.io', explorerUrl: 'https://explorer.arc.io', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, usdcAddress: '0x3600000000000000000000000000000000000000', contractAddress: '0xaaaa000000000000000000000000000000000001' };
let signedIn = false; const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push(url);
  const body = url === '/api/chain' ? CHAIN : url === '/api/auth/nonce' ? { message: 'Chronos sign-in\nNonce: n1', nonce: 'n1' } : url === '/api/auth/login' ? (signedIn = true, { authenticated: true }) : url === '/api/auth/me' ? (signedIn ? { authenticated: true, address: '0x1111111111111111111111111111111111111111', expiresAt: Date.now() + 1e6 } : { authenticated: false }) : {};
  return { ok: true, status: 200, json: async () => body };
};
// A fake EIP-6963 wallet on the WRONG chain that does not know Arc yet (needs wallet_addEthereumChain).
let chainHex = '0x1', known = false, receiptPolls = 0; const sent = [];
const provider = { on() {}, removeListener() {}, async request({ method, params }) {
  switch (method) {
    case 'eth_requestAccounts': case 'eth_accounts': return ['0x1111111111111111111111111111111111111111'];
    case 'eth_chainId': return chainHex;
    case 'wallet_switchEthereumChain': if (!known) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 }); chainHex = params[0].chainId; return null;
    case 'wallet_addEthereumChain': known = true; chainHex = params[0].chainId; assert.strictEqual(params[0].rpcUrls[0], CHAIN.rpcUrl); return null;
    case 'personal_sign': assert.ok(params[0].startsWith('0x')); return '0xsigned';
    case 'eth_sendTransaction': sent.push(params[0]); return '0xtxhash';
    case 'eth_getTransactionReceipt': return ++receiptPolls < 2 ? null : { status: '0x1' };
    case 'eth_call': return '0x' + (5_000_000).toString(16).padStart(64, '0');
    default: throw new Error('unexpected ' + method);
  } } };
window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new window.CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'w1', name: 'Test Wallet', icon: '', rdns: 'test' }, provider } })));

const { wallet } = await import('../public/js/wallet.js');
await wallet.ready();
assert.strictEqual(wallet.providerList.length, 1); assert.strictEqual(wallet.chain.id, 5042);
console.log('PASS wallet discovered via EIP-6963; chain config (mainnet 5042) loaded from the server');
await wallet.connect('w1'); assert.ok(wallet.connected && !wallet.onRightChain);
await wallet.switchChain(); assert.ok(wallet.onRightChain);
console.log('PASS connect, then switch/add the configured network (4902 fallback)');
assert.strictEqual(await wallet.usdcBalance(), '5000000');
await wallet.buyShares(7, 1, 1_500_000n);
const d = sent.at(-1).data; assert.ok(d.startsWith('0x1af63283')); assert.strictEqual(d.length, 10 + 192); assert.strictEqual(sent.at(-1).to, CHAIN.contractAddress);
assert.ok(d.endsWith((1_500_000).toString(16).padStart(64, '0'))); console.log('PASS buyShares uses the real selector 0x1af63283, waits for the receipt');
await wallet.claimWinnings(7); assert.ok(sent.at(-1).data.startsWith('0x677bd9ff')); await wallet.claimRefund(7); assert.ok(sent.at(-1).data.startsWith('0x5b7baf64')); console.log('PASS claim selectors correct');

const { openConnect } = await import('../public/js/login.js');
const { session } = await import('../public/js/session.js');
const p = openConnect({ mode: 'signin' });
const modal = document.querySelector('.modal'); assert.ok(modal); assert.ok(/Sign in to Chronos/.test(modal.textContent) && document.querySelector('#sign'));
document.querySelector('#sign').click();
const result = await p; assert.strictEqual(result, true); assert.ok(session.user && session.user.address === wallet.account);
assert.ok(!document.querySelector('.modal')); assert.ok(calls.includes('/api/auth/nonce') && calls.includes('/api/auth/login'));
console.log('PASS sign-in dialog: sign message -> session cookie flow -> dialog closes, session set');
process.exit(0);
