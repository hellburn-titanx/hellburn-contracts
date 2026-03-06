/**
 * HellBurn BETA Testnet Deployment
 *
 * Automatically patches all contracts to use SHORT durations,
 * deploys to Sepolia, then restores originals.
 *
 * Timing:
 *   Genesis:  12 hours total (3h per "week")
 *   Vesting:  6 hours
 *   Epochs:   2 hours each
 *   Staking:  "days" become "hours" (min 1h, grace 1h)
 *
 * Full test flow in ~24 hours.
 *
 * Usage: npx hardhat run scripts/deploy-beta.js --network sepolia
 */

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

const MINT_AMOUNT = ethers.parseEther("100000000"); // 100M each
const VERIFY_DELAY_MS = 15_000;
const VERIFY_RETRIES = 3;

// ─── File Paths ─────────────────────────────────────────────────
const CONTRACT_DIR = path.join(__dirname, "..", "contracts");
const FILES = {
  genesis:  path.join(CONTRACT_DIR, "GenesisBurn.sol"),
  epochs:   path.join(CONTRACT_DIR, "BurnEpochs.sol"),
  staking:  path.join(CONTRACT_DIR, "HellBurnStaking.sol"),
};

// ─── Patches ────────────────────────────────────────────────────
// Each patch: [search, replace]
const PATCHES = {
  genesis: [
    // 28 days → 12 hours genesis
    ["GENESIS_DURATION = 28 days",  "GENESIS_DURATION = 12 hours"],
    // 28 days → 6 hours vesting
    ["VESTING_DURATION = 28 days",  "VESTING_DURATION = 6 hours"],
    // Weeks: 7 days → 3 hours (4 weeks × 3h = 12h)
    ["elapsed / 7 days",            "elapsed / 10800"],
  ],
  epochs: [
    // 8 days → 2 hours per epoch
    ["EPOCH_DURATION = 8 days",     "EPOCH_DURATION = 2 hours"],
  ],
  staking: [
    // "days" in stake duration → hours
    ["numDays * 1 days",            "numDays * 1 hours"],
    // Reading back: / 1 days → / 1 hours
    ["s.endTime - s.startTime) / 1 days", "s.endTime - s.startTime) / 1 hours"],
    // Min 28 days → 1 "hour-as-day"
    ["MIN_STAKE_DAYS = 28",         "MIN_STAKE_DAYS = 1"],
    // Max 3500 → 24 (= 24 hours max stake)
    ["MAX_STAKE_DAYS = 3500",       "MAX_STAKE_DAYS = 24"],
    // Grace period: 7 days → 1 hour
    ["GRACE_PERIOD = 7 days",       "GRACE_PERIOD = 1 hours"],
  ],
};

// ─── Patch / Restore Helpers ────────────────────────────────────
const backups = {};

function patchFiles() {
  console.log("  ── PATCHING CONTRACTS FOR BETA ──────────────────\n");

  for (const [name, filePath] of Object.entries(FILES)) {
    const original = fs.readFileSync(filePath, "utf-8");
    backups[name] = original;

    let patched = original;
    const patches = PATCHES[name] || [];
    for (const [search, replace] of patches) {
      if (!patched.includes(search)) {
        console.log(`    ⚠️  Pattern not found in ${name}: "${search}"`);
        continue;
      }
      patched = patched.replaceAll(search, replace);
      console.log(`    ✅ ${name}: "${search}" → "${replace}"`);
    }

    fs.writeFileSync(filePath, patched);
  }
  console.log("");
}

function restoreFiles() {
  console.log("\n  ── RESTORING ORIGINAL CONTRACTS ─────────────────\n");
  for (const [name, filePath] of Object.entries(FILES)) {
    if (backups[name]) {
      fs.writeFileSync(filePath, backups[name]);
      console.log(`    ✅ ${name} restored`);
    }
  }
}

// ─── Verify Helper ──────────────────────────────────────────────
async function verify(name, address, constructorArguments) {
  console.log(`        ⏳ Verifying ${name} (${address})...`);
  for (let attempt = 1; attempt <= VERIFY_RETRIES; attempt++) {
    try {
      await hre.run("verify:verify", { address, constructorArguments });
      console.log(`        ✅ ${name} verified`);
      return true;
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("Already Verified") || msg.includes("already verified")) {
        console.log(`        ✅ ${name} already verified`);
        return true;
      }
      if (attempt < VERIFY_RETRIES) {
        console.log(`        ⚠️  Attempt ${attempt}/${VERIFY_RETRIES} failed, retrying...`);
        await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
      } else {
        console.log(`        ❌ ${name} failed: ${msg.slice(0, 120)}`);
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
  console.log("  🔥 HELLBURN BETA DEPLOYMENT (SHORT TIMERS)");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Balance:   ${ethers.formatEther(balance)} ETH`);
  console.log(`  Network:   ${network.name} (${network.chainId})`);
  console.log("═══════════════════════════════════════════════════\n");

  console.log("  ⏱️  BETA TIMING:");
  console.log("  ┌──────────────────┬──────────────┬──────────────┐");
  console.log("  │ Parameter        │ Mainnet      │ Beta         │");
  console.log("  ├──────────────────┼──────────────┼──────────────┤");
  console.log("  │ Genesis Duration │ 28 days      │ 12 hours     │");
  console.log("  │ Genesis Weeks    │ 7 days each  │ 3 hours each │");
  console.log("  │ Vesting          │ 28 days      │ 6 hours      │");
  console.log("  │ Epoch Duration   │ 8 days       │ 2 hours      │");
  console.log("  │ Min Stake        │ 28 days      │ 1 hour       │");
  console.log("  │ Max Stake        │ 3500 days    │ 24 hours     │");
  console.log("  │ Grace Period     │ 7 days       │ 1 hour       │");
  console.log("  └──────────────────┴──────────────┴──────────────┘\n");

  // ═══ PATCH ═══
  patchFiles();

  try {
    // ═══ COMPILE ═══
    console.log("  ── COMPILING PATCHED CONTRACTS ──────────────────\n");
    await hre.run("compile", { force: true });
    console.log("");

    // ═══ DEPLOY ═══
    console.log("  ── DEPLOYING ────────────────────────────────────\n");

    // 1. Mock Tokens
    console.log("  [1/7] Mock TitanX...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const titanX = await MockERC20.deploy("TitanX", "TITANX");
    await titanX.waitForDeployment();
    const titanXAddr = await titanX.getAddress();
    console.log(`        ✅ ${titanXAddr}`);

    console.log("  [2/7] Mock DragonX...");
    const dragonX = await MockERC20.deploy("DragonX", "DRAGONX");
    await dragonX.waitForDeployment();
    const dragonXAddr = await dragonX.getAddress();
    console.log(`        ✅ ${dragonXAddr}`);

    await (await titanX.mint(deployer.address, MINT_AMOUNT)).wait();
    await (await dragonX.mint(deployer.address, MINT_AMOUNT)).wait();
    console.log(`        💰 Minted 100M of each\n`);

    // 2. Pre-calculate addresses
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const addr = (i) => ethers.getCreateAddress({ from: deployer.address, nonce: nonce + i });
    const buyBurnAddr = addr(0);
    const tokenAddr = addr(1);
    const genesisAddr = addr(2);
    const stakingAddr = addr(3);

    // 3. BuyAndBurn
    console.log("  [3/7] BuyAndBurn...");
    const BuyAndBurn = await ethers.getContractFactory("BuyAndBurn");
    const buyBurn = await BuyAndBurn.deploy(deployer.address, deployer.address, tokenAddr);
    await buyBurn.waitForDeployment();
    const buyBurnDeployed = await buyBurn.getAddress();
    console.log(`        ✅ ${buyBurnDeployed}`);

    // 4. HellBurnToken
    console.log("  [4/7] HellBurnToken...");
    const HellBurnToken = await ethers.getContractFactory("HellBurnToken");
    const token = await HellBurnToken.deploy(genesisAddr, stakingAddr, buyBurnAddr);
    await token.waitForDeployment();
    const tokenDeployed = await token.getAddress();
    console.log(`        ✅ ${tokenDeployed}`);

    // 5. GenesisBurn (Fair Launch: 8 params)
    console.log("  [5/7] GenesisBurn (12h duration, Fair Launch)...");
    const GenesisBurn = await ethers.getContractFactory("GenesisBurn");
    // On Sepolia: swapRouter, positionManager, weth use deployer as placeholder
    // LP creation only works on mainnet with real Uniswap V3 contracts
    const genesis = await GenesisBurn.deploy(
      titanXAddr,           // _titanX
      deployer.address,     // _dragonXVault
      deployer.address,     // _treasury
      tokenDeployed,        // _hburn
      deployer.address,     // _swapRouter (placeholder on testnet)
      deployer.address,     // _positionManager (placeholder on testnet)
      deployer.address,     // _weth (placeholder on testnet)
      3000                  // _titanXWethPoolFee (0.3%)
    );
    await genesis.waitForDeployment();
    const genesisDeployed = await genesis.getAddress();
    console.log(`        ✅ ${genesisDeployed}`);

    // 6. Staking
    console.log("  [6/7] HellBurnStaking (min 1h)...");
    const Staking = await ethers.getContractFactory("HellBurnStaking");
    const staking = await Staking.deploy(
      tokenDeployed, titanXAddr, dragonXAddr, deployer.address
    );
    await staking.waitForDeployment();
    const stakingDeployed = await staking.getAddress();
    console.log(`        ✅ ${stakingDeployed}`);

    // 7. BurnEpochs
    const block = await ethers.provider.getBlock("latest");
    const firstEpochStart = block.timestamp + 43500; // starts after genesis (12h + 5min buffer)
    console.log("  [7/7] BurnEpochs (2h epochs)...");
    const BurnEpochs = await ethers.getContractFactory("BurnEpochs");
    const epochs = await BurnEpochs.deploy(
      titanXAddr, dragonXAddr, buyBurnDeployed, stakingDeployed,
      firstEpochStart, deployer.address
    );
    await epochs.waitForDeployment();
    const epochsDeployed = await epochs.getAddress();
    console.log(`        ✅ ${epochsDeployed}\n`);

    // ═══ VERIFY ═══
    console.log("  ── VERIFYING ON ETHERSCAN ───────────────────────\n");
    console.log(`        Waiting ${VERIFY_DELAY_MS / 1000}s...\n`);
    await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));

    await verify("Mock TitanX", titanXAddr, ["TitanX", "TITANX"]);
    await verify("Mock DragonX", dragonXAddr, ["DragonX", "DRAGONX"]);
    await verify("BuyAndBurn", buyBurnDeployed, [deployer.address, deployer.address, tokenDeployed]);
    await verify("HellBurnToken", tokenDeployed, [genesisDeployed, stakingDeployed, buyBurnDeployed]);
    await verify("GenesisBurn", genesisDeployed, [titanXAddr, deployer.address, deployer.address, tokenDeployed, deployer.address, deployer.address, deployer.address, 3000]);
    await verify("HellBurnStaking", stakingDeployed, [tokenDeployed, titanXAddr, dragonXAddr, deployer.address]);
    await verify("BurnEpochs", epochsDeployed, [titanXAddr, dragonXAddr, buyBurnDeployed, stakingDeployed, firstEpochStart, deployer.address]);

    // ═══ SUMMARY ═══
    const summary = {
      mode: "BETA",
      network: network.name,
      chainId: Number(network.chainId),
      deployer: deployer.address,
      deployedAt: new Date().toISOString(),
      timing: {
        genesis: "12 hours",
        vesting: "6 hours",
        weekDuration: "3 hours",
        epochDuration: "2 hours",
        minStake: "1 hour",
        maxStake: "24 hours",
        gracePeriod: "1 hour",
      },
      mockTokens: { titanX: titanXAddr, dragonX: dragonXAddr },
      contracts: {
        HellBurnToken: tokenDeployed,
        GenesisBurn: genesisDeployed,
        BurnEpochs: epochsDeployed,
        HellBurnStaking: stakingDeployed,
        BuyAndBurn: buyBurnDeployed,
      },
      firstEpochStart,
    };

    console.log("\n═══════════════════════════════════════════════════");
    console.log("  🔥 BETA DEPLOYMENT COMPLETE");
    console.log("═══════════════════════════════════════════════════");
    console.log(`  Mock TitanX:     ${titanXAddr}`);
    console.log(`  Mock DragonX:    ${dragonXAddr}`);
    console.log(`  HellBurnToken:   ${tokenDeployed}`);
    console.log(`  GenesisBurn:     ${genesisDeployed}`);
    console.log(`  BurnEpochs:      ${epochsDeployed}`);
    console.log(`  HellBurnStaking: ${stakingDeployed}`);
    console.log(`  BuyAndBurn:      ${buyBurnDeployed}`);
    console.log("═══════════════════════════════════════════════════\n");
    console.log("  ⏱️  BETA TESTER FLOW:");
    console.log("  ┌──────────┬──────────────────────────────────────┐");
    console.log("  │  0:00    │ Mint TitanX/DragonX via Faucet       │");
    console.log("  │  0:01    │ Genesis Burn → get HBURN (Week 1)    │");
    console.log("  │  3:00    │ Week 2 starts (bonus drops)          │");
    console.log("  │  6:00    │ All vesting from hour-0 complete     │");
    console.log("  │ 12:00    │ Genesis ends → call endGenesis()     │");
    console.log("  │ 12:05    │ Epoch 1 starts → burn for ETH        │");
    console.log("  │ 14:05    │ Epoch 1 ends → claim ETH rewards     │");
    console.log("  │ 14:05    │ Epoch 2 starts → streak = 2 (1.2x)   │");
    console.log("  │ anytime  │ Stake HBURN (1 hour minimum)         │");
    console.log("  │ +1h      │ Unstake → check rewards & penalties  │");
    console.log("  │ ~24h     │ Full lifecycle tested!                │");
    console.log("  └──────────┴──────────────────────────────────────┘\n");
    console.log("  📋 NEXT STEPS:");
    console.log("  1. node scripts/sync-addresses.js");
    console.log("  2. cd ../hellburn-ui && npm run dev");
    console.log("  3. Share Sepolia ETH faucet link with testers");
    console.log("  4. Testers use in-app Token Faucet for TitanX/DragonX\n");

    fs.writeFileSync("deployment-beta.json", JSON.stringify(summary, null, 2));
    // Also write as deployment-testnet.json so sync-addresses.js works
    fs.writeFileSync("deployment-testnet.json", JSON.stringify(summary, null, 2));
    console.log("  📄 Saved to deployment-beta.json + deployment-testnet.json");

  } finally {
    // ═══ ALWAYS RESTORE ═══
    restoreFiles();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    // Still restore on error
    restoreFiles();
    process.exit(1);
  });
