// ─── Chronos Wallet Integration ─────────────────────────────────────────────
import { showToast, shortAddr } from './utils.js';

const TARGET_CHAIN_ID = '0x4CEF52'; // Arc Testnet 5042002
const CONTRACT_ADDRESS = window.CHRONOS_CONTRACT || '';
const USDC_ADDRESS     = window.CHRONOS_USDC     || '0x3600000000000000000000000000000000000000';
const EXPLORER_BASE    = window.CHRONOS_EXPLORER  || 'https://explorer.testnet.arc.io';

// ABI encoding helpers
function encUint(n) { return BigInt(n).toString(16).padStart(64, '0'); }
function encAddr(a) { return a.toLowerCase().replace('0x', '').padStart(64, '0'); }
function decUint(hex) { if (!hex || hex === '0x') return 0n; return BigInt(hex.slice(0, 66)); }

// ERC-20 function selectors
const SEL = {
  balanceOf: '0x70a08231',
  approve:   '0x095ea7b3',
  allowance: '0xdd62ed3e',
};

// Chronos function selectors (keccak256 first 4 bytes)
const CHRONOS_SEL = {
  buyShares:     'a96be98e', // buyShares(uint256,uint8,uint256)
  claimWinnings: 'a7d8e50c', // claimWinnings(uint256)
  claimRefund:   'b2b60940', // claimRefund(uint256)
  withdrawFees:  'd0e30db0', // withdrawFees()
};

let _account = null;
let _chainId  = null;
const _listeners = new Set();
function notify(event, payload) { _listeners.forEach(fn => { try { fn(event, payload); } catch {} }); }

export const wallet = {
  get account()      { return _account; },
  get chainId()      { return _chainId; },
  get connected()    { return !!_account; },
  get onRightChain() { return _chainId === TARGET_CHAIN_ID || _chainId === TARGET_CHAIN_ID.toLowerCase(); },

  onUpdate(fn) { _listeners.add(fn); return () => _listeners.delete(fn); },

  async connect() {
    if (!window.ethereum) { showToast('No wallet found. Install MetaMask or Rabby.', 'error'); return false; }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      _account = accounts[0] || null;
      _chainId = await window.ethereum.request({ method: 'eth_chainId' });
      notify('connected', { account: _account, chainId: _chainId });
      return true;
    } catch (err) { if (err.code !== 4001) showToast('Connection failed: ' + err.message, 'error'); return false; }
  },

  async switchToArc() {
    if (!window.ethereum) return false;
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: TARGET_CHAIN_ID }] });
      return true;
    } catch (err) {
      if (err.code === 4902) {
        try {
          await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: TARGET_CHAIN_ID, chainName: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: ['https://rpc.testnet.arc.io'], blockExplorerUrls: ['https://explorer.testnet.arc.io'] }] });
          return true;
        } catch { return false; }
      }
      return false;
    }
  },

  async usdcBalance(address) {
    if (!window.ethereum) return '0';
    const addr = address || _account;
    if (!addr) return '0';
    try {
      const result = await window.ethereum.request({ method: 'eth_call', params: [{ to: USDC_ADDRESS, data: SEL.balanceOf + encAddr(addr) }, 'latest'] });
      return decUint(result).toString();
    } catch { return '0'; }
  },

  async allowance(owner) {
    if (!window.ethereum || !CONTRACT_ADDRESS) return '0';
    try {
      const data = SEL.allowance + encAddr(owner) + encAddr(CONTRACT_ADDRESS);
      const result = await window.ethereum.request({ method: 'eth_call', params: [{ to: USDC_ADDRESS, data }, 'latest'] });
      return decUint(result).toString();
    } catch { return '0'; }
  },

  async approveUsdc(amount) {
    if (!_account || !CONTRACT_ADDRESS) throw new Error('Not connected');
    return window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: _account, to: USDC_ADDRESS, data: SEL.approve + encAddr(CONTRACT_ADDRESS) + encUint(amount) }] });
  },

  async buyShares(marketId, outcome, amount) {
    const data = '0x' + CHRONOS_SEL.buyShares + encUint(marketId) + encUint(outcome) + encUint(amount);
    return window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: _account, to: CONTRACT_ADDRESS, data }] });
  },

  async claimWinnings(marketId) {
    const data = '0x' + CHRONOS_SEL.claimWinnings + encUint(marketId);
    return window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: _account, to: CONTRACT_ADDRESS, data }] });
  },

  async claimRefund(marketId) {
    const data = '0x' + CHRONOS_SEL.claimRefund + encUint(marketId);
    return window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: _account, to: CONTRACT_ADDRESS, data }] });
  },

  async withdrawFees() {
    const data = '0x' + CHRONOS_SEL.withdrawFees;
    return window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: _account, to: CONTRACT_ADDRESS, data }] });
  },

  explorerTx(hash) { return `${EXPLORER_BASE}/tx/${hash}`; },
};

if (window.ethereum) {
  window.ethereum.on('accountsChanged', (accounts) => { _account = accounts[0] || null; notify('accountsChanged', { account: _account }); });
  window.ethereum.on('chainChanged', (chainId) => { _chainId = chainId; notify('chainChanged', { chainId }); });
}

export function mountWalletButton(container) {
  const render = () => {
    const isConnected = wallet.connected;
    const isRight     = wallet.onRightChain;
    const needsSwitch = isConnected && !isRight;
    container.innerHTML = `
      <button class="wallet-btn" id="wallet-btn-trigger">
        <span class="wallet-btn-dot ${isConnected ? (isRight ? 'dot-green' : 'dot-yellow') : 'dot-red'} pulse"></span>
        <span>${!isConnected ? 'Connect Wallet' : needsSwitch ? 'Switch to Arc' : shortAddr(wallet.account)}</span>
      </button>`;
    document.getElementById('wallet-btn-trigger').addEventListener('click', async () => {
      if (!isConnected) { const ok = await wallet.connect(); if (ok && !wallet.onRightChain) await wallet.switchToArc(); }
      else if (needsSwitch) await wallet.switchToArc();
    });
  };
  wallet.onUpdate(render);
  render();
}
