/**
 * HellBurn Deployment Script — v2 (post-audit)
 *
 * Changes from v1:
 *   - BurnEpochs + HellBurnStaking now require `guardian` address
 *   - Guardian = emergency pause role (ideally a multisig, e.g. Gnosis Safe)
 *
 * Deployment order (circular dependency via nonce pre-calculation):
 *   nonce+0: BuyAndBurn
 *   nonce+1: HellBurnToken
 *   nonce+2: GenesisBurn
 *   nonce+3: HellBurnStaking
 *   nonce+4: BurnEpochs
 */

const { ethers } = require("hardhat");
const fs = require("fs");

// ─── Mainnet Addresses ───────────────────────────────────────────
const ADDRESSES = {
  titanX: "0xf19308f923582a6f7c465e5ce7a9dc1bec6665b1",
  dragonX: "0x96a5399D07896f757Bd4c6eF56461F58DB951862",
  uniswapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
};

// ─── Configuration ───────────────────────────────────────────────
// CHANGE THESE BEFORE MAINNET DEPLOYMENT:
const GUARDIAN_ADDRESS = process.env.GUARDIAN_ADDRESS || "";  // Multisig for emergency pause
const GENESIS_RECIPIENT = process.env.GENESIS_RECIPIENT || "";  // 8% genesis fee recipient
const DRAGONX_VAULT = process.env.DRAGONX_VAULT || "";  // DragonX buy & burn vault
const FIRST_EPOCH_DELAY = 86400;  // 1 day after deployment

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  const network = await ethers.provider.getNetwork();

  console.log("═══════════════════════════════════════════════════");
  console.log("  🔥 HELLBURN DEPLOYMENT v2 (post-audit)");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Deployer:   ${deployer.address}`);
  console.log(`  Balance:    ${ethers.formatEther(balance)} ETH`);
  console.log(`  Network:    ${network.name} (chainId: ${network.chainId})`);
  console.log("═══════════════════════════════════════════════════\n");

  // ─── Validate config ──────────────────────────────────────────
  // On hardhat/localhost: use deployer as fallback for all roles
  const isLocal = network.name === "hardhat" || network.name === "localhost" || network.chainId === 31337n;

  const guardian = GUARDIAN_ADDRESS || (isLocal ? deployer.address : "");
  const genesisRecipient = GENESIS_RECIPIENT || (isLocal ? deployer.address : "");
  const dragonXVault = DRAGONX_VAULT || (isLocal ? deployer.address : "");

  if (!guardian || !genesisRecipient || !dragonXVault) {
    console.error("  ❌ GUARDIAN_ADDRESS, GENESIS_RECIPIENT, and DRAGONX_VAULT must be set for non-local networks!");
    console.error("     Set them in .env or as environment variables.");
    process.exit(1);
  }

  console.log("  Roles:");
  console.log(`    Guardian (pause):    ${guardian}`);
  console.log(`    Genesis recipient:   ${genesisRecipient}`);
  console.log(`    DragonX vault:       ${dragonXVault}\n`);

  // ─── Pre-calculate addresses ───────────────────────────────────
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  console.log(`  Current nonce: ${nonce}`);

  const addr = (i) => ethers.getCreateAddress({ from: deployer.address, nonce: nonce + i });

  const buyBurnAddr  = addr(0);
  const tokenAddr    = addr(1);
  const genesisAddr  = addr(2);
  const stakingAddr  = addr(3);
  const epochsAddr   = addr(4);

  console.log("  Pre-calculated addresses:");
  console.log(`    [0] BuyAndBurn:    ${buyBurnAddr}`);
  console.log(`    [1] HellBurnToken: ${tokenAddr}`);
  console.log(`    [2] GenesisBurn:   ${genesisAddr}`);
  console.log(`    [3] Staking:       ${stakingAddr}`);
  console.log(`    [4] BurnEpochs:    ${epochsAddr}\n`);

  // ─── [0] BuyAndBurn ────────────────────────────────────────────
  console.log("  [1/5] Deploying BuyAndBurn...");
  const BuyAndBurn = await ethers.getContractFactory("BuyAndBurn");
  const buyAndBurn = await BuyAndBurn.deploy(
    ADDRESSES.uniswapRouter,
    ADDRESSES.weth,
    tokenAddr  // future HellBurnToken
  );
  await buyAndBurn.waitForDeployment();
  const buyBurnDeployed = await buyAndBurn.getAddress();
  _verify(buyBurnDeployed, buyBurnAddr, "BuyAndBurn");

  // ─── [1] HellBurnToken ────────────────────────────────────────
  console.log("  [2/5] Deploying HellBurnToken...");
  const HellBurnToken = await ethers.getContractFactory("HellBurnToken");
  const token = await HellBurnToken.deploy(
    genesisAddr,     // future GenesisBurn
    stakingAddr,     // future Staking
    buyBurnDeployed
  );
  await token.waitForDeployment();
  const tokenDeployed = await token.getAddress();
  _verify(tokenDeployed, tokenAddr, "HellBurnToken");

  // ─── [2] GenesisBurn ───────────────────────────────────────────
  console.log("  [3/5] Deploying GenesisBurn...");
  const GenesisBurn = await ethers.getContractFactory("GenesisBurn");
  const genesisBurn = await GenesisBurn.deploy(
    ADDRESSES.titanX,
    dragonXVault,        // 35% TitanX → DragonX vault
    stakingAddr,         // 22% TitanX → treasury/staking
    genesisRecipient,    // 8% TitanX → genesis recipient
    tokenDeployed
  );
  await genesisBurn.waitForDeployment();
  const genesisDeployed = await genesisBurn.getAddress();
  _verify(genesisDeployed, genesisAddr, "GenesisBurn");

  // ─── [3] HellBurnStaking ──────────────────────────────────────
  console.log("  [4/5] Deploying HellBurnStaking...");
  const Staking = await ethers.getContractFactory("HellBurnStaking");
  const staking = await Staking.deploy(
    tokenDeployed,
    ADDRESSES.titanX,
    ADDRESSES.dragonX,
    guardian              // NEW v2: emergency pause guardian
  );
  await staking.waitForDeployment();
  const stakingDeployed = await staking.getAddress();
  _verify(stakingDeployed, stakingAddr, "Staking");

  // ─── [4] BurnEpochs ───────────────────────────────────────────
  console.log("  [5/5] Deploying BurnEpochs...");
  const block = await ethers.provider.getBlock("latest");
  const firstEpochStart = block.timestamp + FIRST_EPOCH_DELAY;

  const BurnEpochs = await ethers.getContractFactory("BurnEpochs");
  const epochs = await BurnEpochs.deploy(
    ADDRESSES.titanX,
    ADDRESSES.dragonX,
    buyBurnDeployed,
    stakingDeployed,
    firstEpochStart,
    guardian              // NEW v2: emergency pause guardian
  );
  await epochs.waitForDeployment();
  const epochsDeployed = await epochs.getAddress();
  _verify(epochsDeployed, epochsAddr, "BurnEpochs");

  // ─── Summary ───────────────────────────────────────────────────
  const summary = {
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    guardian: guardian,
    timestamp: new Date().toISOString(),
    contracts: {
      HellBurnToken: tokenDeployed,
      GenesisBurn: genesisDeployed,
      BurnEpochs: epochsDeployed,
      HellBurnStaking: stakingDeployed,
      BuyAndBurn: buyBurnDeployed,
    },
    config: {
      firstEpochStart,
      firstEpochDate: new Date(firstEpochStart * 1000).toISOString(),
      titanX: ADDRESSES.titanX,
      dragonX: ADDRESSES.dragonX,
      genesisRecipient,
      dragonXVault,
    },
  };

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  🔥 DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  HellBurnToken:   ${tokenDeployed}`);
  console.log(`  GenesisBurn:     ${genesisDeployed}`);
  console.log(`  BurnEpochs:      ${epochsDeployed}`);
  console.log(`  HellBurnStaking: ${stakingDeployed}`);
  console.log(`  BuyAndBurn:      ${buyBurnDeployed}`);
  console.log(`  Guardian:        ${guardian}`);
  console.log(`  First Epoch:     ${summary.config.firstEpochDate}`);
  console.log("═══════════════════════════════════════════════════");

  fs.writeFileSync("deployment.json", JSON.stringify(summary, null, 2));
  console.log("\n  📄 Saved to deployment.json");

  // ─── Post-deploy checklist ─────────────────────────────────────
  console.log("\n  📋 POST-DEPLOY CHECKLIST:");
  console.log("     [ ] Verify all contracts on Etherscan");
  console.log("     [ ] Create HBURN/WETH Uniswap V3 pool");
  console.log("     [ ] Add initial liquidity");
  console.log("     [ ] Test a small genesis burn");
  console.log("     [ ] Announce genesis phase to community");
  console.log("     [ ] Register on Immunefi (bug bounty)\n");
}

function _verify(actual, expected, name) {
  if (actual === expected) {
    console.log(`        ✅ ${name}: ${actual}`);
  } else {
    console.log(`        ⚠️  ${name}: ${actual} (expected ${expected})`);
    console.log("        WARNING: Address mismatch — nonce changed?");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
