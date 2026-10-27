# Moving Chronos to mainnet

Mainnet means real USDC. Do these in order and don't skip the first two.

## 0. Before anything
1. **Confirm Arc mainnet is live and copy the official values** from Arc's docs ("Connect to Arc"): chain ID, RPC URL, explorer, and the
   **mainnet USDC token address**. The presets in `src/config.js` (chain 5042, `rpc.mainnet.arc.io`, `explorer.arc.io`) come from public
   docs that were not fully consistent; override anything that differs with `ARC_CHAIN_ID`, `ARC_RPC_URL`, `ARC_EXPLORER_URL`, `VITE_ARC_USDC_ADDRESS`.
2. **Get the contract reviewed.** `contracts/Chronos.sol` is tested but NOT audited. At minimum have it reviewed, or start with a hard cap on how much you let in.

## 1. New wallets (never reuse testnet keys)
| Wallet | Used for | Where the key lives |
|---|---|---|
| **Owner** | pause switch, fee settings | a hardware wallet or multisig, NOT on the server |
| **Oracle** | creates markets, resolves, pays out (pays gas in USDC) | the server's `.env` only |
| **Treasury** | receives the protocol fee | any address you control (multisig is best) |

Fund the **oracle** with a little real USDC for gas, and the owner with enough to deploy.

## 2. See what it will cost, then deploy
```bash
ARC_NETWORK=mainnet node scripts/estimate-costs.js --budget 1
```
Deploy `contracts/Chronos.sol` (compile with `viaIR: true`). Constructor: `(usdc, oracle, treasury, feeBps, gracePeriod, owner)`:
`usdc` = the official mainnet USDC, `oracle` = your oracle wallet, `treasury` = fee address, `feeBps` = 500 for 5%, `owner` = the owner wallet.
Save the deployed address.

## 3. Configure a clean environment
```ini
ARC_NETWORK=mainnet
VITE_FACTORY_ADDRESS=0x...            # the NEW mainnet contract
VITE_ARC_USDC_ADDRESS=0x...           # from Arc's docs
ORACLE_PRIVATE_KEY=...                # the new oracle key
SESSION_SECRET=...                    # openssl rand -hex 32   (required on mainnet)
WORKER_SECRET=...                     # anything except the default (required on mainnet)
CORS_ORIGINS=https://your-domain.com
TRUST_PROXY=true                      # behind HTTPS / a reverse proxy
MONGODB_DB_NAME=chronos_mainnet       # a NEW database: never mix testnet data in
REDIS_DB=1                            # or flush Redis, so old testnet jobs don't run
```
Serve the site over **HTTPS** (wallet sign-in cookies are `Secure`).

## 4. Check everything before starting
```bash
node scripts/check-setup.js
```
It must end with "All good". It verifies: chain ID, RPC reachability, a contract exists at your address, it is not paused, **your wallet is the
contract's oracle**, the contract's **token is real USDC with 6 decimals**, the oracle has gas, and the keys are set.

## 5. Start small
```ini
AGENT_MAX_MARKETS_PER_DAY=1           # raise later
AGENT_MAX_TX_COST_USDC=0.10           # refuse any unexpectedly expensive transaction
AGENT_AUTO_PAYOUT=false               # optional while funds are tight: winners claim (they pay their own gas)
```
1. `npm run build && npm start` and `npm run start:worker`.
2. `node scripts/trigger.js discovery` and watch the worker log.
3. With a small amount (the minimum stake is 0.10 USDC), stake once yourself, and confirm it shows in My positions and the stats.
4. Let one market run through resolve and payout before inviting anyone.

## 6. Keep it healthy
- Watch the oracle wallet's USDC balance. If it hits zero, publishing and resolving stop, and markets can only be refunded after the deadline.
- Check the Oracle page and the `agentRuns` collection daily for refusals and errors.
- Back up MongoDB. Rotate the oracle key if it is ever exposed (the owner can set a new oracle).
- Know your local rules: prediction markets are restricted in some places.
