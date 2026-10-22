# Chronos Protocol — Deployment Registry

## Deployed Contracts

| Contract | Network | Address | Deployed At |
|---|---|---|---|
| `Chronos` | Arc Testnet (chain ID 5042002) | `0xd75ae02a877522a567ee4a805cdda275c770a939` | 2026-10-22 |

Explorer: https://explorer.testnet.arc.io/address/0xd75ae02a877522a567ee4a805cdda275c770a939

### Constructor args (Arc Testnet deploy)
- `_usdc`: `0x3600000000000000000000000000000000000000` (Arc USDC)
- `_oracle`: `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42` (platform deployer — replace with dedicated oracle wallet before mainnet)
- `_treasury`: `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42` (platform deployer — replace with treasury wallet)
- `_feeBps`: `500` (5% on winners' profit)
- `_gracePeriod`: `15552000` (180 days)
- `initialOwner`: `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42` (platform deployer)

### Important: before moving to production
1. Deploy with a dedicated oracle key (set `_oracle` to the oracle wallet from `ORACLE_PRIVATE_KEY`)
2. Set `_treasury` to your protocol treasury address
3. Set `initialOwner` to a multisig (2-of-3+) and transfer ownership immediately post-deploy
4. Update `VITE_FACTORY_ADDRESS` in `.env` with the new address

## Frontend Config
- `window.CHRONOS_CONTRACT`: `0xd75ae02a877522a567ee4a805cdda275c770a939`
- `window.CHRONOS_USDC`: `0x3600000000000000000000000000000000000000`
- `window.CHRONOS_CHAIN_ID`: `5042002`
- `window.CHRONOS_EXPLORER`: `https://explorer.testnet.arc.io`
