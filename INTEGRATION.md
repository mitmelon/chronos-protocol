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
