/**
 * Address Sync — deployment-testnet.json → UI constants.js
 *
 * Reads the deployment output and patches hellburn-ui/src/config/constants.js
 * with the correct contract + mock token addresses.
 *
 * Usage: node scripts/sync-addresses.js
 *
 * Full workflow after contract changes:
 *   npx hardhat compile
 *   npx hardhat run scripts/deploy-testnet.js --network sepolia
 *   node scripts/sync-abis.js
 *   node scripts/sync-addresses.js
 */

const fs = require("fs");
const path = require("path");

const DEPLOYMENT_FILE = path.resolve(__dirname, "../deployment-testnet.json");
const CONSTANTS_FILE = path.resolve(__dirname, "../../hellburn-ui/src/config/constants.js");

function main() {
  console.log("🔥 Address Sync — deployment → hellburn-ui\n");

  // ─── Read deployment ──────────────────────────────────────────
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    console.log("  ❌ deployment-testnet.json not found.");
    console.log("     Run deploy-testnet.js first:");
    console.log("     npx hardhat run scripts/deploy-testnet.js --network sepolia");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf-8"));
  const { contracts, mockTokens, config, chainId } = deployment;

  console.log(`  📄 Read deployment-testnet.json`);
  console.log(`     Network: chainId ${chainId}`);
  console.log(`     Deployed: ${deployment.deployedAt || "unknown"}\n`);

  // ─── Read current constants.js ────────────────────────────────
  if (!fs.existsSync(CONSTANTS_FILE)) {
    console.log("  ❌ hellburn-ui/src/config/constants.js not found.");
    console.log("     Is hellburn-ui/ next to hellburn-contracts/?");
    process.exit(1);
  }

  let source = fs.readFileSync(CONSTANTS_FILE, "utf-8");

  // ─── Replace addresses ────────────────────────────────────────
  const replacements = [
    ["hellBurnToken", contracts.HellBurnToken],
    ["genesisBurn", contracts.GenesisBurn],
    ["burnEpochs", contracts.BurnEpochs],
    ["hellBurnStaking", contracts.HellBurnStaking],
    ["buyAndBurn", contracts.BuyAndBurn],
    ["titanX", mockTokens.titanX],
    ["dragonX", mockTokens.dragonX],
  ];

  let updated = 0;
  for (const [key, newAddr] of replacements) {
    // Match:  key: "0x..."  with any address
    const regex = new RegExp(`(${key}:\\s*)"0x[a-fA-F0-9]+"`, "g");
    const before = source;
    source = source.replace(regex, `$1"${newAddr}"`);
    if (source !== before) {
      console.log(`  ✅ ${key}: ${newAddr}`);
      updated++;
    } else {
      console.log(`  ⚠️  ${key}: pattern not found in constants.js`);
    }
  }

  // ─── Update chain info ────────────────────────────────────────
  const chainName = chainId === 1 ? "Mainnet" : chainId === 11155111 ? "Sepolia" : `Chain ${chainId}`;

  source = source.replace(
    /CHAIN_ID\s*=\s*\d+/,
    `CHAIN_ID = ${chainId}`
  );
  source = source.replace(
    /CHAIN_NAME\s*=\s*"[^"]*"/,
    `CHAIN_NAME = "${chainName}"`
  );

  // ─── Write back ───────────────────────────────────────────────
  fs.writeFileSync(CONSTANTS_FILE, source);

  console.log(`\n  📄 Written to: ${CONSTANTS_FILE}`);
  console.log(`  📊 ${updated}/7 addresses updated, chain = ${chainName} (${chainId})`);

  if (config?.firstEpochDate) {
    console.log(`  ⏱️  First Epoch: ${config.firstEpochDate}`);
  }

  console.log("\n  Done! Restart `npm run dev` to see changes. ✅");
}

main();