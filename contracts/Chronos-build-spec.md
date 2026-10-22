# Chronos Protocol — Build Specification v2

**Tagline:** Predict the future. Verify the outcome.

**Status:** Ready to build  
**Chain:** Arc Testnet (chain ID 5042002) → Arc Mainnet (chain ID 5042)  
**Date:** 2026-10-22

---

## Table of Contents

1. [Product Summary](#1-product-summary)
2. [Technology Stack](#2-technology-stack)
3. [Project Structure](#3-project-structure)
4. [Smart Contracts](#4-smart-contracts)
5. [Backend & Database](#5-backend--database)
6. [Autonomous Agent](#6-autonomous-agent)
7. [Frontend](#7-frontend)
8. [Configuration & Security](#8-configuration--security)
9. [Delivery Checklist](#9-delivery-checklist)
10. [Build Order](#10-build-order)
11. [Payout Formula Reference](#11-payout-formula-reference)

---

## 1. Product Summary

Chronos is a decentralized YES/NO prediction market protocol on Arc. Users connect their wallets, browse future-event predictions, stake USDC on YES or NO, and receive payouts when markets resolve. An autonomous AI agent discovers suitable events, creates markets, gathers verifiable evidence, and submits resolutions. Smart contracts enforce all financial rules; the database caches operational data; the frontend presents everything as a polished financial intelligence terminal.

**Arc-specific advantage**: USDC is the native gas token on Arc, so every transaction fee is paid in USDC. There is no separate ETH or MATIC balance to manage. The USDC contract lives at `0x3600000000000000000000000000000000000000` on both Arc Mainnet and Arc Testnet.

**Blockchain is the financial source of truth.** The database caches and indexes for speed; it never overrides on-chain state for balances, positions, or outcomes.

---

## 2. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Blockchain | Arc Testnet (dev), Arc Mainnet (prod) | EVM-compatible, USDC-native |
| Contracts | Solidity 0.8.24, Foundry | OpenZeppelin v5.x; no proxy in v1 |
| Backend | Node.js, Fastify, CommonJS (`require()`) | Modular route structure |
| Database | MongoDB | Operational cache; not financial source of truth |
| AI reasoning | Google Gemini API | Question generation, validation, resolution proposals |
| Discovery | Parallel Search API | Trending topics, credible sources |
| Frontend | Semantic HTML5, Tailwind CSS (production build), vanilla JS ES modules | No React, Vue, or other frameworks |
| Wallet connection | ethers.js v6 or viem | Browser-side; MetaMask / EIP-1193 providers |

No frontend frameworks. No CDN Tailwind. Production-built Tailwind CSS only.

---

## 3. Project Structure

```
chronos/
├── contracts/
│   ├── src/
│   │   └── Chronos.sol              # Main protocol contract
│   ├── test/
│   │   ├── Chronos.t.sol            # Foundry unit + fuzz tests
│   │   └── ChronosIntegration.t.sol # Full lifecycle integration tests
│   ├── script/
│   │   └── Deploy.s.sol             # Forge deployment script (Arc Testnet)
│   └── foundry.toml
│
├── backend/
│   ├── server.js                    # Fastify entry point
│   ├── config.js                    # Env-based config loader
│   ├── db/
│   │   ├── client.js                # MongoDB connection
│   │   └── indexes.js               # Collection index definitions
│   ├── routes/
│   │   ├── health.js
│   │   ├── markets.js
│   │   ├── positions.js
│   │   ├── resolutions.js
│   │   ├── agent.js
│   │   └── settings.js
│   ├── services/
│   │   ├── contract.js              # viem/ethers contract client
│   │   ├── gemini.js                # Gemini API wrapper
│   │   ├── parallel.js              # Parallel Search API wrapper
│   │   └── evidence.js              # Evidence gathering + hashing
│   ├── agent/
│   │   ├── scheduler.js             # Cron-based job scheduler
│   │   ├── discover.js              # Step 1: event discovery
│   │   ├── validate.js              # Step 2: question validation + dedup
│   │   ├── publish.js               # Step 3: market creation on-chain
│   │   ├── resolve.js               # Step 4: evidence gathering + resolution
│   │   └── keeper.js                # Step 5: closeTrading / markRefundable keeper
│   └── middleware/
│       ├── auth.js                  # Worker auth (shared secret)
│       └── rateLimit.js
│
├── frontend/
│   ├── index.html                   # Overview page
│   ├── explore.html                 # Explore Markets
│   ├── market.html                  # Market Details (param: ?id=)
│   ├── positions.html               # My Positions
│   ├── agent.html                   # Agent Intelligence
│   ├── archive.html                 # Resolution Archive
│   ├── settings.html                # Settings
│   ├── tailwind.config.js           # Tailwind config
│   ├── package.json                 # Build scripts only
│   ├── src/
│   │   ├── css/
│   │   │   └── main.css             # Tailwind source; design tokens; component styles
│   │   └── js/
│   │       ├── config.js            # Frontend config (RPC, contract address, API base)
│   │       ├── wallet.js            # EIP-1193 wallet connection + Arc chain switching
│   │       ├── contract.js          # Read/write contract interactions (ethers.js v6)
│   │       ├── api.js               # Fetch wrapper for backend API
│   │       ├── format.js            # USDC formatting, countdown, percentages
│   │       ├── components.js        # Shared UI components (market card, status badge, etc.)
│   │       ├── overview.js          # Overview page logic
│   │       ├── explore.js           # Explore Markets logic
│   │       ├── market.js            # Market Details logic
│   │       ├── positions.js         # My Positions logic
│   │       ├── agent.js             # Agent Intelligence logic
│   │       ├── archive.js           # Resolution Archive logic
│   │       └── settings.js          # Settings logic
│   └── dist/                        # Built Tailwind output (gitignored, generated)
│
├── .env.example
├── .gitignore
├── package.json                     # Root scripts: install, dev, build, test
└── README.md
```

---

## 4. Smart Contracts

### 4.1 Contract: `Chronos.sol`

Single non-upgradeable contract. Refer to `Chronos-design.md` for the full security spec. This section defines what to implement.

**USDC address**: `0x3600000000000000000000000000000000000000` — same on Arc Mainnet and Testnet. Set as an immutable in the constructor.

**Inherits**:
- `Ownable2Step` (OZ v5) — two-step owner transfer; override `renounceOwnership` to revert
- `Pausable` (OZ v5)
- `ReentrancyGuard` (OZ v5)
- `SafeERC20` used for all USDC transfers

#### Enums and Structs

```solidity
enum Outcome    { UNRESOLVED, YES, NO }
enum MarketState { Open, TradingClosed, Resolved, Refundable, Settled }

struct Market {
    string      question;
    string      resolutionCriteria;  // immutable rules set at creation
    uint64      tradingDeadline;
    uint64      resolutionDeadline;
    uint256     yesPool;
    uint256     noPool;
    uint256     totalPool;           // cached when trading closes
    uint256     settledAmount;       // accumulated winnings + fees paid out
    Outcome     outcome;
    MarketState state;
    uint64      resolvedAt;
    string      evidenceURI;
    bool        swept;
    address     creator;
}
```

#### Storage

```solidity
uint256 public marketCount;
mapping(uint256 => Market)                            public markets;
mapping(uint256 => mapping(address => uint256))       public yesShares;
mapping(uint256 => mapping(address => uint256))       public noShares;
mapping(uint256 => mapping(address => bool))          public claimed;

address public oracle;
address public treasury;
uint256 public feeBps;        // default 500 (5%)
uint256 public gracePeriod;   // default 180 days

IERC20 public immutable usdc;
```

#### Fee Formula

```
profit        = grossPayout - originalStake
fee           = profit * feeBps / 10_000
netPayout     = originalStake + profit - fee
```

Where:
- `grossPayout = winnerShares * totalPool / winningPool`
- `originalStake = winnerShares` (1 share = 1 USDC staked)
- `profit = grossPayout - originalStake`
- Fee is charged only on profit, never on the returned original stake

> This differs from the simpler total-pool fee in the initial design doc. The build spec takes precedence: fee is on winners' profit only, never on their returned stake or losing positions.

**Implementation note**: Fee calculation must use integer arithmetic without loss. Round down for the user (i.e. round fee down — user gets more). Verify no underflow is possible: `grossPayout >= originalStake` is guaranteed when the winning pool is ≤ the total pool, which holds by construction.

#### Functions to Implement

| Function | Visibility | Guards | Description |
|---|---|---|---|
| `createMarket(question, resolutionCriteria, tradingDeadline, resolutionDeadline)` | external | `whenNotPaused` | Creates a market; returns `marketId`. Both question and resolutionCriteria become immutable. |
| `buyShares(marketId, outcome, amount)` | external | `whenNotPaused`, `nonReentrant` | Pull-transfers USDC from caller; adds to pool. Only while state == Open and before tradingDeadline. |
| `closeTrading(marketId)` | external | — | Anyone may call after tradingDeadline. Advances Open → TradingClosed; caches totalPool. |
| `resolveMarket(marketId, outcome, evidenceURI)` | external | `onlyOracle` | Oracle only. Advances TradingClosed → Resolved; stores evidenceURI. |
| `markRefundable(marketId)` | external | — | Anyone may call after resolutionDeadline if not yet resolved. Advances Open/TradingClosed → Refundable. |
| `claimWinnings(marketId)` | external | `nonReentrant` | Winner pulls their netPayout = stake + profit − fee. Fee goes to treasury. CEI enforced. |
| `claimRefund(marketId)` | external | `nonReentrant` | Returns full stake when state == Refundable. |
| `sweepUnclaimed(marketId)` | external | `onlyOwner`, `nonReentrant` | After gracePeriod. Sweeps remaining attributable USDC to treasury. |
| `setOracle(address)` | external | `onlyOwner` | Non-zero; emits OracleUpdated. |
| `setTreasury(address)` | external | `onlyOwner` | Non-zero; emits TreasuryUpdated. |
| `setFeeBps(uint256)` | external | `onlyOwner` | 0–1000 bps (max 10%); emits FeeUpdated. |
| `setGracePeriod(uint256)` | external | `onlyOwner` | ≥ 1 day; emits GracePeriodUpdated. |
| `pause()` / `unpause()` | external | `onlyOwner` | Inherited. |
| `rescueTokens(address token, address to, uint256 amount)` | external | `onlyOwner` | If token == usdc, only excess above sum of all active pools. |
| `getMarket(uint256)` | external view | — | Returns full Market struct. |
| `getShares(uint256, address)` | external view | — | Returns (yesShares, noShares). |
| `computeWinnings(uint256, address)` | external view | — | Preview netPayout and feeSlice before claiming. |

#### Events

```solidity
event MarketCreated(uint256 indexed marketId, address indexed creator, string question, uint64 tradingDeadline, uint64 resolutionDeadline);
event SharesPurchased(uint256 indexed marketId, address indexed buyer, uint8 outcome, uint256 amount);
event TradingClosed(uint256 indexed marketId, uint256 totalPool);
event MarketResolved(uint256 indexed marketId, uint8 outcome, string evidenceURI, uint64 timestamp);
event MarketRefundable(uint256 indexed marketId);
event WinningsClaimed(uint256 indexed marketId, address indexed claimant, uint256 netPayout, uint256 originalStake, uint256 profit, uint256 fee);
event FeePaid(uint256 indexed marketId, address treasury, uint256 amount);
event RefundClaimed(uint256 indexed marketId, address indexed claimant, uint256 amount);
event UnclaimedSwept(uint256 indexed marketId, address treasury, uint256 amount);
event OracleUpdated(address oldOracle, address newOracle);
event TreasuryUpdated(address oldTreasury, address newTreasury);
event FeeUpdated(uint256 oldBps, uint256 newBps);
event GracePeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
event TokensRescued(address token, address to, uint256 amount);
```

### 4.2 Deployment Script (`script/Deploy.s.sol`)

Reads constructor args from environment:
- `USDC_ADDRESS` — defaults to `0x3600000000000000000000000000000000000000`
- `ORACLE_ADDRESS`
- `TREASURY_ADDRESS`
- `FEE_BPS` — defaults to 500
- `GRACE_PERIOD` — defaults to 15552000 (180 days)

Logs the deployed address. Writes it to `deployments/arc-testnet.json` for consumption by the backend and frontend.

### 4.3 Tests (`test/Chronos.t.sol`, `test/ChronosIntegration.t.sol`)

#### Unit tests (minimum coverage)

- `createMarket`: valid, empty question, question > 1024 bytes, past deadline, tradingDeadline >= resolutionDeadline
- `buyShares`: valid YES, valid NO, zero amount, wrong state, after tradingDeadline, USDC transfer failure (mock)
- `closeTrading`: before deadline (revert), after deadline, already closed (revert)
- `resolveMarket`: valid YES, valid NO, non-oracle (revert), wrong state (revert), after resolutionDeadline (revert), UNRESOLVED outcome (revert)
- `markRefundable`: before deadline (revert), valid, wrong state (revert)
- `claimWinnings`: winning side, losing side (revert), double-claim (revert), fee math correctness, zero-profit edge case
- `claimRefund`: valid, double-refund (revert), wrong state (revert)
- `sweepUnclaimed`: before grace (revert), valid, already swept (revert)
- Admin setters: valid, zero address (revert), fee > 1000 bps (revert)
- Pause: blocks buyShares and createMarket; allows claimWinnings and claimRefund
- `rescueTokens`: other token freely, USDC only excess

#### Fuzz / invariant tests

- Invariant: `sum(all active pools) <= usdc.balanceOf(Chronos)`
- Fuzz: random YES/NO amounts, random claim orderings, random fee settings
- Fee invariant: for any resolved market, `sum(netPayouts) + sum(fees) + unclaimed_residual == totalPool`

#### Integration test scenarios

1. Full YES win: create → buy YES/NO → closeTrading → resolveYES → all claim → verify balance zero
2. Full NO win: same but resolveNO
3. One-sided market (all YES, none NO): resolve YES → winner gets full pool minus fee on profit
4. Refund lifecycle: create → buy → skip resolution deadline → markRefundable → all refund → verify zero
5. Partial claim + sweep: some users claim, owner sweeps after grace period
6. Reentrancy attempt: malicious contract tries to re-enter claimWinnings — must revert

---

## 5. Backend & Database

### 5.1 Server (`backend/server.js`)

Fastify server, CommonJS. Registers:
- CORS (configurable origins)
- Rate limiting (via `@fastify/rate-limit`)
- Request validation (via Fastify's built-in JSON Schema)
- Error handler (consistent `{ error, message, code }` shape)
- All route plugins

Starts MongoDB connection before listening.

### 5.2 MongoDB Collections & Indexes

#### `predictions`
Mirrors on-chain market data, enriched with off-chain metadata.

```javascript
{
  marketId: Number,           // on-chain ID (unique)
  contractAddress: String,    // Chronos contract address
  chainId: Number,
  txHash: String,             // createMarket tx hash
  question: String,
  resolutionCriteria: String,
  category: String,           // e.g. "Finance", "Politics", "Technology"
  tags: [String],
  tradingDeadline: Date,
  resolutionDeadline: Date,
  yesPool: String,            // stringified BigInt (USDC 6-dec)
  noPool: String,
  totalPool: String,
  state: String,              // Open | TradingClosed | Resolved | Refundable | Settled
  outcome: String,            // UNRESOLVED | YES | NO
  evidenceURI: String,
  resolvedAt: Date,
  createdAt: Date,
  agentRunId: String,         // which agent run created this
  syncedBlock: Number         // last block synced from chain
}
```

Indexes: `{ marketId: 1 }` unique; `{ state: 1 }`, `{ tradingDeadline: 1 }`, `{ resolutionDeadline: 1 }`, `{ tags: 1 }`, `{ createdAt: -1 }`.

#### `evidence`
```javascript
{
  marketId: Number,
  resolutionJobId: String,
  sources: [{
    url: String,
    fetchedAt: Date,
    excerpt: String,
    contentHash: String,  // SHA-256 of full page content
    outcome: String,      // what this source supports
    credibility: String   // "high" | "medium" | "low"
  }],
  geminiReasoning: String,
  proposedOutcome: String,
  confidence: Number,     // 0.0–1.0
  conflictDetected: Boolean,
  submittedOnChain: Boolean,
  txHash: String,
  createdAt: Date
}
```

Indexes: `{ marketId: 1 }` unique; `{ submittedOnChain: 1 }`.

#### `positions`
Cached from on-chain events. Not the source of truth — used for fast read.

```javascript
{
  marketId: Number,
  address: String,       // checksummed
  yesShares: String,     // stringified BigInt
  noShares: String,
  claimed: Boolean,
  netPayout: String,     // populated post-claim
  txHashes: [String],    // buyShares tx hashes
  updatedAt: Date
}
```

Indexes: `{ address: 1, marketId: 1 }` unique; `{ address: 1 }`.

#### `resolutionJobs`
```javascript
{
  marketId: Number,
  status: String,   // pending | in_progress | completed | failed | cancelled
  attempts: Number,
  lastAttemptAt: Date,
  errorLog: [String],
  evidenceId: ObjectId,
  txHash: String,
  completedAt: Date,
  createdAt: Date
}
```

Indexes: `{ marketId: 1 }` unique; `{ status: 1 }`.

#### `agentRuns`
```javascript
{
  runId: String,
  type: String,           // "discovery" | "resolution" | "keeper"
  status: String,         // running | completed | failed
  startedAt: Date,
  completedAt: Date,
  marketsDiscovered: Number,
  marketsPublished: Number,
  marketsResolved: Number,
  errors: [String],
  geminiTokensUsed: Number,
  log: [{ timestamp: Date, message: String, level: String }]
}
```

Indexes: `{ runId: 1 }` unique; `{ type: 1, startedAt: -1 }`.

#### `protocolSettings`
```javascript
{
  key: String,    // unique
  value: Mixed,
  updatedAt: Date,
  updatedBy: String
}
```

Index: `{ key: 1 }` unique.

### 5.3 API Routes

All routes return `Content-Type: application/json`. All errors return `{ error: true, message: String, code: String }`.

**Public routes** (no auth):

```
GET  /health                          → { status, uptime, db, chain, blockNumber }
GET  /api/protocol/status             → { feeBps, treasury, oracle, paused, marketCount, totalVolumeUSDC }
GET  /api/markets                     → paginated list; filters: state, category, search, sort
GET  /api/markets/:id                 → full market detail + evidence summary
GET  /api/markets/:id/evidence        → full evidence object
GET  /api/markets/:id/trades          → SharesPurchased events for market (paginated)
GET  /api/positions/:address          → all positions for a wallet address
GET  /api/positions/:address/claimable → positions where claimed=false and state=Resolved/Refundable
GET  /api/resolutions                 → archive; filters: outcome, dateRange, category
GET  /api/agent/runs                  → recent agent runs (last 30)
GET  /api/agent/runs/:runId           → single run detail + log
GET  /api/agent/daily-report          → today's discovery + resolution summary
GET  /api/settings/public             → feeBps, gracePeriodDays, usdcAddress, contractAddress
```

**Internal routes** (worker auth — shared secret in `Authorization: Bearer <WORKER_SECRET>` header):

```
POST /internal/agent/trigger-discovery  → manually trigger discovery run
POST /internal/agent/trigger-resolution → manually trigger resolution check
POST /internal/sync/markets             → re-sync all markets from chain events
POST /internal/sync/market/:id          → sync single market
```

### 5.4 Contract Client (`backend/services/contract.js`)

Uses viem (`publicClient` for reads, `walletClient` with oracle private key for writes). Never stores the private key in the database. Reads it exclusively from `process.env.ORACLE_PRIVATE_KEY` at startup.

Provides:
- `getMarket(marketId)` — reads on-chain Market struct
- `getShares(marketId, address)` — reads position
- `resolveMarket(marketId, outcome, evidenceURI)` — signs + sends transaction
- `closeTrading(marketId)` — keeper call
- `markRefundable(marketId)` — keeper call
- Subscribes to `MarketCreated`, `SharesPurchased`, `MarketResolved`, `WinningsClaimed` events to sync the database

---

## 6. Autonomous Agent

The agent is a durable, scheduled worker running inside the backend process. It uses MongoDB for state persistence and idempotency. It never runs two discovery jobs simultaneously (lock via `agentRuns` status).

### 6.1 Schedule

| Job | Cron | Description |
|---|---|---|
| Discovery | `0 9 * * *` (daily 09:00 UTC) | Find and publish up to 3 new markets |
| Resolution check | `*/30 * * * *` (every 30 min) | Resolve any markets whose tradingDeadline has passed and are not yet resolved |
| Keeper | `*/15 * * * *` (every 15 min) | Call `closeTrading` and `markRefundable` for eligible markets |

### 6.2 Discovery Pipeline

```
Step 1 — Parallel Search
  Query: "upcoming verifiable events next 7 days to 1 year"
  Extract: event name, expected date, authoritative sources
  Score: timeliness, verifiability, public interest

Step 2 — Gemini: question generation
  Input: raw event data
  Output: precise YES/NO question, resolution criteria, authoritative source requirements,
          exact timezone + cutoff, trading deadline, resolution deadline
  Prompt must require:
    - Objectively verifiable outcome (no opinion, no ambiguity)
    - At least 2 independent credible sources available at resolution time
    - Resolution criteria include exact metric, threshold, timezone, and source
    - Question is answerable strictly YES or NO with no "maybe" or "it depends"

Step 3 — Validation (Gemini + local rules)
  Reject if:
    - Duplicate question (fuzzy match against existing predictions in DB)
    - Outcome already known at time of question generation
    - Relies on subjective judgment ("will X be better than Y")
    - No reliable authoritative source identified
    - Resolution deadline < 24 hours from now
    - Resolution deadline > 1 year from now
    - Question > 1024 characters
    - resolutionCriteria > 4096 characters

Step 4 — Publish (max 3 per day)
  Create idempotency key = SHA-256(question + tradingDeadline)
  Check: no existing prediction with same key
  Call: Chronos.createMarket(question, resolutionCriteria, tradingDeadline, resolutionDeadline)
  On success: insert into predictions collection with agentRunId
  On failure: retry up to 3 times with exponential backoff; log failure; skip to next candidate
```

### 6.3 Resolution Pipeline

```
Step 1 — Identify resolvable markets
  Query DB: state = TradingClosed OR (state = Open AND tradingDeadline < now)
  Filter: resolutionDeadline > now (still within resolution window)
  Priority: closest to resolutionDeadline first

Step 2 — Evidence gathering
  For each market:
    - Parallel Search: query the market question + authoritative source domains
    - Fetch 3–5 independent sources
    - For each source: extract excerpt, compute SHA-256(content), record URL + timestamp
    - Detect conflicts: if sources disagree, flag conflictDetected=true

Step 3 — Gemini: resolution proposal
  Input: question, resolutionCriteria, all evidence excerpts + metadata
  Output:
    { proposedOutcome: "YES"|"NO"|"UNRESOLVABLE", confidence: 0.0–1.0, reasoning: String }
  Prompt must require:
    - Strict adherence to resolutionCriteria (not general knowledge)
    - If conflictDetected: output UNRESOLVABLE unless one source clearly dominates
    - If confidence < 0.85: output UNRESOLVABLE
    - AI must never fabricate evidence or invent sources

Step 4 — Validate proposal
  If proposedOutcome == UNRESOLVABLE:
    → Do not call resolveMarket
    → If past resolutionDeadline: markRefundable will be triggered by keeper
    → Log reason in resolutionJobs
  If proposedOutcome == YES or NO and confidence >= 0.85:
    → Construct evidenceURI (IPFS or HTTPS endpoint with full evidence JSON)
    → Call Chronos.resolveMarket(marketId, outcome, evidenceURI)
    → Update predictions and resolutionJobs collections
    → Retry on tx failure up to 3 times with exponential backoff

Step 5 — Conflict / insufficient evidence fallback
  If evidence is insufficient and resolutionDeadline has passed:
    → Agent does not call resolveMarket
    → Keeper calls markRefundable
    → Users receive full refunds
```

**AI constraint**: Gemini generates proposals; the oracle wallet submits them. Gemini never has direct access to the oracle private key. The backend validates the proposal before signing.

### 6.4 Keeper Job

```
Every 15 minutes:
  1. closeTrading: find markets where state=Open AND tradingDeadline < now
     Call closeTrading(marketId) for each. Log result.

  2. markRefundable: find markets where state IN (Open, TradingClosed)
     AND resolutionDeadline < now AND not yet resolved
     Call markRefundable(marketId) for each. Log result.
```

---

## 7. Frontend

### 7.1 Design System

**Mode:** Arc Dark — appropriate for a trading, oracle, and data-dense interface.

**Rationale:** Chronos is an intelligence terminal and financial infrastructure product. Arc Dark with deep navy canvas, glass surfaces, and pale blue accents conveys precision and seriousness without generic crypto neon.

**Design tokens** (in `src/css/main.css`, before Tailwind directives):

```css
:root {
  /* Arc Dark palette */
  --bg:             #0d1b2f;
  --bg-gradient:    linear-gradient(180deg, #0d1b2f 0%, #0d1b2f 58%, #122d45 100%);
  --surface:        rgba(255, 255, 255, 0.07);
  --surface-strong: rgba(255, 255, 255, 0.11);
  --surface-muted:  #1f2f44;
  --ink:            #f9faf3;
  --ink-2:          #e3ecf9;
  --muted:          #cbd5e1;
  --subtle:         #94a3b8;
  --border:         rgba(255, 255, 255, 0.12);
  --border-strong:  rgba(203, 219, 242, 0.55);
  --accent:         #acc6e9;
  --accent-hover:   #cbdbf2;
  --success:        #8dd89f;
  --danger:         #e86d7a;

  /* Chronos-specific */
  --yes-color:      #8dd89f;   /* same as success */
  --no-color:       #e86d7a;   /* same as danger */
  --oracle-accent:  #7ecbf7;   /* electric blue for oracle/AI elements only */
}
```

**Typography** (loaded via `<link>` in each HTML `<head>`):
- Display / headings: `Space Grotesk` 500/600/700, `letter-spacing: -0.03em`
- Body / UI: `DM Sans` 400/500/600
- Mono (hashes, addresses, evidence): `JetBrains Mono` 400/500

**Glass utility** (defined once in `main.css`):
```css
.glass-card  { background: var(--surface);        backdrop-filter: blur(24px) saturate(160%); border: 1px solid var(--border); border-radius: 1.25rem; }
.glass-inner { background: var(--surface-strong);  backdrop-filter: blur(12px);                border: 1px solid var(--border); border-radius: 0.75rem; }
```

### 7.2 Layout

**Desktop:** Two-panel. Fixed left sidebar (240px) with nav, wallet status, USDC balance, Arc network indicator. Right content area scrolls.

**Mobile:** Bottom navigation bar (5 icons). Top bar with wallet connect and USDC balance. Full-width content.

**Sidebar items:** Overview, Explore, My Positions, Agent Intel, Archive, Settings.

**Top bar:** Chronos logotype (Space Grotesk), Arc Testnet pill, USDC balance, wallet connect button.

### 7.3 Shared Components (`src/js/components.js`)

All components are functions returning HTML strings or DOM nodes.

#### Market Card
```
┌──────────────────────────────────────────────┐
│ [OPEN] [Finance]                             │ ← status badge + category chip
│                                              │
│ Will BTC exceed $120k before                 │ ← Space Grotesk, 2 lines max
│ Dec 31 2026?                                 │
│                                              │
│ YES ████████░░░░ 62%     NO 38%              │ ← progress bar, tabular-nums
│ $24,800 staked                               │ ← total pool
│                                              │
│ Trading closes in 14d 6h    [Trade →]        │ ← countdown + CTA
└──────────────────────────────────────────────┘
```

Rules:
- Status badge colors: Open = `--accent`, TradingClosed = amber, Resolved YES = `--success`, Resolved NO = `--danger`, Refundable = muted, Settled = subtle
- YES/NO bar uses `--yes-color` and `--no-color`
- Countdown uses `JetBrains Mono`
- "Trade →" is the primary CTA; navigates to `market.html?id=X`

#### Status Badge
Small pill: text + color dot. States: Open, Pending Resolution, Resolved YES, Resolved NO, Refundable, Settled.

#### USDC Amount
Always `tabular-nums`. Show 2 decimal places for display, 6 available on hover/copy.

#### Skeleton Loader
Pulsing gray bars (CSS `@keyframes pulse`) for cards and data tables while fetching.

#### Transaction Button
States: idle → awaiting wallet → confirming → success / error. Button text changes; spinner appears; never fake progress.

#### Address Display
`0x1234...abcd` format. Click to copy. `JetBrains Mono`.

### 7.4 Page Specifications

#### Page 1: Overview (`index.html`)

**Hero row** (top of content, 3 stat cards):
- Total Markets Open (live count from `/api/protocol/status`)
- 24h Trading Volume in USDC
- Markets Resolved This Week

**User position summary card** (shows when wallet connected):
- Total staked across open markets
- Claimable winnings (sum from `/api/positions/:address/claimable`)
- "Claim All" button (iterates claimable markets, calls `claimWinnings` for each)

**Open markets strip**: Latest 6 open markets as Market Cards. "See all" links to Explore.

**Recent resolutions**: 5 most recent resolved markets. Outcome + brief evidence source.

**Agent activity ticker**: Last 3 agent runs, status, markets published.

Empty states when wallet not connected: wallet-shaped placeholder with "Connect to see your positions."

---

#### Page 2: Explore Markets (`explore.html`)

**Filters bar** (sticky):
- State: All / Open / Pending / Resolved / Refundable
- Category: All / Finance / Politics / Technology / Sports / Science / Other
- Sort: Newest / Deadline Soon / Most Staked / Highest YES% / Highest NO%
- Search: debounced text input hitting `GET /api/markets?search=`

**Grid**: responsive, 1 col mobile, 2 col tablet, 3 col desktop. Market Cards.

**Pagination**: "Load more" button (offset-based). Show "X markets found".

---

#### Page 3: Market Details (`market.html?id=N`)

**Header**: Question (Space Grotesk 28px), category, creator address, created date.

**Status bar**: Current state badge, trading deadline countdown, resolution deadline countdown.

**Pool visualization**:
```
YES  ████████████░░░░  62%    NO  ░░░░████  38%
     $24,800 staked            $15,200 staked
     Total: $40,000
```

**Probability chart** (canvas or SVG sparkline): YES% over time using trade events. Time axis, % axis. No fabricated data points — only real `SharesPurchased` events from `/api/markets/:id/trades`.

**Trade panel** (right column on desktop, bottom section on mobile):
```
┌─────────────────────────────────┐
│  Take a position                │
│  [YES]        [NO]              │ ← toggle
│  ┌───────────────────────────┐  │
│  │  0.00                USDC │  │ ← amount input
│  │  Balance: 120.00 · Max    │  │
│  └───────────────────────────┘  │
│  Est. payout: — USDC            │ ← live preview from computeWinnings
│  Your stake returned: — USDC    │
│  Fee on profit: — USDC (5%)     │
│  [Connect Wallet] or [Buy YES]  │
└─────────────────────────────────┘
```

Payout preview calls `contract.computeWinnings` or calculates client-side using pool math. Show USDC balance from wallet. Transaction button with full state machine.

**Evidence panel** (shows after resolution):
- Outcome badge
- Evidence sources (URL, fetch date, excerpt, content hash)
- Gemini reasoning excerpt
- Confidence score
- On-chain evidence URI link

**Activity feed**: `SharesPurchased` and `WinningsClaimed` events. Address (truncated), outcome, amount, time ago. Paginated.

**Claim / Refund panel** (shows when user has a position and market is Resolved/Refundable):
- "Your Position": stake amount, outcome
- "Net Payout": computed amount
- "Claim Winnings" or "Claim Refund" button with transaction state machine

---

#### Page 4: My Positions (`positions.html`)

Connect wallet required. If not connected, show a clear wallet prompt.

**Stats row**: Total Staked, Total Won, Total Lost, Pending Claims.

**Positions table**:

| Market | Side | Staked | Status | P&L | Action |
|---|---|---|---|---|---|
| Will BTC > 120k? | YES | 50 USDC | Open | — | View |
| Will Fed cut rates? | NO | 100 USDC | Resolved YES | +80 USDC | Claim |
| Will AAPL split? | YES | 25 USDC | Refundable | 0 | Refund |

- P&L: green for profit, red for loss, muted for open
- Action: "Claim" calls `claimWinnings`, "Refund" calls `claimRefund`, "View" links to market detail
- Filter tabs: All / Open / Claimable / Resolved / Refunded

---

#### Page 5: Agent Intelligence (`agent.html`)

**Today's summary card**: Markets discovered today, markets published today, markets resolved today, current agent status (idle / running), next scheduled run.

**Active jobs**: Table of markets currently in resolution pipeline with status badges.

**Recent runs list**: Expandable rows. Each shows type, duration, counts, errors. Click to expand full log.

**Resolution evidence explorer**: Searchable list of evidence bundles. Click to see full source list, reasoning, confidence, on-chain URI.

**Error log**: Last 20 agent errors with timestamps and market IDs.

No fabricated run data. If no runs exist yet, show an honest empty state ("No agent runs recorded yet. The agent runs daily at 09:00 UTC.").

---

#### Page 6: Resolution Archive (`archive.html`)

**Filter row**: Outcome (YES / NO / Refunded), Category, Date range, Search.

**Table**:

| Date | Question | Outcome | Evidence | Pool | My P&L |
|---|---|---|---|---|---|
| Oct 18 | Will BTC hit 120k? | YES | [view] | $40k | +80 USDC |

Outcome badge: YES (success green), NO (danger red), Refunded (muted).

Evidence "view" links open a modal with the full evidence bundle.

---

#### Page 7: Settings (`settings.html`)

**Wallet & Network section**:
- Connected address (copy button)
- Arc Testnet status indicator (live block number, latency)
- USDC balance (read from contract)
- Disconnect wallet button

**Protocol section** (read-only for non-owner wallets):
- Protocol fee (fetched from contract `feeBps`)
- Treasury address
- Oracle address
- Grace period

**Owner admin section** (only visible when `wallet.address == owner`):
- Set fee bps (input + Set Fee button)
- Set oracle address
- Set treasury address
- Pause / Unpause toggle

Admin actions call the corresponding contract functions with full transaction state UI.

**Preferences section**:
- Explorer preference (ArcScan testnet / mainnet)
- Save to localStorage

### 7.5 Wallet Integration (`src/js/wallet.js`)

Use ethers.js v6 (loaded from ES module CDN or bundled). Support any EIP-1193 provider (MetaMask, Rabby, Coinbase Wallet, etc.).

```javascript
// wallet.js responsibilities:
// - connectWallet(): request accounts, check/switch to Arc Testnet (chainId 5042002)
// - disconnectWallet(): clear state
// - getAddress(): returns checksummed address or null
// - getUsdcBalance(): reads ERC-20 balanceOf from USDC contract
// - onAccountsChanged(cb): fires callback on account change
// - onChainChanged(cb): fires callback on chain change
// - isCorrectChain(): true if chainId == 5042002
// - addArcTestnet(): calls wallet_addEthereumChain with Arc Testnet params
```

Arc Testnet parameters for `wallet_addEthereumChain`:
```javascript
{
  chainId: '0x4CEF52',          // 5042002
  chainName: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: ['https://rpc.testnet.arc.io'],
  blockExplorerUrls: ['https://explorer.testnet.arc.io']
}
```

**Important**: USDC on Arc has 18 decimals in the native view (gas) and 6 decimals in the ERC-20 view. For balance display always use the ERC-20 `balanceOf` (6 decimals). Never display the native balance as a separate "ETH-equivalent" value.

### 7.6 Contract Interactions (`src/js/contract.js`)

Reads: use `ethers.JsonRpcProvider` with `ARC_RPC_URL`. Writes: use `ethers.BrowserProvider` + signer from wallet.

```javascript
// contract.js responsibilities:
// - getMarket(id): reads Market struct
// - getShares(id, address): reads position
// - computeWinnings(id, address): preview payout
// - buyShares(id, outcome, amountUsdc): approve USDC then call buyShares
//   - approve step: call USDC ERC-20 approve(chronos, amount)
//   - then call buyShares
//   - return { approveTxHash, buyTxHash }
// - claimWinnings(id): call claimWinnings; return { txHash }
// - claimRefund(id): call claimRefund; return { txHash }
// - getProtocolSettings(): reads feeBps, oracle, treasury, paused, marketCount
// - USDC address: 0x3600000000000000000000000000000000000000
```

For the USDC approve + buyShares sequence, display a two-step progress indicator:
```
Step 1/2: Approve USDC  [confirming...]
Step 2/2: Buy shares    [waiting...]
```

### 7.7 Tailwind Configuration

```javascript
// tailwind.config.js
module.exports = {
  content: ['./frontend/**/*.html', './frontend/src/js/**/*.js'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        body: ['"DM Sans"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Menlo', 'monospace'],
      },
      colors: {
        ink:     'var(--ink)',
        muted:   'var(--muted)',
        subtle:  'var(--subtle)',
        accent:  'var(--accent)',
        success: 'var(--success)',
        danger:  'var(--danger)',
      },
    },
  },
  plugins: [],
}
```

Build command: `npx tailwindcss -i ./frontend/src/css/main.css -o ./frontend/dist/main.css --minify`

### 7.8 Visual Rules (non-negotiable)

- Never display fabricated balances, market volumes, or position data
- Loading states: skeleton loaders (pulsing bars), not spinners for data tables
- Spinners only for transactions in progress
- Empty states: honest, concise, no placeholder numbers
- All USDC amounts: `tabular-nums`, 2dp display with tooltip showing full 6dp
- Addresses: truncated `0x1234...abcd`, JetBrains Mono, click to copy
- YES probability: always green (`--yes-color`); NO: always red (`--no-color`)
- Accent (`--oracle-accent`) only for AI/agent elements — not general UI
- No emojis — use lucide SVG icons (inline SVG or icon font)
- Minimum tap target: 44px height
- Keyboard navigable: all interactive elements reachable by Tab; Enter/Space activates buttons
- Focus ring: `outline: 2px solid var(--accent); outline-offset: 2px`
- Responsive breakpoints: 640px (sm), 1024px (lg) — mobile-first

---

## 8. Configuration & Security

### 8.1 `.env.example`

```bash
# MongoDB
MONGODB_URI=mongodb://localhost:27017/chronos

# Gemini AI
GEMINI_API_KEY=
GEMINI_MODEL=gemini-1.5-pro

# Parallel Search API
PARALLEL_API_KEY=

# Arc Network
ARC_RPC_URL=https://rpc.testnet.arc.io
ARC_CHAIN_ID=5042002
ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000

# Contract
FACTORY_ADDRESS=            # Chronos.sol deployed address
PROTOCOL_TREASURY=          # treasury wallet address
PROTOCOL_FEE_BPS=500        # 5%

# Oracle worker wallet (backend only — NEVER expose to frontend)
ORACLE_PRIVATE_KEY=         # wallet authorized as oracle on-chain

# Worker auth
WORKER_SECRET=              # shared secret for /internal/* routes

# Backend
PORT=3000
CORS_ORIGINS=http://localhost:5173,http://localhost:8080

# Agent settings
AGENT_MAX_MARKETS_PER_DAY=3
AGENT_MIN_CONFIDENCE=0.85
AGENT_RESOLUTION_LOOKBACK_HOURS=48

# Grace period (seconds)
GRACE_PERIOD_SECONDS=15552000
```

### 8.2 Security Rules

- `ORACLE_PRIVATE_KEY` is read only in `backend/services/contract.js`. It is never logged, returned in API responses, or written to the database.
- All `/internal/*` routes require `Authorization: Bearer <WORKER_SECRET>`. Return 401 otherwise.
- Validate all request bodies with Fastify JSON Schema. Reject unknown fields.
- Rate limit public API: 60 req/min per IP. Rate limit trade history: 20 req/min per IP.
- Client cannot submit outcome, balance, or position data — all state comes from on-chain events.
- Backend does not trust position data cached in MongoDB for payout calculations; always re-reads shares from the contract before submitting resolution or claim transactions.
- `.gitignore` must include: `.env`, `.env.*`, `!.env.example`, `ORACLE_PRIVATE_KEY`.
- No private keys in comments, logs, or error messages.

---

## 9. Delivery Checklist

- [ ] `Chronos.sol` compiles with `forge build`
- [ ] All unit tests pass: `forge test -vvv`
- [ ] Coverage ≥ 90% branch: `forge coverage`
- [ ] Slither clean at High/Medium
- [ ] Contract deployed to Arc Testnet; address in `AGENTS.md` and `deployments/arc-testnet.json`
- [ ] Backend starts: `node backend/server.js`
- [ ] `GET /health` returns 200 with db and chain status
- [ ] All public API routes return correct shape (not 500)
- [ ] Agent discovery pipeline runs without error on a test question
- [ ] Agent resolution pipeline generates evidence and submits on-chain
- [ ] Frontend Tailwind build produces `frontend/dist/main.css`
- [ ] All 7 pages render without console errors
- [ ] Wallet connection works (MetaMask + Arc Testnet)
- [ ] Arc Testnet chain switching works
- [ ] USDC balance displays correctly (ERC-20 6-decimal view)
- [ ] `buyShares`: approve + buy flow completes; position appears in My Positions
- [ ] `claimWinnings`: claim flow completes; payout correct per formula
- [ ] Evidence page shows real evidence bundle
- [ ] All empty/loading/error states implemented
- [ ] No fabricated data anywhere
- [ ] `.env.example` complete
- [ ] `README.md` complete with setup, deploy, and run instructions

---

## 10. Build Order

Build incrementally. Verify each layer before the next.

```
Phase 1 — Contracts (2–3 days)
  1a. Write Chronos.sol
  1b. Write Foundry tests
  1c. Run forge test; iterate until passing
  1d. Run slither; fix High + Medium findings
  1e. Deploy to Arc Testnet; record address

Phase 2 — Backend foundation (1–2 days)
  2a. Fastify server + MongoDB connection
  2b. Collection schemas + indexes
  2c. Contract client (viem reads + writes)
  2d. Event sync: ingest SharesPurchased/MarketResolved into predictions + positions
  2e. All public API routes returning real on-chain data
  2f. Worker auth middleware

Phase 3 — Agent (2–3 days)
  3a. Gemini + Parallel service wrappers (with mocks for testing)
  3b. Discovery pipeline (question generation + validation)
  3c. Resolution pipeline (evidence + proposal)
  3d. Keeper job
  3e. Scheduler + idempotency
  3f. Agent run logging to MongoDB

Phase 4 — Frontend (2–3 days)
  4a. Design tokens + Tailwind build
  4b. Shared layout (sidebar + topbar)
  4c. Wallet connection + USDC balance
  4d. Market Card + skeleton component
  4e. Overview page
  4f. Explore Markets
  4g. Market Details (trade panel + evidence)
  4h. My Positions + claim flows
  4i. Agent Intelligence
  4j. Resolution Archive
  4k. Settings (including owner admin)

Phase 5 — Integration & polish (1 day)
  5a. End-to-end test: connect wallet → trade → agent resolves → claim
  5b. Fix any integration gaps
  5c. Responsive pass on mobile
  5d. Empty/error states audit
  5e. README + setup instructions
```

---

## 11. Payout Formula Reference

This is the definitive formula. Contract code, backend calculations, and frontend previews must all produce identical results.

```
Given:
  yesPool         = total USDC staked on YES for this market
  noPool          = total USDC staked on NO for this market
  totalPool       = yesPool + noPool
  winningPool     = yesPool (if outcome == YES) or noPool (if outcome == NO)
  userShares      = user's shares on the winning side (USDC units, 6 decimals)
  feeBps          = protocol fee in basis points (e.g. 500 = 5%)

Derived:
  grossPayout     = userShares * totalPool / winningPool
  originalStake   = userShares
  profit          = grossPayout - originalStake
  fee             = profit * feeBps / 10_000
  netPayout       = originalStake + profit - fee

Invariant check:
  netPayout       = grossPayout - fee
  fee             = (grossPayout - originalStake) * feeBps / 10_000

Fee is zero when:
  - The user's grossPayout == their originalStake (break-even; no profit)
  - feeBps == 0

Example (from §4.1 in Chronos-design.md, updated formula):
  yesPool = 200 USDC, noPool = 800 USDC, totalPool = 1000 USDC
  Alice has 200 YES shares; outcome = YES; feeBps = 500

  grossPayout   = 200 * 1000 / 200 = 1000 USDC
  originalStake = 200 USDC
  profit        = 1000 - 200 = 800 USDC
  fee           = 800 * 500 / 10000 = 40 USDC
  netPayout     = 200 + 800 - 40 = 960 USDC
  treasury gets = 40 USDC

  Total out: 960 (Alice) + 40 (treasury) = 1000 = totalPool ✓

Integer arithmetic rules:
  - All amounts in USDC 6-decimal units (uint256)
  - Round fee DOWN (integer division truncates): user gets more, treasury gets less
  - Verify: grossPayout >= originalStake before computing profit (always true when winningPool <= totalPool)
  - Verify: fee <= profit (always true when feeBps <= 10000)
  - Verify: netPayout <= totalPool (always true)
```

---

*This spec supersedes the trading model in `Chronos-design.md` §4 (fees) and §10 (fee pseudocode). All other sections of the design doc remain valid. When in doubt about a contract implementation detail not covered here, refer to the design doc.*
