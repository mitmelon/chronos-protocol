require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
  // 1. Validate environment variables
  const privateKey = process.env.ORACLE_PRIVATE_KEY;
  const rpcUrl = process.env.ARC_RPC_URL;
  const usdcAddress = process.env.VITE_ARC_USDC_ADDRESS;
  const oracleAddress = process.env.ORACLE_ADDRESS;
  const treasuryAddress = process.env.PROTOCOL_TREASURY;

  if (!privateKey || !rpcUrl || !usdcAddress || !oracleAddress || !treasuryAddress) {
    console.error("❌ Error: Missing required environment variables in .env file.");
    process.exit(1);
  }

  console.log("🚀 Connecting to Arc network via RPC...");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log(`👤 Deploying from address: ${wallet.address}`);

  // 2. Read Foundry compilation artifact (uses process.cwd() so it correctly finds root 'out/')
  const artifactPath = path.join(process.cwd(), "contracts", "out", "Chronos.sol", "Chronos.json");
  if (!fs.existsSync(artifactPath)) {
    console.error(`❌ Error: Artifact not found at ${artifactPath}. Please run 'forge build' first.`);
    process.exit(1);
  }

  const contractJson = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abi = contractJson.abi;
  const bytecode = contractJson.bytecode.object;

  // 3. Define constructor arguments
  // constructor(address _usdc, address _oracle, address _treasury, uint256 _feeBps, uint256 _gracePeriod, address initialOwner)
  const feeBps = 500;                  // 5% default fee
  const gracePeriod = 180 * 86400;     // 180 days in seconds
  const initialOwner = wallet.address; // Deployer wallet as initial owner

  console.log("📦 Preparing deployment transaction...");
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);

  console.log("⏳ Deploying Chronos contract...");
  const contract = await factory.deploy(
    usdcAddress,
    oracleAddress,
    treasuryAddress,
    feeBps,
    gracePeriod,
    initialOwner
  );

  console.log(`🔄 Transaction hash: ${contract.deploymentTransaction().hash}`);
  
  await contract.waitForDeployment();
  const deployedAddress = await contract.getAddress();

  console.log(`✅ Chronos successfully deployed to: ${deployedAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });