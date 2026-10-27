# Chronos: agent, auto-payouts, wallet, auth and UI: how to apply

Unzip over the repo root (paths match the repo), then:

    npm install @google/genai
    cp .env.example .env               # set the values below
    npm run build                      # rebuilds public/css/build.css
    node server.js                     # HTTP
    node worker.js                     # agents + queues (separate process)

## 1. Redeploy the contract (required for automatic payouts)
`contracts/Chronos.sol` adds push payouts to your contract: `claimWinningsFor`, `claimRefundFor` and `claimBatch`.
The deployed contract only lets each winner claim for themselves, so it cannot pay people automatically.
Funds always go to the participant, never to the caller, so these functions are safe to leave open.

- Compile with `viaIR: true` (the original contract needs it too).
- Constructor is unchanged: `(usdc, oracle, treasury, feeBps, gracePeriod, owner)`. `oracle` = the wallet in `ORACLE_PRIVATE_KEY`.
- Set `VITE_FACTORY_ADDRESS` to the new address. Existing markets stay on the old contract, so use a fresh database
  (or clear `predictions`, `evidence`, `resolutionJobs`, `payouts`, `marketProposals`) for the new deployment.
- Regenerate `contracts/contract-metadata/Chronos.json` from your build.
- Do not point the new backend at the OLD contract with auto-payout on: set `AGENT_AUTO_PAYOUT=false` there.

## 2. `.env`
- `ARC_NETWORK=testnet|mainnet`, `VITE_FACTORY_ADDRESS`, `ORACLE_PRIVATE_KEY` (pays gas, including payout gas)
- `SESSION_SECRET` (32+ chars), a non-default `WORKER_SECRET`, `GEMINI_API_KEY`, `PARALLEL_API_KEY`
- Payouts: `AGENT_AUTO_PAYOUT=true`, `AGENT_PAYOUT_BATCH_SIZE=25` (max 100), `AGENT_PAYOUT_MAX_ATTEMPTS=5`
- `TRUST_PROXY=true` behind a reverse proxy

## 3. How automatic payouts work
When the agent resolves or cancels a market it queues a payout job. `src/agent/payouts.js` finds every participant from the
chain's `SharesPurchased` logs, checks on-chain who is still owed, and calls `claimBatch` in chunks. Each result is verified
on-chain; an address that can't receive funds (for example a token blocklist) is retried with backoff and then marked
"stuck" without blocking anyone else (that person can still use the Claim button). The keeper re-queues any settled market
that isn't fully paid. Running it twice is harmless.

## 4. Tests
    node test/agent.test.js && node test/auth.test.js && node test/payouts.test.js && node test/frontend.test.mjs   # npm i -D jsdom
    cd test/contract            # real-EVM contract tests: see test/contract/README.md

## 5. Latest changes (read this if you applied an earlier zip)
- **Redeploy the contract again**: `contracts/Chronos.sol` now also has `createMarkets` (several markets in ONE transaction). Compile with `viaIR: true`.
- Approved questions are saved to the database as `pending` first and published on-chain from there; failures retry automatically (`src/agent/publish.js`).
- The agent keeps trying to resolve until the deadline, makes one final bigger attempt before it, and refunds only as a last resort.
- Gas: short on-chain text, 80-byte evidence hash pointer (full evidence at `GET /api/markets/:id/evidence.json`), no wasteful `closeTrading`, per-transaction cost cap.
- Arc RPC: both official hostnames are tried automatically; testnet explorer is `testnet.arcscan.app`.
- Tokens: client-side Gemini rate limit (`GEMINI_MAX_RPM`), waits the retry time the API asks for, shrinks old search results, caps proposals per run.
- Worldwide discovery: each run explores different regions/themes; no website allowlist.
- New scripts: `scripts/check-setup.js`, `scripts/estimate-costs.js`, `scripts/trigger.js`.
- Tests (all run in seconds): `for t in agent persistence publish payouts misc auth; do node test/$t.test.js; done`

## 6. Stakes, positions and stats (latest)
Why positions weren't showing: nothing ever stored a stake. The keeper only copied market pools every 15 minutes, and
"My positions" reads a `positions` collection that no code was filling. Now:
- `src/services/indexer.js` records every stake and payout from the chain. The browser calls `POST /api/positions/record` the moment a
  buy confirms (the server re-reads the chain itself), and the keeper's indexer catches everything else from a saved block cursor.
- Each question's pools, volume, stakers and positions update immediately; positions are re-read from the chain, never computed.
- New: `GET /api/stats` (TVL from the chain, total staked, resolved, paid to winners), `GET /api/positions/:address` now includes a
  summary, and `GET /api/positions/:address/trades` lists every stake with its position ID.
- A market with no stakes shows "No stakes yet" instead of 50%.
- Wallet connection survives page reloads, even if the wallet loads late.
- Favicon set added (`public/favicon.svg|ico`, PNGs) and wired into the page and `/favicon.ico`.
- **Position ID**: the contract has no position ids, so the ID is `<marketId>-<first 8 hex of the transaction>`.
- After updating, run `node scripts/trigger.js keeper` once so the indexer backfills older stakes (it starts near the oldest market).
