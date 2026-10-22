# Chronos Protocol

**Predict the future. Verify the outcome.**

An autonomous, event-driven binary prediction market on Arc. Users stake USDC on YES or NO outcomes. An AI agent discovers events, creates markets, gathers evidence, and submits verifiable resolutions on-chain. Smart contracts enforce all financial rules.

---

## Architecture

```
frontend/       Vanilla JS + Tailwind CSS — 7 pages, Arc Dark theme
backend/        Fastify + MongoDB — REST API + agent worker
contracts/      Solidity 0.8.24 — Chronos.sol (Foundry)
```

## Contracts

**`Chronos.sol`** — single non-upgradeable contract on Arc Testnet:
- Binary YES/NO markets backed by USDC
- Pro-rata payouts to winners; fee ONLY on profit (`feeBps`=500 default = 5%)
- AI oracle resolves after trading closes; miss → full refund to all participants
- CEI + nonReentrant everywhere; decoupled fee accumulator (`pendingFees`, pull via `withdrawFees()`)
- Snapshotted per-market fee (`feeBps` in Market struct)
- Deliberately allows exits (claimWinnings, claimRefund, markRefundable, closeTrading) while paused
- `initialOwner` constructor param — set to a multisig for production

```bash
# Build
cd contracts && forge build

# Test (59 tests)
forge test -vvv
forge coverage --report summary
```

## Setup

### 1. Environment

```bash
cp .env.example .env
# Edit .env — fill in MONGODB_URI, GEMINI_API_KEY, PARALLEL_API_KEY,
#   ORACLE_PRIVATE_KEY, PROTOCOL_TREASURY
```

### 2. Deploy Chronos.sol to Arc Testnet

In Arc Studio: open Contracts panel and follow the deploy workflow.

The constructor takes:
- `_usdc`: `0x3600000000000000000000000000000000000000` (Arc USDC)
- `_oracle`: wallet address that will call resolveMarket (your oracle wallet)
- `_treasury`: wallet address to receive protocol fees
- `_feeBps`: `500` (5%)
- `_gracePeriod`: `15552000` (180 days)
- `initialOwner`: deployer wallet or multisig

After deploy, set `VITE_FACTORY_ADDRESS` in `.env`.

### 3. Backend

```bash
cd backend
npm install     # or: bun install
npm start       # or: node server.js
```

Requires MongoDB (local or Atlas). The agent scheduler starts automatically.

### 4. Frontend

Serve the `frontend/` directory from any static host or the Express/Fastify static plugin.

For local dev:
```bash
cd frontend
npx serve .
# Open http://localhost:3000
```

Wire up the runtime config in `frontend/index.html`:
```js
window.CHRONOS_CONTRACT = '0x...'; // deployed Chronos address
window.CHRONOS_USDC = '0x3600000000000000000000000000000000000000';
window.CHRONOS_CHAIN_ID = 5042002;
window.CHRONOS_EXPLORER = 'https://explorer.testnet.arc.io';
window.CHRONOS_API_URL = 'https://your-backend-url/api';
```

### 5. Agent

The agent runs automatically via cron once the backend starts.
- **Discovery** (9am UTC daily): searches for events, Gemini validates, publishes ≤3 markets
- **Keeper** (every 15 min): syncs chain state, calls `closeTrading` for expired markets
- **Resolution** (every 30 min): gathers evidence, Gemini proposes resolution, submits on-chain

Trigger manually via the internal API:
```bash
curl -X POST http://localhost:3000/internal/agent/trigger-discovery \
  -H "Authorization: Bearer your-worker-secret"
```

## API Reference

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/protocol/status` | Protocol stats + chain status |
| `GET /api/markets` | Paginated markets list (`state`, `category`, `sort`, `search`) |
| `GET /api/markets/:id` | Full market detail |
| `GET /api/markets/:id/evidence` | Oracle evidence bundle |
| `GET /api/markets/:id/trades` | Trade history |
| `GET /api/positions/:address` | Wallet positions |
| `GET /api/positions/:address/claimable` | Claimable payouts (with preview) |
| `GET /api/resolutions` | Resolution archive |
| `GET /api/agent/runs` | Agent run history |
| `GET /api/agent/daily-report` | Today's agent activity |
| `GET /api/settings/public` | Protocol configuration |

## Payout Formula

```
grossPayout   = userShares × totalPool / winningPool
profit        = grossPayout − originalStake
fee           = profit × feeBps / 10_000    (only on profit)
netPayout     = grossPayout − fee
```

Fee is zero when there is no profit (e.g. all USDC on winning side).
Fees accumulate in `pendingFees`; anyone can call `withdrawFees()` to send them to treasury.

## Security Notes

- Oracle key is separate from owner key — rotatable via `setOracle()`
- Owner strongly recommended to be a multisig (2-of-3+) in production
- Rescue guard: USDC can only be rescued in excess of all active pool obligations + pendingFees
- Pause blocks new commitments only; exit paths always remain open
- No upgradeable proxy in v1 — migration to v2 via new deploy

## Testnet

Deploy and test on Arc Testnet (chain ID 5042002). Get test USDC from the Arc Studio sidebar ("Get test USDC") or [faucet.circle.com](https://faucet.circle.com).

**Never auto-deploy to mainnet. Always audit before mainnet use.**
