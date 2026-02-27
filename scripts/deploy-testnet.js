/**
 * HellBurn Testnet Setup + Etherscan Verification
 *
 * Deploys mock TitanX + DragonX, then redeploys all HellBurn contracts
 * pointing to the mocks. Mints test tokens to deployer. Verifies everything.
 *
 * Requirements:
 *   - ETHERSCAN_API_KEY in .env
 *   - hardhat.config.js must have etherscan config:
 *
 *       etherscan: {
 *         apiKey: process.env.ETHERSCAN_API_KEY,
 *       },
 *
 * Usage: npx hardhat run scripts/deploy-testnet.js --network sepolia
 */

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");

const MINT_AMOUNT = ethers.parseEther("100000000"); // 100M test tokens each
const VERIFY_DELAY_MS = 15_000; // 15s wait for Etherscan to index
const VERIFY_RETRIES = 3;

// ─── Verification Helper ────────────────────────────────────────
async function verify(name, address, constructorArguments) {
  console.log(`        ⏳ Verifying ${name} (${address})...`);
  for (let attempt = 1; attempt <= VERIFY_RETRIES; attempt++) {
    try {
      await hre.run("verify:verify", {
        address,
        constructorArguments,
      });
      console.log(`        ✅ ${name} verified on Etherscan`);
      return true;
    } catch (err) {
      const msg = err.message || "";
      // Already verified — treat as success
      if (msg.includes("Already Verified") || msg.includes("already verified")) {
        console.log(`        ✅ ${name} already verified`);
        return true;
      }
      if (attempt < VERIFY_RETRIES) {
        console.log(`        ⚠️  Attempt ${attempt}/${VERIFY_RETRIES} failed, retrying in ${VERIFY_DELAY_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
      } else {
        console.log(`        ❌ ${name} verification failed: ${msg.slice(0, 120)}`);
        return false;
      }
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  const network = await ethers.provider.getNetwork();

  console.log("═══════════════════════════════════════════════════");
  console.log("  🔥 HELLBURN TESTNET SETUP");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Balance:   ${ethers.formatEther(balance)} ETH`);
  console.log(`  Network:   ${network.name} (${network.chainId})`);
  console.log("═══════════════════════════════════════════════════\n");

  // ═══════════════════════════════════════════════════════════════
  //  PHASE 1: DEPLOY
  // ═══════════════════════════════════════════════════════════════

  console.log("  ── PHASE 1: DEPLOY ──────────────────────────────\n");

  // ─── 1. Mock Tokens ───────────────────────────────────────────
  console.log("  [1/7] Deploying Mock TitanX...");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const titanX = await MockERC20.deploy("TitanX", "TITANX");
  await titanX.waitForDeployment();
  const titanXAddr = await titanX.getAddress();
  console.log(`        ✅ Mock TitanX: ${titanXAddr}`);

  console.log("  [2/7] Deploying Mock DragonX...");
  const dragonX = await MockERC20.deploy("DragonX", "DRAGONX");
  await dragonX.waitForDeployment();
  const dragonXAddr = await dragonX.getAddress();
  console.log(`        ✅ Mock DragonX: ${dragonXAddr}`);

  // Mint tokens to deployer
  const tx1 = await titanX.mint(deployer.address, MINT_AMOUNT);
  await tx1.wait();
  const tx2 = await dragonX.mint(deployer.address, MINT_AMOUNT);
  await tx2.wait();
  console.log(`        💰 Minted ${ethers.formatEther(MINT_AMOUNT)} of each to deployer\n`);

  // ─── 2. HellBurn Contracts ────────────────────────────────────
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const addr = (i) => ethers.getCreateAddress({ from: deployer.address, nonce: nonce + i });

  // Deploy order: 0=BuyBurn, 1=Token, 2=Genesis, 3=Staking, 4=Epochs
  const buyBurnAddr = addr(0);
  const tokenAddr = addr(1);
  const genesisAddr = addr(2);
  const stakingAddr = addr(3);

  console.log("  [3/7] Deploying BuyAndBurn...");
  const BuyAndBurn = await ethers.getContractFactory("BuyAndBurn");
  const buyBurn = await BuyAndBurn.deploy(deployer.address, deployer.address, tokenAddr);
  await buyBurn.waitForDeployment();
  const buyBurnDeployed = await buyBurn.getAddress();
  console.log(`        ✅ BuyAndBurn: ${buyBurnDeployed}`);

  console.log("  [4/7] Deploying HellBurnToken...");
  const HellBurnToken = await ethers.getContractFactory("HellBurnToken");
  const token = await HellBurnToken.deploy(genesisAddr, stakingAddr, buyBurnAddr);
  await token.waitForDeployment();
  const tokenDeployed = await token.getAddress();
  console.log(`        ✅ HellBurnToken: ${tokenDeployed}`);

  console.log("  [5/7] Deploying GenesisBurn...");
  const GenesisBurn = await ethers.getContractFactory("GenesisBurn");
  const genesis = await GenesisBurn.deploy(
    titanXAddr,
    deployer.address, // dragonX vault
    deployer.address, // treasury
    deployer.address, // genesis recipient
    tokenDeployed
  );
  await genesis.waitForDeployment();
  const genesisDeployed = await genesis.getAddress();
  console.log(`        ✅ GenesisBurn: ${genesisDeployed}`);

  console.log("  [6/7] Deploying HellBurnStaking...");
  const Staking = await ethers.getContractFactory("HellBurnStaking");
  const staking = await Staking.deploy(
    tokenDeployed,
    titanXAddr,
    dragonXAddr,
    deployer.address // guardian
  );
  await staking.waitForDeployment();
  const stakingDeployed = await staking.getAddress();
  console.log(`        ✅ Staking: ${stakingDeployed}`);

  console.log("  [7/7] Deploying BurnEpochs...");
  const block = await ethers.provider.getBlock("latest");
  const firstEpochStart = block.timestamp + 120; // starts in 2 minutes

  const BurnEpochs = await ethers.getContractFactory("BurnEpochs");
  const epochs = await BurnEpochs.deploy(
    titanXAddr,
    dragonXAddr,
    buyBurnDeployed,
    stakingDeployed,
    firstEpochStart,
    deployer.address // guardian
  );
  await epochs.waitForDeployment();
  const epochsDeployed = await epochs.getAddress();
  console.log(`        ✅ BurnEpochs: ${epochsDeployed}`);

  // ═══════════════════════════════════════════════════════════════
  //  PHASE 2: VERIFY ON ETHERSCAN
  // ═══════════════════════════════════════════════════════════════

  console.log("\n  ── PHASE 2: VERIFY ON ETHERSCAN ─────────────────\n");
  console.log(`        Waiting ${VERIFY_DELAY_MS / 1000}s for Etherscan to index bytecode...\n`);
  await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));

  const verifyResults = [];

  // 1. Mock TitanX
  verifyResults.push(
    await verify("Mock TitanX", titanXAddr, ["TitanX", "TITANX"])
  );

  // 2. Mock DragonX
  verifyResults.push(
    await verify("Mock DragonX", dragonXAddr, ["DragonX", "DRAGONX"])
  );

  // 3. BuyAndBurn
  verifyResults.push(
    await verify("BuyAndBurn", buyBurnDeployed, [
      deployer.address,
      deployer.address,
      tokenDeployed,
    ])
  );

  // 4. HellBurnToken
  verifyResults.push(
    await verify("HellBurnToken", tokenDeployed, [
      genesisDeployed,
      stakingDeployed,
      buyBurnDeployed,
    ])
  );

  // 5. GenesisBurn
  verifyResults.push(
    await verify("GenesisBurn", genesisDeployed, [
      titanXAddr,
      deployer.address,
      deployer.address,
      deployer.address,
      tokenDeployed,
    ])
  );

  // 6. HellBurnStaking
  verifyResults.push(
    await verify("HellBurnStaking", stakingDeployed, [
      tokenDeployed,
      titanXAddr,
      dragonXAddr,
      deployer.address,
    ])
  );

  // 7. BurnEpochs
  verifyResults.push(
    await verify("BurnEpochs", epochsDeployed, [
      titanXAddr,
      dragonXAddr,
      buyBurnDeployed,
      stakingDeployed,
      firstEpochStart,
      deployer.address,
    ])
  );

  const verified = verifyResults.filter(Boolean).length;
  const failed = verifyResults.length - verified;

  // ═══════════════════════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════════════════════

  const summary = {
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    mockTokens: {
      titanX: titanXAddr,
      dragonX: dragonXAddr,
    },
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
    },
    verification: {
      verified,
      failed,
    },
  };

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  🔥 TESTNET DEPLOYMENT + VERIFICATION COMPLETE");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Mock TitanX:     ${titanXAddr}`);
  console.log(`  Mock DragonX:    ${dragonXAddr}`);
  console.log(`  HellBurnToken:   ${tokenDeployed}`);
  console.log(`  GenesisBurn:     ${genesisDeployed}`);
  console.log(`  BurnEpochs:      ${epochsDeployed}`);
  console.log(`  HellBurnStaking: ${stakingDeployed}`);
  console.log(`  BuyAndBurn:      ${buyBurnDeployed}`);
  console.log(`  First Epoch:     ${summary.config.firstEpochDate}`);
  console.log(`  Verified:        ${verified}/7 ${failed > 0 ? `(${failed} failed)` : "✅ all green"}`);
  console.log("═══════════════════════════════════════════════════");
  console.log("");
  console.log("  📋 NEXT STEPS:");
  console.log("  1. Copy the addresses above into hellburn-ui/src/config/constants.js");
  console.log("  2. Update CHAIN_ID to 11155111 (Sepolia)");
  console.log("  3. npm run dev in hellburn-ui/");
  console.log("  4. Connect MetaMask (Sepolia) and start testing!");
  console.log("");
  console.log(`  💰 Your wallet has 100M TitanX + 100M DragonX for testing`);
  console.log(`  ⏱️  First Epoch starts in ~2 minutes`);

  if (failed > 0) {
    console.log("");
    console.log("  ⚠️  Some verifications failed. You can retry manually:");
    console.log("  npx hardhat verify --network sepolia <ADDRESS> <CONSTRUCTOR_ARGS>");
  }

  fs.writeFileSync("deployment-testnet.json", JSON.stringify(summary, null, 2));
  console.log("\n  📄 Saved to deployment-testnet.json");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });