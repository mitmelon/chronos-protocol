<div align="center">

# ⏳ Chronos

### Autonomous prediction markets on **Arc**
**An AI agent finds the questions, settles the outcomes and pays the winners. In USDC, on-chain, with receipts anyone can check.**

![Arc](https://img.shields.io/badge/built%20on-Arc-0b0b0f?style=for-the-badge)
![USDC](https://img.shields.io/badge/settled%20in-USDC-2775ca?style=for-the-badge)
![AI](https://img.shields.io/badge/oracle-Gemini%20%2B%20Parallel-8e44ad?style=for-the-badge)
![Solidity](https://img.shields.io/badge/contract-Solidity%200.8-363636?style=for-the-badge)
![Status](https://img.shields.io/badge/status-mainnet%20first-orange?style=for-the-badge)

[How it works](#-how-it-works) · [Why Arc](#-why-arc) · [Quick start](#-quick-start) · [The agent](#-the-agent) · [Costs](#-gas-and-costs) · [Trust model](#-trust-model--risks)

</div>

---

## ✨ What is Chronos?

Chronos is a prediction-market protocol where **nobody has to run the market by hand**.

- 🌍 An **AI agent searches the whole world** for upcoming events and turns them into clear YES / NO questions.
- 🎲 It only keeps questions that are **genuinely uncertain**: no foregone conclusions, no scheduled "will it happen as planned" questions.
- 🧾 When the event is over, the agent **finds the result, cites its sources and settles the market on-chain**.
- 💸 **Winners are paid automatically** in USDC. Nobody has to find a "claim" button (they can still use it).
- 🔍 Every resolution stores **hashed, verifiable evidence**. You don't have to trust a blog post, you can check the hash.

> Anyone can trade with just a wallet and a few cents of USDC. Winning is never guaranteed, and you can lose what you stake.

---

## 🧠 How it works

```mermaid
flowchart LR
  A[🌍 Discovery agent<br/>searches the web worldwide] --> B{✅ Rules + independent review}
  B -- rejected --> A
  B -- approved --> C[(💾 Saved as <b>pending</b>)]
  C --> D[⛓️ ONE transaction<br/>createMarkets]
  D -- failed --> C
  D --> E[📈 Market is live<br/>people trade in USDC]
  E --> F[⏰ Event happens]
  F --> G[🕵️ Resolution agent<br/>finds the answer, cites sources]
  G -- not published yet --> G
  G --> H[🏁 resolveMarket on-chain<br/>evidence hash stored]
  H --> I[💸 Payout agent pays every winner]
```

| Step | What happens | Who/what does it |
|---|---|---|
| 1️⃣ **Discover** | Searches news and official sources in many regions, checks the event is still in the future, estimates the odds with data | Gemini agent + Parallel search |
| 2️⃣ **Vet** | Strict code rules plus an independent second model must agree the outcome is uncertain and unambiguous | Guards + reviewer model |
| 3️⃣ **Save** | Approved questions are stored as `pending` first, so nothing is lost if the chain is busy | MongoDB |
| 4️⃣ **Publish** | All of the day's markets go on-chain **in one transaction**; failures retry from the database | Publisher |
| 5️⃣ **Trade** | Anyone with a wallet stakes YES or NO. **The trader pays their own gas** | Smart contract |
| 6️⃣ **Resolve** | At the due time the agent researches the result, quotes its sources word for word and settles | Gemini agent + Parallel |
| 7️⃣ **Pay** | The agent pays every winner in batches and verifies each payment on-chain | Payout agent |

**Refunds are a last resort.** The agent keeps looking for the answer until the deadline, makes one extra-thorough attempt shortly before it, and only refunds everyone if the event was cancelled or no evidence of the result exists.

---

## 🔷 Why Arc?

[Arc](https://docs.arc.io) is an EVM chain where **USDC is the gas token**, with fast finality and predictable, dollar-denominated fees.

- 💵 **No second token.** Stakes, fees, payouts *and* gas are all USDC.
- ⚡ **Quick finality** means a market resolves and pays out without long waits.
- 🧮 **Predictable costs** make it practical for an agent to operate on a small budget (see [Gas and costs](#-gas-and-costs)).
- 🔁 **One codebase, two networks.** Set `ARC_NETWORK=testnet` or `mainnet`; the contract address, RPC and explorer follow.

---

## 🚀 Quick start

**Requirements:** Node 20+, MongoDB, Redis, a funded wallet for the oracle, a [Gemini API key](https://ai.google.dev) and a [Parallel API key](https://parallel.ai).

```bash
git clone https://github.com/mitmelon/chronos-protocol && cd chronos-protocol
npm install
cp .env.example .env        # then fill it in (see below)
node scripts/check-setup.js # verifies wallet, RPC, contract, keys
npm run build               # builds the stylesheet
npm start                   # website + API   (http://localhost:5173)
npm run start:worker        # AI agents + job queues (separate process)
```

Make the first questions appear right away instead of waiting for the daily schedule:

```bash
node scripts/trigger.js discovery
```

### 🔧 The `.env` you need

```ini
ARC_NETWORK=testnet                       # testnet | mainnet
VITE_FACTORY_ADDRESS=0x...                # your deployed Chronos contract
ORACLE_PRIVATE_KEY=...                    # 64 hex chars, with or without 0x
SESSION_SECRET=...                        # openssl rand -hex 32
GEMINI_API_KEY=...
PARALLEL_API_KEY=...
MONGODB_URI=mongodb://admin:password@localhost:27017
MONGODB_DB_NAME=chronos
```

Everything else has a sensible default. See [`.env.example`](.env.example).

### 🧪 Handy commands

| Command | What it does |
|---|---|
| `node scripts/check-setup.js` | Checks wallet balance, RPC, contract, oracle address and keys |
| `node scripts/estimate-costs.js --budget 1` | Shows real costs at the **current** gas price |
| `node scripts/trigger.js discovery` | Find and publish markets now |
| `node scripts/trigger.js resolve <id>` | Settle one market now |
| `node scripts/trigger.js payout <id>` | Pay out a settled market |

---

## 🤖 The agent

Chronos is an agent, not a prompt. **Gemini decides what to do**, and calls tools to do it:

| Tool | Purpose |
|---|---|
| 🔎 `web_search` | Live web search (Parallel) |
| 📖 `read_page` | Read a page in depth (Parallel Extract) |
| 🧾 `create_market` | Propose a market. Checked by code **and** an independent reviewer |
| 🏁 `resolve_market` | Settle with verbatim quotes. Checked by code **and** an independent verifier |
| ⏳ `defer_resolution` | Not published yet? Try again later (this repeats until the deadline) |
| ↩️ `cancel_market` | Last resort refund, only after the deadline |

**The model proposes. Code decides.** Every on-chain action is re-validated in code, so a bad model answer can't push an unsafe action through:

- 🕰️ Only **future** events. Trading must close before the event.
- 🎯 Probability must sit in a configurable band (default **20% to 80%**), backed by data the agent found.
- 🔗 The agent must have **read the official source** that will publish the result.
- 🧷 Resolution needs a **word-for-word quote** from a page it read, published after the event, plus an independent check.
- 🌐 No fixed list of websites or countries. Each run explores different regions and themes.
- 🔒 One run per market at a time, and a market can only be resolved once.

---

## ⛽ Gas and costs

Text stored on-chain is the main cost (about 22k gas per 32 bytes), so Chronos keeps it short: questions ≤ 200 characters, criteria ≤ 500, and evidence is stored as an **80-byte hash pointer** instead of a multi-KB blob.

| Action | Gas (measured) | Paid by |
|---|---:|---|
| Publish 3 markets (one transaction) | ~1.34M | Oracle wallet |
| Resolve a market | ~175k | Oracle wallet |
| Buy shares | ~68k to ~119k | **The trader** |
| Pay out one market (10 winners) | ~570k | Oracle wallet |

Costs depend on Arc's gas price, so run `node scripts/estimate-costs.js` for real numbers. A per-transaction cap (`AGENT_MAX_TX_COST_USDC`) refuses anything unexpectedly expensive, which protects a small wallet.

---

## 📜 Smart contract

[`contracts/Chronos.sol`](contracts/Chronos.sol): pools, fee on **profit only**, pause switch, refund path.

- `createMarkets` publishes up to 10 markets in one transaction (all or nothing).
- `claimBatch` / `claimWinningsFor` / `claimRefundFor` let the agent push payouts. **Funds can only ever go to the participant**, never to the caller.
- Tested on a real EVM: batch payouts, double-claim attempts, a blocklisted address, refunds, pausing, fee accounting.

```bash
cd test/contract && node compile.js && node test-chronos.js
```

---

## 🛡️ Trust model & risks

Be clear about what is and isn't decentralised:

- 🤖 **Outcomes** are decided by an AI agent, not a person or committee, and the evidence is hashed and public. But the agent is run by whoever holds the oracle key, and AI can be wrong.
- 🔑 The contract has an **owner** (can pause and change settings) and an **oracle** address (the only account that can resolve).
- 🧑‍⚖️ Anyone can call `createMarket` on the contract; the agent's quality rules apply to the markets the Chronos agent publishes.
- ⚠️ The contract is **not audited**. Use testnet first. Never stake more than you can afford to lose.
- 📉 Prediction markets involve risk and may be restricted where you live. This is software, not financial advice.

---

## 🗂️ Project layout

```
contracts/        Solidity contract
src/agent/        discovery, publishing, resolution, payouts, keeper (the AI agent)
src/services/     Gemini, Parallel, evidence, chain access
src/routes/       HTTP API (markets, auth, resolve, evidence)
src/queues/       BullMQ workers and schedules
public/js/        the web app (wallet connect, sign-in, trading)
scripts/          setup check, cost estimate, manual triggers
test/             agent, payout, publish and contract tests
```

---

<div align="center">

**Built on Arc · Settled in USDC · Operated by an AI agent**

⭐ Star the repo if you want to see where this goes.

</div>
