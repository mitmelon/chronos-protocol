# Chronos Protocol

**Predict the future. Verify the outcome.**

An autonomous, event-driven binary prediction market on Arc. Users stake USDC on YES or NO outcomes. An AI agent discovers events, creates markets, gathers multi-source evidence, and submits verifiable resolutions on-chain. Smart contracts enforce all financial rules.

> Testnet only. Never deploy to mainnet without an independent audit.

---

## Project Structure

```
/
├── server.js                  # HTTP entry point  →  node server.js
├── worker.js                  # BullMQ worker     →  node worker.js
├── tailwind.config.js         # Tailwind build config
├── package.json
├── .env.example               # Copy to .env and fill in values
│
├── contracts/                 # Solidity — never moved, stays at root
│   ├── Chronos.sol            # Core prediction market contract
│   ├── test/Chronos.t.sol     # 59 Foundry unit tests
│   ├── test-helpers/          # MockERC20 for tests
│   └── contract-metadata/     # Deployment metadata
│
├── public/                    # Browser-served static assets
│   ├── css/                   # build.css generated here (git-ignored)
│   ├── js/                    # Client-side ES modules
│   │   ├── app.js             # SPA router + boot
│   │   ├── wallet.js          # EIP-1193 wallet + Arc chain helpers
│   │   ├── api.js             # REST API client
│   │   ├── utils.js           # Shared helpers
│   │   └── pages/             # One module per page
│   │       ├── overview.js
│   │       ├── markets.js
│   │       ├── market-detail.js
│   │       ├── positions.js
│   │       ├── resolutions.js
│   │       ├── agent.js
│   │       └── settings.js
│   └── images/
│       └── logo.svg
│
└── src/                       # Server-side source — never served directly
    ├── server.js              # Fastify buildServer() factory (not an entry point)
    ├── config.js              # All env vars: Arc, MongoDB, Redis, agent, protocol
    │
    ├── views/
    │   └── index.ejs          # Single EJS template — landing page + app shell
    │                          # Runtime config injected by server (no secrets in view)
    │
    ├── routes/                # Fastify route plugins
    │   ├── health.js
    │   ├── markets.js
    │   ├── positions.js
    │   ├── resolutions.js
    │   ├── agent.js
    │   └── settings.js
    │
    ├── services/              # External integrations
    │   ├── contract.js        # viem client — on-chain reads + oracle writes
    │   ├── gemini.js          # Gemini AI — question generation + resolution proposals
    │   ├── parallel.js        # Parallel Search API — event discovery + evidence
    │   └── evidence.js        # Evidence processing + IPFS URI builder
    │
    ├── agent/                 # Pure job logic — no scheduling here
    │   ├── discover.js        # Find events → validate → publish markets
    │   ├── resolve.js         # Gather evidence → propose → submit on-chain
    │   └── keeper.js          # Sync DB state, call closeTrading for expired markets
    │
    ├── queues/                # BullMQ (Redis-backed job queues)
    │   ├── client.js          # Queue definitions (discovery, resolution, keeper)
    │   ├── workers.js         # Worker processors — one per queue
    │   └── scheduler.js       # Registers repeatable jobs on startup
    │
    ├── db/
    │   ├── client.js          # MongoDB connection
    │   └── indexes.js         # Collection indexes + uniqueness guards
    │
    └── middleware/
        ├── auth.js            # Worker-secret guard for internal routes
        └── rateLimit.js       # Rate-limit config per route group
```

---

## Smart Contract

**`contracts/Chronos.sol`** — single non-upgradeable contract deployed on Arc Testnet.

### Market lifecycle

```
Open → TradingClosed → Resolved → Settled
                     ↘ Refundable
```

| State | Description |
|---|---|
| Open | Accepting USDC positions |
| TradingClosed | Deadline passed, awaiting oracle |
| Resolved | Oracle submitted outcome; winners can claim |
| Refundable | Oracle missed deadline — full refunds available |
| Settled | All winnings claimed or swept to treasury |

### Payout formula

```
grossPayout = userShares × totalPool / winningPool
profit      = grossPayout − originalStake
fee         = profit × feeBps / 10_000     ← only on profit, never on stake
netPayout   = grossPayout − fee
```

Fee is zero when there is no profit (e.g. everyone bet the same side).
Fees accumulate in `pendingFees`; anyone can call `withdrawFees()` to push them to treasury.

### Security highlights

- CEI ordering + `nonReentrant` on every fund-touching function
- `feeBps` snapshotted per market at creation — owner cannot retroactively change fee
- `pendingFees` accumulator decouples winner claims from treasury reachability
- Pause blocks only fund-entry (`createMarket`, `buyShares`); exit paths always open
- `markRefundable` and `claimRefund` callable even while paused (oracle-miss safety)
- USDC rescue guarded: only excess above `totalActivePools + pendingFees`
- `initialOwner` constructor param — use a multisig in production

### Build & test

```bash
# Compile
forge build

# Run all 59 tests
forge test -vvv

# Coverage
forge coverage --report summary
```

---

## Running the App

### 1. Prerequisites

- Node.js 20+
- MongoDB (local or Atlas)
- Redis (local or Redis Cloud) — required by BullMQ
- A funded Arc Testnet wallet (oracle key)

### 2. Environment

```bash
cp .env.example .env
```

Fill in `.env`. Required before any server starts:

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `REDIS_HOST` / `REDIS_PORT` | Redis for BullMQ |
| `GEMINI_API_KEY` | Google Gemini API key |
| `PARALLEL_API_KEY` | Parallel Search API key |
| `ORACLE_PRIVATE_KEY` | Private key of the oracle wallet |
| `PROTOCOL_TREASURY` | Address to receive protocol fees |
| `VITE_FACTORY_ADDRESS` | Deployed `Chronos.sol` address (after deploy) |

### 3. Install dependencies

```bash
npm install
```

### 4. Build Tailwind CSS

```bash
npm run build:css
```

This compiles `src/css/tailwind.css` → `public/css/build.css`. Run once before starting the server, and re-run after editing EJS templates or adding new Tailwind classes. For active development:

```bash
npm run watch:css
```

### 5. Deploy the contract

The `Chronos.sol` constructor takes:

```
_usdc:         0x3600000000000000000000000000000000000000  (Arc USDC)
_oracle:       <oracle wallet address>
_treasury:     <treasury wallet address>
_feeBps:       500   (5%)
_gracePeriod:  15552000   (180 days in seconds)
initialOwner:  <deployer or multisig address>
```

After deploy, set `VITE_FACTORY_ADDRESS` in `.env`.

### 6. Start the HTTP server

```bash
node server.js          # production
node --watch server.js  # dev (restarts on file change)
```

The server renders `src/views/index.ejs` at `/`, serving the landing page and SPA shell. Public config values (contract address, chain ID, network name) are injected at render time from `src/config.js`. No secrets are ever passed to the view.

### 7. Start background workers (separate process)

```bash
node worker.js          # production
node --watch worker.js  # dev
```

The worker connects to Redis, registers three BullMQ queues, and schedules repeatable jobs:

| Job | Default schedule | Description |
|---|---|---|
| `discovery` | 09:00 UTC daily | Find events, validate, publish ≤3 markets |
| `resolution` | Every 30 min | Gather evidence, propose resolution, submit on-chain |
| `keeper` | Every 15 min | Close expired markets, sync DB from chain |

BullMQ stores repeat-job state in Redis — schedules survive worker restarts without creating duplicates.

Trigger a job manually via the internal API:

```bash
curl -X POST http://localhost:3000/internal/agent/trigger-discovery \
  -H "Authorization: Bearer $WORKER_SECRET"
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Health check + DB/chain status |
| GET | `/api/protocol/status` | Protocol stats |
| GET | `/api/markets` | Paginated markets (`state`, `category`, `sort`, `search`) |
| GET | `/api/markets/:id` | Full market detail |
| GET | `/api/markets/:id/evidence` | Oracle evidence bundle |
| GET | `/api/markets/:id/trades` | Trade history |
| GET | `/api/positions/:address` | Wallet positions |
| GET | `/api/positions/:address/claimable` | Claimable payouts |
| GET | `/api/resolutions` | Resolution archive |
| GET | `/api/agent/runs` | Agent run history |
| GET | `/api/agent/daily-report` | Today's agent activity |
| GET | `/api/settings/public` | Public protocol configuration |

---

## Frontend

Seven pages in a single EJS-rendered SPA shell:

| Page | Route | Description |
|---|---|---|
| Overview | `#overview` | Protocol stats, open markets, recent resolutions, wallet positions |
| Explore Markets | `#markets` | Searchable/filterable market cards with YES/NO prices |
| Market Detail | `#market/:id` | Question, evidence, countdown, trade panel |
| My Positions | `#positions` | Stakes, outcomes, claimable payouts |
| Agent Intelligence | `#agent` | Discovery runs, evidence, resolution history |
| Resolution Archive | `#resolutions` | Resolved, cancelled, and disputed markets |
| Settings | `#settings` | Wallet info, network status, protocol config |

Runtime config (contract address, chain ID, fee %) is injected by the server into the EJS template — no secrets ever reach the browser.

---

## MongoDB Collections

| Collection | Description |
|---|---|
| `predictions` | Market records synced from chain + agent metadata |
| `evidence` | Oracle evidence bundles per market |
| `positions` | Cached wallet positions |
| `resolutionJobs` | BullMQ job tracking for resolution workflow |
| `agentRuns` | Agent run history (discovery, resolution, keeper) |
| `protocolSettings` | Configurable protocol parameters |

---

## Testnet

Chain ID: **5042002** (Arc Testnet)
Get test USDC from the Arc Studio sidebar ("Get test USDC").

**Never deploy to mainnet without an independent professional audit.**
