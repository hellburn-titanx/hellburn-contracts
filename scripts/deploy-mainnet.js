/**
 * HellBurn MAINNET Deployment — Trustless v4.0
 *
 * FULLY TRUSTLESS: No admin, no guardian, no pause, no treasury withdrawal.
 * All contracts are immutable once deployed.
 *
 * Usage: npx hardhat run scripts/deploy-mainnet.js --network mainnet
 */

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const readline = require("readline");

// ═══ MAINNET ADDRESSES ═══
const MAINNET = {
  titanX:          "0xF19308F923582A6f7c465e5CE7a9Dc1BEC6665B1",
  dragonX:         "0x96a5399D07896f757Bd4c6eF56461F58DB951862",
  swapRouter:      "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  weth:            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  titanXWethPoolFee: 10000, // 1% fee tier
};

// DragonX Vault = DragonX contract itself (standard in TitanX ecosystem)
const DRAGONX_VAULT = MAINNET.dragonX;

const VERIFY_DELAY_MS = 30_000;
const VERIFY_RETRIES = 5;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function confirm(message) {
  const answer = await ask(`\n  ⚠️  ${message}\n  Type "YES" to continue: `);
  if (answer.trim() !== "YES") { console.log("\n  ❌ Aborted.\n"); process.exit(0); }
}

async function verify(name, address, constructorArguments) {
  console.log(`        ⏳ Verifying ${name}...`);
  for (let attempt = 1; attempt <= VERIFY_RETRIES; attempt++) {
    try {
      await hre.run("verify:verify", { address, constructorArguments });
      console.log(`        ✅ ${name} verified`);
      return;
    } catch (err) {
      if (err.message?.includes("already verified") || err.message?.includes("Already Verified")) {
        console.log(`        ✅ ${name} already verified`); return;
      }
      if (attempt < VERIFY_RETRIES) {
        console.log(`        ⚠️  Retry ${attempt}/${VERIFY_RETRIES}...`);
        await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
      } else { console.log(`        ❌ ${name} failed: ${err.message?.slice(0, 100)}`); }
    }
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (chainId !== 1) {
    console.error(`\n  ❌ Wrong network! Expected 1, got ${chainId}\n`);
    process.exit(1);
  }

  const balETH = parseFloat(ethers.formatEther(balance));
  if (balETH < 0.3) {
    console.error(`\n  ❌ Insufficient: ${balETH.toFixed(4)} ETH (need ~0.5)\n`);
    process.exit(1);
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  🔥 HELLBURN — TRUSTLESS MAINNET DEPLOYMENT v4.0");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Network:     Ethereum Mainnet`);
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  Balance:     ${balETH.toFixed(4)} ETH`);
  console.log("───────────────────────────────────────────────────────");
  console.log("  🔒 TRUSTLESS: No admin, no guardian, no pause");
  console.log("  🔒 Treasury 22%: Auto-staked in contract, yield → BuyBurn");
  console.log("  🔒 LP: Auto-created at endGenesis(), locked forever");
  console.log("═══════════════════════════════════════════════════════\n");

  await confirm("MAINNET deployment with REAL ETH. Continue?");

  console.log("\n  ── COMPILING ────────────────────────────────────────\n");
  await hre.run("compile", { force: true });

  // ── Pre-calculate Addresses ──
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const addr = (i) => ethers.getCreateAddress({ from: deployer.address, nonce: nonce + i });
  const buyBurnAddr  = addr(0);
  const tokenAddr    = addr(1);
  const genesisAddr  = addr(2);
  const stakingAddr  = addr(3);

  console.log("\n  ── DEPLOYING 5 CONTRACTS ────────────────────────────\n");

  // 1. BuyAndBurn
  console.log("  [1/5] BuyAndBurn...");
  const BuyAndBurn = await ethers.getContractFactory("BuyAndBurn");
  const buyBurn = await BuyAndBurn.deploy(MAINNET.swapRouter, MAINNET.weth, tokenAddr);
  await buyBurn.waitForDeployment();
  const buyBurnDeployed = await buyBurn.getAddress();
  console.log(`        ✅ ${buyBurnDeployed}`);

  // 2. HellBurnToken
  console.log("  [2/5] HellBurnToken...");
  const HellBurnToken = await ethers.getContractFactory("HellBurnToken");
  const token = await HellBurnToken.deploy(genesisAddr, stakingAddr, buyBurnAddr);
  await token.waitForDeployment();
  const tokenDeployed = await token.getAddress();
  console.log(`        ✅ ${tokenDeployed}`);

  // 3. GenesisBurn (TRUSTLESS — 8 params)
  console.log("  [3/5] GenesisBurn (Trustless)...");
  const GenesisBurn = await ethers.getContractFactory("GenesisBurn");
  const genesis = await GenesisBurn.deploy(
    MAINNET.titanX,            // _titanX
    DRAGONX_VAULT,             // _dragonXVault
    tokenDeployed,             // _hburn
    MAINNET.swapRouter,        // _swapRouter
    MAINNET.positionManager,   // _positionManager
    MAINNET.weth,              // _weth
    MAINNET.titanXWethPoolFee, // _titanXWethPoolFee
    buyBurnDeployed            // _buyAndBurn
  );
  await genesis.waitForDeployment();
  const genesisDeployed = await genesis.getAddress();
  console.log(`        ✅ ${genesisDeployed}`);

  // 4. HellBurnStaking (NO guardian)
  console.log("  [4/5] HellBurnStaking (no guardian)...");
  const Staking = await ethers.getContractFactory("HellBurnStaking");
  const staking = await Staking.deploy(tokenDeployed, MAINNET.titanX, MAINNET.dragonX);
  await staking.waitForDeployment();
  const stakingDeployed = await staking.getAddress();
  console.log(`        ✅ ${stakingDeployed}`);

  // 5. BurnEpochs (NO guardian)
  const block = await ethers.provider.getBlock("latest");
  const GENESIS_DURATION = 28 * 24 * 3600;
  const BUFFER = 3600;
  const firstEpochStart = block.timestamp + GENESIS_DURATION + BUFFER;

  console.log("  [5/5] BurnEpochs (no guardian)...");
  const BurnEpochs = await ethers.getContractFactory("BurnEpochs");
  const epochs = await BurnEpochs.deploy(
    MAINNET.titanX, MAINNET.dragonX, buyBurnDeployed, stakingDeployed, firstEpochStart
  );
  await epochs.waitForDeployment();
  const epochsDeployed = await epochs.getAddress();
  console.log(`        ✅ ${epochsDeployed}\n`);

  // ── Verify Address Predictions ──
  const checks = [
    ["BuyAndBurn", buyBurnAddr, buyBurnDeployed],
    ["HellBurnToken", tokenAddr, tokenDeployed],
    ["GenesisBurn", genesisAddr, genesisDeployed],
    ["Staking", stakingAddr, stakingDeployed],
  ];
  let allMatch = true;
  for (const [name, predicted, actual] of checks) {
    const match = predicted.toLowerCase() === actual.toLowerCase();
    console.log(`    ${match ? "✅" : "❌"} ${name}: ${match ? "MATCH" : "MISMATCH!"}`);
    if (!match) allMatch = false;
  }
  if (!allMatch) { console.error("\n  ❌ ADDRESS MISMATCH!\n"); process.exit(1); }

  // ── Etherscan Verify ──
  console.log(`\n  ── ETHERSCAN VERIFY (waiting ${VERIFY_DELAY_MS/1000}s) ──\n`);
  await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));

  await verify("BuyAndBurn", buyBurnDeployed, [MAINNET.swapRouter, MAINNET.weth, tokenDeployed]);
  await verify("HellBurnToken", tokenDeployed, [genesisDeployed, stakingDeployed, buyBurnDeployed]);
  await verify("GenesisBurn", genesisDeployed, [
    MAINNET.titanX, DRAGONX_VAULT, tokenDeployed,
    MAINNET.swapRouter, MAINNET.positionManager, MAINNET.weth,
    MAINNET.titanXWethPoolFee, buyBurnDeployed
  ]);
  await verify("HellBurnStaking", stakingDeployed, [tokenDeployed, MAINNET.titanX, MAINNET.dragonX]);
  await verify("BurnEpochs", epochsDeployed, [
    MAINNET.titanX, MAINNET.dragonX, buyBurnDeployed, stakingDeployed, firstEpochStart
  ]);

  // ── Summary ──
  const summary = {
    mode: "MAINNET", version: "Trustless v4.0",
    chainId: 1, deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      HellBurnToken: tokenDeployed, GenesisBurn: genesisDeployed,
      BurnEpochs: epochsDeployed, HellBurnStaking: stakingDeployed,
      BuyAndBurn: buyBurnDeployed,
    },
    ecosystem: { titanX: MAINNET.titanX, dragonX: MAINNET.dragonX },
    firstEpochStart, firstEpochStartISO: new Date(firstEpochStart * 1000).toISOString(),
  };

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  🔥 TRUSTLESS DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  HellBurnToken:   ${tokenDeployed}`);
  console.log(`  GenesisBurn:     ${genesisDeployed}`);
  console.log(`  BurnEpochs:      ${epochsDeployed}`);
  console.log(`  HellBurnStaking: ${stakingDeployed}`);
  console.log(`  BuyAndBurn:      ${buyBurnDeployed}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("  ⏰ Genesis: LIVE NOW → 28 days");
  console.log("  🔒 No admin, no guardian, no pause — FULLY TRUSTLESS");
  console.log("═══════════════════════════════════════════════════════\n");
  console.log("  📋 POST-DEPLOY:");
  console.log("  1. node scripts/sync-addresses.js");
  console.log("  2. Update UI constants → mainnet");
  console.log("  3. Deploy UI to production");
  console.log("  4. Test genesis burn (small amount)");
  console.log("  5. After 28d: anyone calls endGenesis(minWETH)");
  console.log("  6. Then: anyone calls stakeTreasury()");
  console.log("  7. Periodically: anyone calls claimTreasuryYield()\n");

  fs.writeFileSync("deployment-mainnet.json", JSON.stringify(summary, null, 2));
  console.log("  📄 Saved to deployment-mainnet.json\n");
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
