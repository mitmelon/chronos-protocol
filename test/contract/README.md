# Contract tests (real EVM)

Compiles `contracts/Chronos.sol` and runs it on an in-process Hardhat network, then runs the real backend modules
(`src/services/contract.js`, `src/agent/payouts.js`) against the compiled contract.

    cd test/contract
    npm init -y && npm i solc@0.8.28 @openzeppelin/contracts@5.1.0 hardhat@2.22.19 viem
    node compile.js              # needs viaIR: the original contract also needs it
    node test-chronos.js         # 15 contract tests (batch payouts, refunds, blocked address, pause, accounting)
    node backend-vs-chain.js     # backend + payout agent against the compiled contract
