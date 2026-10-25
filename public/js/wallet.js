// ─── Chronos wallet ──────────────────────────────────────────────────────────
// Works with any injected wallet (EIP-6963 discovery, with window.ethereum as a fallback),
// on whichever Arc network this deployment is configured for (testnet or mainnet).
// The network comes from the server (/api/chain), never from hard-coded values.

// Function selectors, computed from the Chronos ABI (keccak256 of the signature, first 4 bytes).
const SEL = {
  buyShares:     '0x1af63283', // buyShares(uint256,uint8,uint256)
  claimWinnings: '0x677bd9ff', // claimWinnings(uint256)
  claimRefund:   '0x5b7baf64', // claimRefund(uint256)
  approve:       '0x095ea7b3', // approve(address,uint256)
  allowance:     '0xdd62ed3e', // allowance(address,address)
  balanceOf:     '0x70a08231', // balanceOf(address)
};

const STORE_KEY = 'chronos.wallet';
const pad = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const toHex = (n) => '0x' + BigInt(n).toString(16);
const utf8Hex = (s) => '0x' + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

class ChronosWallet {
  constructor() {
    this.providers = new Map();   // uuid -> { info, provider }
    this.provider = null;
    this.providerInfo = null;
    this.account = null;
    this.chainId = null;          // number
    this.chain = null;            // { id, hex, name, rpcUrl, explorerUrl, nativeCurrency, usdcAddress, network }
    this.contract = window.CHRONOS_CONTRACT || '';
    this._listeners = new Set();
    this._ready = this._init();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────
  async _init() {
    window.addEventListener('eip6963:announceProvider', (e) => {
      const { info, provider } = e.detail || {};
      if (info && provider && !this.providers.has(info.uuid)) { this.providers.set(info.uuid, { info, provider }); this._emit('providers'); }
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    await Promise.all([this._loadChain(), new Promise((r) => setTimeout(r, 250))]); // give wallets a moment to announce
    if (!this.providers.size && window.ethereum) {
      const list = Array.isArray(window.ethereum.providers) && window.ethereum.providers.length ? window.ethereum.providers : [window.ethereum];
      list.forEach((p, i) => this.providers.set(`legacy-${i}`, { info: { uuid: `legacy-${i}`, name: p.isMetaMask ? 'MetaMask' : p.isRabby ? 'Rabby' : p.isCoinbaseWallet ? 'Coinbase Wallet' : 'Browser wallet', icon: '' }, provider: p }));
    }
    await this._restore();
    this._emit('ready');
  }

  ready() { return this._ready; }

  async _loadChain() {
    try {
      const res = await fetch('/api/chain', { credentials: 'same-origin' });
      this.chain = await res.json();
      if (this.chain.contractAddress) this.contract = this.chain.contractAddress;
    } catch {
      // Fall back to what the page injected, so connect still works if /api/chain is briefly down.
      const id = Number(window.CHRONOS_CHAIN_ID || 0);
      this.chain = { id, hex: '0x' + id.toString(16), name: window.CHRONOS_NETWORK || 'Arc', rpcUrl: '', explorerUrl: window.CHRONOS_EXPLORER || '', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, usdcAddress: window.CHRONOS_USDC || '' };
    }
  }

  // ── state helpers ───────────────────────────────────────────────────────
  get connected() { return !!this.account; }
  get onRightChain() { return this.chain && this.chainId === this.chain.id; }
  get hasWallet() { return this.providers.size > 0; }
  get providerList() { return [...this.providers.values()].map((p) => p.info); }
  get networkName() { return this.chain?.name || 'Arc'; }
  get usdc() { return this.chain?.usdcAddress || window.CHRONOS_USDC; }

  onUpdate(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(event) { this._listeners.forEach((fn) => { try { fn(event); } catch (e) { console.error(e); } }); }

  // ── connect / disconnect ────────────────────────────────────────────────
  _attach(uuid) {
    const entry = this.providers.get(uuid);
    if (!entry) throw new Error('That wallet is not available');
    if (this.provider && this._handlers) { try { this.provider.removeListener('accountsChanged', this._handlers.acc); this.provider.removeListener('chainChanged', this._handlers.chain); } catch { /* ignore */ } }
    this.provider = entry.provider; this.providerInfo = entry.info;
    this._handlers = {
      acc: (accs) => { this.account = accs && accs[0] ? accs[0] : null; if (!this.account) this._forget(); this._emit('account'); },
      chain: (hex) => { this.chainId = parseInt(hex, 16); this._emit('chain'); },
    };
    this.provider.on?.('accountsChanged', this._handlers.acc);
    this.provider.on?.('chainChanged', this._handlers.chain);
  }

  _forget() { try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } }

  /** Silently reconnect to the wallet used last time (no popup). */
  async _restore() {
    let uuid; try { uuid = localStorage.getItem(STORE_KEY); } catch { /* ignore */ }
    if (!uuid || !this.providers.has(uuid)) return;
    try {
      this._attach(uuid);
      const accs = await this.provider.request({ method: 'eth_accounts' });
      if (accs && accs[0]) { this.account = accs[0]; this.chainId = parseInt(await this.provider.request({ method: 'eth_chainId' }), 16); }
      else this._forget();
    } catch { this._forget(); }
  }

  /** Connect with a specific wallet (by EIP-6963 uuid). Pass nothing to use the only/first one. */
  async connect(uuid) {
    await this.ready();
    if (!this.hasWallet) throw Object.assign(new Error('No wallet found. Install MetaMask, Rabby or another browser wallet.'), { code: 'NO_WALLET' });
    const id = uuid || [...this.providers.keys()][0];
    this._attach(id);
    let accs;
    try { accs = await this.provider.request({ method: 'eth_requestAccounts' }); }
    catch (err) { throw Object.assign(new Error(err.code === 4001 ? 'You closed the wallet request.' : (err.message || 'Could not connect')), { code: err.code }); }
    if (!accs || !accs[0]) throw new Error('No account was shared by the wallet.');
    this.account = accs[0];
    this.chainId = parseInt(await this.provider.request({ method: 'eth_chainId' }), 16);
    try { localStorage.setItem(STORE_KEY, id); } catch { /* ignore */ }
    this._emit('account');
    return this.account;
  }

  async disconnect() {
    try { await this.provider?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch { /* not supported everywhere */ }
    this.account = null; this._forget(); this._emit('account');
  }

  // ── network ─────────────────────────────────────────────────────────────
  /** Switch to the configured Arc network, adding it to the wallet if needed. */
  async switchChain() {
    await this.ready();
    const c = this.chain;
    if (!c?.id) throw new Error('Network configuration is unavailable. Reload the page.');
    try {
      await this.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: c.hex }] });
    } catch (err) {
      const code = err.code ?? err.data?.originalError?.code;
      if (code === 4001) throw new Error('You declined the network switch.');
      if (code === 4902 || code === -32603 || /unrecognized|not been added|Unrecognized chain/i.test(err.message || '')) {
        if (!c.rpcUrl) throw new Error('Cannot add the network: no public RPC URL is configured.');
        await this.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: c.hex, chainName: c.name, nativeCurrency: c.nativeCurrency, rpcUrls: [c.rpcUrl], blockExplorerUrls: c.explorerUrl ? [c.explorerUrl] : [] }] });
      } else throw err;
    }
    this.chainId = parseInt(await this.provider.request({ method: 'eth_chainId' }), 16);
    this._emit('chain');
  }
  switchToArc() { return this.switchChain(); }

  // ── signing (sign-in) ───────────────────────────────────────────────────
  async signMessage(message) {
    if (!this.account) throw new Error('Connect a wallet first');
    try { return await this.provider.request({ method: 'personal_sign', params: [utf8Hex(message), this.account] }); }
    catch (err) { throw new Error(err.code === 4001 ? 'You declined the signature request.' : (err.message || 'Signing failed')); }
  }

  // ── transactions ────────────────────────────────────────────────────────
  _requireReady() {
    if (!this.account) throw new Error('Connect your wallet first');
    if (!this.onRightChain) throw new Error(`Switch your wallet to ${this.networkName}`);
    if (!this.contract) throw new Error('The Chronos contract address is not configured');
  }

  async _send(to, data) {
    this._requireReady();
    try { return await this.provider.request({ method: 'eth_sendTransaction', params: [{ from: this.account, to, data }] }); }
    catch (err) { throw new Error(err.code === 4001 ? 'You rejected the transaction.' : (err.data?.message || err.message || 'Transaction failed')); }
  }

  /** Wait until the tx is mined and succeeded. Throws if it reverted. */
  async waitForTx(hash, { timeoutMs = 90000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await this.provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (r) { if (r.status === '0x1') return r; throw new Error('The transaction was reverted on-chain.'); }
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error('Timed out waiting for confirmation. Check the explorer, then try again.');
  }

  async _call(to, data) { return this.provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] }); }

  async usdcBalance() { if (!this.account) return '0'; return BigInt(await this._call(this.usdc, SEL.balanceOf + pad(this.account))).toString(); }
  async allowance() { if (!this.account) return '0'; return BigInt(await this._call(this.usdc, SEL.allowance + pad(this.account) + pad(this.contract))).toString(); }

  async approveUsdc(amount) {
    const hash = await this._send(this.usdc, SEL.approve + pad(this.contract) + pad(toHex(amount)));
    await this.waitForTx(hash);
    return hash;
  }
  async buyShares(marketId, outcome, amount) {
    const hash = await this._send(this.contract, SEL.buyShares + pad(toHex(marketId)) + pad(toHex(outcome)) + pad(toHex(amount)));
    await this.waitForTx(hash);
    return hash;
  }
  async claimWinnings(marketId) { const hash = await this._send(this.contract, SEL.claimWinnings + pad(toHex(marketId))); await this.waitForTx(hash); return hash; }
  async claimRefund(marketId)   { const hash = await this._send(this.contract, SEL.claimRefund + pad(toHex(marketId))); await this.waitForTx(hash); return hash; }
}

export const wallet = new ChronosWallet();
