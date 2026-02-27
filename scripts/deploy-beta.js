/**
 * HellBurn BETA Testnet Deployment
 *
 * Automatically patches all contracts to use SHORT durations,
 * deploys to Sepolia, then restores originals.
 *
 * Timing:
 *   Genesis:  10 minutes total (2.5 min per "week")
 *   Vesting:  5 minutes
 *   Epochs:   3 minutes each
 *   Staking:  "days" become "minutes" (min 2 min, grace 2 min)
 *
 * Full test flow in ~30 minutes.
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
    // 28 days → 10 minutes genesis
    ["GENESIS_DURATION = 28 days",  "GENESIS_DURATION = 10 minutes"],
    // 28 days → 5 minutes vesting
    ["VESTING_DURATION = 28 days",  "VESTING_DURATION = 5 minutes"],
    // Weeks: 7 days → 150 seconds (2.5 min per "week", 4 weeks = 10 min)
    ["elapsed / 7 days",            "elapsed / 150"],
  ],
  epochs: [
    // 8 days → 3 minutes per epoch
    ["EPOCH_DURATION = 8 days",     "EPOCH_DURATION = 3 minutes"],
  ],
  staking: [
    // "days" in stake duration → minutes
    // numDays * 1 days → numDays * 1 minutes
    ["numDays * 1 days",            "numDays * 1 minutes"],
    // Reading back: / 1 days → / 1 minutes
    ["s.endTime - s.startTime) / 1 days", "s.endTime - s.startTime) / 1 minutes"],
    // Min 28 days → 2 "minutes-as-days"
    ["MIN_STAKE_DAYS = 28",         "MIN_STAKE_DAYS = 2"],
    // Max 3500 → 60 (= 60 minutes = 1 hour max stake)
    ["MAX_STAKE_DAYS = 3500",       "MAX_STAKE_DAYS = 60"],
    // Grace period: 7 days → 2 minutes
    ["GRACE_PERIOD = 7 days",       "GRACE_PERIOD = 2 minutes"],
    // Max time bonus stays 3500 for formula, but adjust
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
  console.log("  │ Genesis Duration │ 28 days      │ 10 minutes   │");
  console.log("  │ Genesis Weeks    │ 7 days each  │ 2.5 min each │");
  console.log("  │ Vesting          │ 28 days      │ 5 minutes    │");
  console.log("  │ Epoch Duration   │ 8 days       │ 3 minutes    │");
  console.log("  │ Min Stake        │ 28 days      │ 2 minutes    │");
  console.log("  │ Max Stake        │ 3500 days    │ 60 minutes   │");
  console.log("  │ Grace Period     │ 7 days       │ 2 minutes    │");
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

    // 5. GenesisBurn
    console.log("  [5/7] GenesisBurn (10 min duration)...");
    const GenesisBurn = await ethers.getContractFactory("GenesisBurn");
    const genesis = await GenesisBurn.deploy(
      titanXAddr, deployer.address, deployer.address, deployer.address, tokenDeployed
    );
    await genesis.waitForDeployment();
    const genesisDeployed = await genesis.getAddress();
    console.log(`        ✅ ${genesisDeployed}`);

    // 6. Staking
    console.log("  [6/7] HellBurnStaking (min 2 min)...");
    const Staking = await ethers.getContractFactory("HellBurnStaking");
    const staking = await Staking.deploy(
      tokenDeployed, titanXAddr, dragonXAddr, deployer.address
    );
    await staking.waitForDeployment();
    const stakingDeployed = await staking.getAddress();
    console.log(`        ✅ ${stakingDeployed}`);

    // 7. BurnEpochs
    const block = await ethers.provider.getBlock("latest");
    const firstEpochStart = block.timestamp + 660; // starts after genesis (10 min + 1 min buffer)
    console.log("  [7/7] BurnEpochs (3 min epochs)...");
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
    await verify("GenesisBurn", genesisDeployed, [titanXAddr, deployer.address, deployer.address, deployer.address, tokenDeployed]);
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
        genesis: "10 minutes",
        vesting: "5 minutes",
        weekDuration: "2.5 minutes",
        epochDuration: "3 minutes",
        minStake: "2 minutes",
        maxStake: "60 minutes",
        gracePeriod: "2 minutes",
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
    console.log("  ┌─────────┬──────────────────────────────────────┐");
    console.log("  │  0:00   │ Mint TitanX/DragonX via Faucet       │");
    console.log("  │  0:01   │ Genesis Burn → get HBURN (Week 1)    │");
    console.log("  │  0:02   │ Claim vested HBURN (starts unlocking)│");
    console.log("  │  0:05   │ All vesting complete                 │");
    console.log("  │  0:10   │ Genesis ends automatically           │");
    console.log("  │  0:11   │ Epoch 1 starts → burn for ETH        │");
    console.log("  │  0:14   │ Epoch 1 ends → claim ETH rewards     │");
    console.log("  │  0:14   │ Epoch 2 starts → streak = 2 (1.2x)   │");
    console.log("  │  0:17   │ Epoch 2 ends → claim, streak grows   │");
    console.log("  │  0:15   │ Stake HBURN (2 min minimum)          │");
    console.log("  │  0:17   │ Unstake → check rewards & penalties  │");
    console.log("  │  ~0:30  │ Full lifecycle tested!                │");
    console.log("  └─────────┴──────────────────────────────────────┘\n");
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
