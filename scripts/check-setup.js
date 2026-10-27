'use strict';
/**
 * scripts/check-setup.js: verify the oracle wallet, chain and contract before running the agents.
 *   node scripts/check-setup.js
 * Never prints secrets. Exit code 1 if anything blocking is wrong.
 */
require('dotenv').config();
const { formatUnits } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const config = require('../src/config');

let blocking = 0;
const ok = (m) => console.log(`  [ok]   ${m}`);
const warn = (m) => console.log(`  [warn] ${m}`);
const bad = (m) => { blocking++; console.log(`  [FAIL] ${m}`); };

(async () => {
  console.log(`\nChronos setup check: ${config.arc.networkName} (chain ${config.arc.chainId}, ARC_NETWORK=${config.arc.network})\n`);

  // 1. Oracle key
  let account = null;
  const keyProblem = config.privateKeyProblem(config.oracle.privateKey);
  if (keyProblem) bad(keyProblem);
  else { account = privateKeyToAccount(config.oracle.privateKey); ok(`Oracle wallet: ${account.address}`); }

  // 2. Keys for the agent
  config.gemini.apiKey ? ok(`Gemini key set, model ${config.gemini.model}`) : bad('GEMINI_API_KEY is not set');
  config.parallel.apiKey ? ok('Parallel key set') : bad('PARALLEL_API_KEY is not set');
  config.auth.sessionSecret.length >= 32 ? ok('SESSION_SECRET set') : warn('SESSION_SECRET is missing or short (required on mainnet/production; fine for local testing)');

  // 3a. Which RPC endpoints work? (the client uses them in order and falls back automatically)
  let reachable = 0;
  for (const url of config.arc.rpcUrls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(8000) });
      const id = parseInt((await res.json()).result, 16);
      id === config.arc.chainId ? (reachable++, ok(`RPC ${url.replace(/\?.*$/, '')} reachable (chain ${id})`)) : warn(`RPC ${url.replace(/\?.*$/, '')} reports chain ${id}, expected ${config.arc.chainId}`);
    } catch (e) { warn(`RPC ${url.replace(/\?.*$/, '')} not reachable (${e.message})`); }
  }
  if (!reachable) bad('No configured RPC endpoint is reachable. Set ARC_RPC_URL to a working Arc endpoint');

  // 3. Chain + contract
  if (!config.arc.factoryAddress) bad('VITE_FACTORY_ADDRESS is not set (the deployed Chronos contract address)');
  else {
    try {
      const contract = require('../src/services/contract');
      const client = contract.getPublicClient();
      const id = await client.getChainId();
      id === config.arc.chainId ? ok(`RPC reachable, chain id ${id} matches`) : bad(`RPC reports chain id ${id} but the config expects ${config.arc.chainId}`);

      const code = await client.getCode({ address: config.arc.factoryAddress });
      if (!code || code === '0x') bad(`No contract at ${config.arc.factoryAddress} on this chain (wrong address, wrong network, or not deployed)`);
      else {
        ok(`Contract found at ${config.arc.factoryAddress}`);
        const s = await contract.getProtocolSettings();
        s.paused ? bad('The contract is PAUSED') : ok('Contract is not paused');
        if (account) {
          s.oracle.toLowerCase() === account.address.toLowerCase()
            ? ok('Your wallet is the contract\'s oracle (it can resolve markets)')
            : warn(`The contract's oracle is ${s.oracle}, not your wallet. Creating markets works, but RESOLVING will fail until they match`);
        }
        let hasBatch = true;
        try { await contract.getPublicClient().readContract({ address: config.arc.factoryAddress, abi: contract.CHRONOS_ABI, functionName: 'MAX_BATCH' }); } catch { hasBatch = false; }
        hasBatch ? ok('Contract supports automatic payouts (claimBatch)') : warn('Contract is the OLD version without claimBatch: set AGENT_AUTO_PAYOUT=false or redeploy contracts/Chronos.sol');
      }
      if (account) {
        const bal = await client.getBalance({ address: account.address });
        bal > 0n ? ok(`Gas balance: ${formatUnits(bal, 18)} USDC`) : bad(`The oracle wallet has no USDC for gas. Send some to ${account.address}${config.arc.isMainnet ? '' : ' (testnet faucet: https://faucet.circle.com)'}`);
      }
    } catch (err) { bad(`Could not query the chain: ${err.message}`); }
  }

  console.log(blocking ? `\n${blocking} problem(s) to fix before starting the worker.\n` : '\nAll good. Start the worker: npm run start:worker\n');
  process.exit(blocking ? 1 : 0);
})();
