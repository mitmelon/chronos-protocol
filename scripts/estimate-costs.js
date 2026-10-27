'use strict';
/**
 * scripts/estimate-costs.js: what will Chronos cost to run on the network in .env, at today's gas price?
 *   node scripts/estimate-costs.js            (budget defaults to 1 USDC)
 *   node scripts/estimate-costs.js --budget 5
 * Gas units were measured on a real EVM with production-sized inputs (test/contract/measure-gas.js).
 * Gas on Arc is paid in USDC (18 decimals natively). Users pay their own gas when they trade or claim.
 */
require('dotenv').config();
const { formatUnits } = require('viem');
const config = require('../src/config');
const contract = require('../src/services/contract');

const GAS = {
  'Deploy the contract (once)': 2_477_102,
  'Publish 3 markets, ONE transaction (agent, daily)': 1_344_490,
  'Publish 1 market on its own': 484_302,
  'Resolve a market (agent, hash-pointer evidence)': 174_980,
  'Refund an unresolved market (agent, rare)': 32_098,
  'Pay out one market, 10 winners via claimBatch (agent)': 25_000 + 10 * 54_500,
  'Buy shares, first time (USER pays)': 119_469,
  'Buy shares again (USER pays)': 68_169,
  'Claim your own winnings (USER pays)': 128_587,
};

(async () => {
  const budget = Number((process.argv[process.argv.indexOf('--budget') + 1]) || 1);
  console.log(`\nChronos cost estimate on ${config.arc.networkName} (${config.arc.network}), budget ${budget} USDC\n`);
  let fees;
  try { fees = await contract.estimateFees(); } catch (e) { console.error(`Could not read the gas price from the RPC (${e.message}). Check ARC_NETWORK / ARC_RPC_URL.`); process.exit(1); }
  const price = fees.gasPrice, worst = fees.maxFeePerGas || price;
  console.log(`  gas price ${formatUnits(price, 9)} gwei (reserved up to ${formatUnits(worst, 9)} gwei; the unused part is refunded)\n`);
  const cost = (gas, p) => Number(formatUnits(BigInt(gas) * p, 18));
  for (const [name, gas] of Object.entries(GAS)) console.log(`  ${name.padEnd(56)} ${String(gas).padStart(9)} gas  ~${cost(gas, price).toFixed(4)} USDC`);

  const day = cost(GAS['Publish 3 markets, ONE transaction (agent, daily)'] + 3 * GAS['Resolve a market (agent, hash-pointer evidence)'], price);
  const dayWithPayouts = day + 3 * cost(GAS['Pay out one market, 10 winners via claimBatch (agent)'], price);
  const deploy = cost(GAS['Deploy the contract (once)'], price);
  console.log(`\n  Agent running cost per day (3 markets + 3 resolutions): ~${day.toFixed(4)} USDC; with automatic payouts to ~10 winners each: ~${dayWithPayouts.toFixed(4)} USDC`);
  console.log(`  After deploying (${deploy.toFixed(4)} USDC), ${budget} USDC covers about ${Math.max(0, Math.floor((budget - deploy) / dayWithPayouts))} day(s) with payouts, or ${Math.max(0, Math.floor((budget - deploy) / day))} without (AGENT_AUTO_PAYOUT=false).`);
  console.log('  These are estimates from measured gas and the current price; run it again before you deploy.\n');
  process.exit(0);
})();
