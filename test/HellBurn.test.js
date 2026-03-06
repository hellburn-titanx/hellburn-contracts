const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const DAY = 86400;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const INITIAL_BALANCE = ethers.parseEther("10000000"); // 10M
const LP_RESERVE_PCT = 3n;

// Helper: calculate expected HBURN amounts with LP reserve
function calcGenesis(titanXAmount, week) {
  const ratios = [100n, 95n, 90n, 85n];
  const bonuses = [115n, 110n, 105n, 100n];
  const w = Math.max(0, Math.min(3, week - 1));
  const total = (titanXAmount * ratios[w] * bonuses[w]) / 10000n;
  const lpReserve = (total * LP_RESERVE_PCT) / 100n;
  const userAmount = total - lpReserve;
  const immediate = (userAmount * 25n) / 100n;
  const vested = userAmount - immediate;
  return { total, lpReserve, userAmount, immediate, vested };
}

describe("🔥 HellBurn Protocol — Full Test Suite (Fair Launch)", function () {
  let deployer, alice, bob, charlie, guardian;
  let titanX, dragonX, hburn, genesis, staking, epochs, buyBurn;
  let mockWeth, mockRouter, mockPositionManager;

  // ═══════════════════════════════════════════════════════════════
  //  SHARED SETUP
  // ═══════════════════════════════════════════════════════════════
  async function deployAll() {
    [deployer, alice, bob, charlie, guardian] = await ethers.getSigners();

    // ── Mock Tokens ──
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    titanX = await MockERC20.deploy("TitanX", "TITANX");
    dragonX = await MockERC20.deploy("DragonX", "DRAGONX");

    for (const u of [alice, bob, charlie]) {
      await titanX.mint(u.address, INITIAL_BALANCE);
      await dragonX.mint(u.address, INITIAL_BALANCE);
    }

    // ── Mock Uniswap ──
    const MockWETH = await ethers.getContractFactory("MockWETH");
    mockWeth = await MockWETH.deploy();

    const MockRouter = await ethers.getContractFactory("MockSwapRouter");
    mockRouter = await MockRouter.deploy(await mockWeth.getAddress());

    // Pre-fund router with WETH for TitanX→WETH swaps
    await mockWeth.mint(await mockRouter.getAddress(), ethers.parseEther("1000"));

    const MockPM = await ethers.getContractFactory("MockNonfungiblePositionManager");
    mockPositionManager = await MockPM.deploy();

    // ── Pre-calculate addresses ──
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const buyBurnAddr = ethers.getCreateAddress({ from: deployer.address, nonce });
    const tokenAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    const genesisAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });
    const stakingAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 3 });

    // ── 0: BuyAndBurn ──
    const BuyAndBurn = await ethers.getContractFactory("BuyAndBurn");
    buyBurn = await BuyAndBurn.deploy(
      await mockRouter.getAddress(),
      await mockWeth.getAddress(),
      tokenAddr
    );

    // ── 1: HellBurnToken ──
    const HellBurnToken = await ethers.getContractFactory("HellBurnToken");
    hburn = await HellBurnToken.deploy(genesisAddr, stakingAddr, buyBurnAddr);

    // ── 2: GenesisBurn (Fair Launch — 8 params) ──
    const GenesisBurn = await ethers.getContractFactory("GenesisBurn");
    genesis = await GenesisBurn.deploy(
      await titanX.getAddress(),       // _titanX
      deployer.address,                // _dragonXVault
      deployer.address,                // _treasury
      await hburn.getAddress(),        // _hburn
      await mockRouter.getAddress(),   // _swapRouter
      await mockPositionManager.getAddress(), // _positionManager
      await mockWeth.getAddress(),     // _weth
      3000                             // _titanXWethPoolFee
    );

    // ── 3: HellBurnStaking ──
    const Staking = await ethers.getContractFactory("HellBurnStaking");
    staking = await Staking.deploy(
      await hburn.getAddress(),
      await titanX.getAddress(),
      await dragonX.getAddress(),
      guardian.address
    );

    // ── 4: BurnEpochs ──
    const firstEpoch = (await time.latest()) + DAY;
    const BurnEpochs = await ethers.getContractFactory("BurnEpochs");
    epochs = await BurnEpochs.deploy(
      await titanX.getAddress(),
      await dragonX.getAddress(),
      await buyBurn.getAddress(),
      await staking.getAddress(),
      firstEpoch,
      guardian.address
    );

    // ── Approvals ──
    const ga = await genesis.getAddress();
    const ea = await epochs.getAddress();
    const sa = await staking.getAddress();

    for (const u of [alice, bob, charlie]) {
      await titanX.connect(u).approve(ga, ethers.MaxUint256);
      await titanX.connect(u).approve(ea, ethers.MaxUint256);
      await titanX.connect(u).approve(sa, ethers.MaxUint256);
      await dragonX.connect(u).approve(ea, ethers.MaxUint256);
      await dragonX.connect(u).approve(sa, ethers.MaxUint256);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  1. HELLBURN TOKEN
  // ═══════════════════════════════════════════════════════════════
  describe("1. HellBurnToken", function () {
    beforeEach(deployAll);

    it("has correct name, symbol and zero initial supply", async function () {
      expect(await hburn.name()).to.equal("HellBurn");
      expect(await hburn.symbol()).to.equal("HBURN");
      expect(await hburn.totalSupply()).to.equal(0);
    });

    it("allows genesis contract to mint", async function () {
      await genesis.connect(alice).burn(ethers.parseEther("100000"));
      expect(await hburn.totalSupply()).to.be.gt(0);
    });

    it("rejects mint from non-genesis address", async function () {
      await expect(hburn.mint(alice.address, 1000))
        .to.be.revertedWithCustomError(hburn, "OnlyGenesis");
    });

    it("rejects mint from deployer", async function () {
      await expect(hburn.connect(deployer).mint(alice.address, 1000))
        .to.be.revertedWithCustomError(hburn, "OnlyGenesis");
    });

    it("permanently disables minting after genesis ends", async function () {
      await time.increase(29 * DAY);
      await genesis.endGenesis(0);
      expect(await hburn.genesisMintingEnded()).to.be.true;
    });

    it("emits event on minting end", async function () {
      await genesis.connect(alice).burn(ethers.parseEther("1000"));
      await time.increase(29 * DAY);

      await expect(genesis.endGenesis(0))
        .to.emit(hburn, "GenesisMintingPermanentlyEnded");
    });

    it("supports ERC20Burnable (anyone can burn own tokens)", async function () {
      await genesis.connect(alice).burn(ethers.parseEther("100000"));
      const bal = await hburn.balanceOf(alice.address);
      expect(bal).to.be.gt(0);

      await hburn.connect(alice).burn(bal);
      expect(await hburn.balanceOf(alice.address)).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  2. GENESIS BURN (with Fair Launch LP Reserve)
  // ═══════════════════════════════════════════════════════════════
  describe("2. GenesisBurn", function () {
    beforeEach(deployAll);

    describe("Burn & Mint (97% to user, 3% LP reserve)", function () {
      it("mints HBURN at week 1 ratio with LP reserve", async function () {
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 1);

        await genesis.connect(alice).burn(amt);

        // User gets 97% of 115000, immediate 25% of that
        expect(await hburn.balanceOf(alice.address)).to.equal(expected.immediate);
        expect(await genesis.lpReserveHBURN()).to.equal(expected.lpReserve);
      });

      it("mints at week 2 ratio with LP reserve", async function () {
        await time.increase(7 * DAY);
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 2);

        await genesis.connect(alice).burn(amt);
        expect(await hburn.balanceOf(alice.address)).to.equal(expected.immediate);
      });

      it("mints at week 3 ratio with LP reserve", async function () {
        await time.increase(14 * DAY);
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 3);

        await genesis.connect(alice).burn(amt);
        expect(await hburn.balanceOf(alice.address)).to.equal(expected.immediate);
      });

      it("mints at week 4 ratio with LP reserve", async function () {
        await time.increase(21 * DAY);
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 4);

        await genesis.connect(alice).burn(amt);
        expect(await hburn.balanceOf(alice.address)).to.equal(expected.immediate);
      });

      it("accumulates LP reserve over multiple burns", async function () {
        const amt = ethers.parseEther("50000");
        const e1 = calcGenesis(amt, 1);

        await genesis.connect(alice).burn(amt);
        await genesis.connect(bob).burn(amt);

        expect(await genesis.lpReserveHBURN()).to.equal(e1.lpReserve * 2n);
      });

      it("rejects zero amount", async function () {
        await expect(genesis.connect(alice).burn(0))
          .to.be.revertedWithCustomError(genesis, "ZeroAmount");
      });

      it("rejects burn after genesis ends", async function () {
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);

        await expect(genesis.connect(alice).burn(ethers.parseEther("1000")))
          .to.be.revertedWithCustomError(genesis, "GenesisAlreadyEnded");
      });

      it("emits GenesisBurnExecuted event with LP reserve amount", async function () {
        const amt = ethers.parseEther("10000");
        const expected = calcGenesis(amt, 1);

        await expect(genesis.connect(alice).burn(amt))
          .to.emit(genesis, "GenesisBurnExecuted")
          .withArgs(
            alice.address, amt, expected.total,
            expected.immediate, expected.vested, expected.lpReserve, 1
          );
      });

      it("tracks totalTitanXBurned and totalHBURNMinted", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("50000"));
        await genesis.connect(bob).burn(ethers.parseEther("30000"));

        expect(await genesis.totalTitanXBurned())
          .to.equal(ethers.parseEther("80000"));
        expect(await genesis.totalHBURNMinted()).to.be.gt(0);
      });
    });

    describe("TitanX Distribution (Fair Launch)", function () {
      it("sends 35% to dead address (permanent burn)", async function () {
        const deadBefore = await titanX.balanceOf(DEAD);
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        const deadAfter = await titanX.balanceOf(DEAD);

        expect(deadAfter - deadBefore).to.equal(ethers.parseEther("35000"));
      });

      it("sends 35% to DragonX vault + 22% to treasury", async function () {
        const vaultBefore = await titanX.balanceOf(deployer.address);
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        const vaultAfter = await titanX.balanceOf(deployer.address);

        // deployer is both dragonX vault AND treasury = 35% + 22% = 57%
        expect(vaultAfter - vaultBefore).to.equal(ethers.parseEther("57000"));
      });

      it("keeps 8% (Genesis Fund) in the contract for LP", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));

        // 8% = 8000 TitanX stays in contract
        expect(await genesis.genesisFundTitanX()).to.equal(ethers.parseEther("8000"));
        expect(await titanX.balanceOf(await genesis.getAddress()))
          .to.equal(ethers.parseEther("8000"));
      });

      it("accumulates Genesis Fund across multiple burns", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await genesis.connect(bob).burn(ethers.parseEther("50000"));

        // 8% of 150K = 12K
        expect(await genesis.genesisFundTitanX()).to.equal(ethers.parseEther("12000"));
      });
    });

    describe("Vesting (per-tranche, 97% base)", function () {
      it("vests 75% of user amount linearly over 28 days", async function () {
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 1);

        await genesis.connect(alice).burn(amt);

        // After 14 days → ~50% of vested claimable
        await time.increase(14 * DAY);
        const claimable = await genesis.claimableAmount(alice.address);
        const halfVested = expected.vested / 2n;
        expect(claimable).to.be.closeTo(halfVested, halfVested / 50n);
      });

      it("allows full claim after 28 days", async function () {
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 1);

        await genesis.connect(alice).burn(amt);
        await time.increase(28 * DAY);

        await genesis.connect(alice).claimVested();
        // immediate + vested = userAmount
        expect(await hburn.balanceOf(alice.address))
          .to.equal(expected.userAmount);
      });

      it("creates separate tranches for multiple burns (H-01 fix)", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("50000"));
        await time.increase(14 * DAY);
        await genesis.connect(alice).burn(ethers.parseEther("50000"));

        expect(await genesis.getUserTrancheCount(alice.address)).to.equal(2);

        const claimable = await genesis.claimableAmount(alice.address);
        // Week 1 tranche: 14/28 = 50% of vested
        const e1 = calcGenesis(ethers.parseEther("50000"), 1);
        const halfWeek1 = e1.vested / 2n;
        // Week 3 tranche: 0/28 = 0%
        expect(claimable).to.be.closeTo(halfWeek1, halfWeek1 / 50n);
      });

      it("reverts claim when nothing to claim", async function () {
        await expect(genesis.connect(alice).claimVested())
          .to.be.revertedWithCustomError(genesis, "NothingToClaim");
      });

      it("allows partial claims over time", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));

        await time.increase(7 * DAY);
        await genesis.connect(alice).claimVested();
        const bal1 = await hburn.balanceOf(alice.address);

        await time.increase(7 * DAY);
        await genesis.connect(alice).claimVested();
        const bal2 = await hburn.balanceOf(alice.address);

        expect(bal2).to.be.gt(bal1);
      });

      it("emits VestingClaimed event", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(28 * DAY);

        await expect(genesis.connect(alice).claimVested())
          .to.emit(genesis, "VestingClaimed");
      });
    });

    describe("End Genesis (Fair Launch LP Creation)", function () {
      it("anyone can call endGenesis after 28 days", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);

        await expect(genesis.connect(charlie).endGenesis(0))
          .to.emit(genesis, "GenesisPhaseEnded");
      });

      it("creates LP via PositionManager when fund exists", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);

        await expect(genesis.connect(charlie).endGenesis(0))
          .to.emit(genesis, "LiquidityPoolCreated");

        expect(await genesis.lpCreated()).to.be.true;
        expect(await genesis.lpTokenId()).to.be.gt(0);
      });

      it("initializes pool before minting position", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);

        await genesis.endGenesis(0);

        expect(await mockPositionManager.poolInitialized()).to.be.true;
        expect(await mockPositionManager.initialSqrtPrice()).to.be.gt(0);
      });

      it("swaps Genesis Fund TitanX → WETH via router", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        // 8% = 8000 TitanX in fund
        expect(await genesis.genesisFundTitanX()).to.equal(ethers.parseEther("8000"));

        await time.increase(29 * DAY);
        await genesis.endGenesis(0);

        // TitanX should have been sent to router
        expect(await titanX.balanceOf(await mockRouter.getAddress()))
          .to.equal(ethers.parseEther("8000"));
      });

      it("deposits HBURN + WETH into PositionManager", async function () {
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 1);

        await genesis.connect(alice).burn(amt);
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);

        const pmAddr = await mockPositionManager.getAddress();

        // LP reserve HBURN should be in PositionManager
        expect(await hburn.balanceOf(pmAddr)).to.equal(expected.lpReserve);

        // WETH should also be in PositionManager
        expect(await mockWeth.balanceOf(pmAddr)).to.be.gt(0);
      });

      it("cannot end genesis early", async function () {
        await expect(genesis.endGenesis(0))
          .to.be.revertedWithCustomError(genesis, "GenesisNotYetEnded");
      });

      it("cannot end genesis twice", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);

        await expect(genesis.endGenesis(0))
          .to.be.revertedWithCustomError(genesis, "GenesisAlreadyEnded");
      });

      it("handles endGenesis with zero participation (no LP created)", async function () {
        // Nobody participated
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);

        // Genesis ended but no LP
        expect(await genesis.genesisEnded()).to.be.true;
        expect(await genesis.lpCreated()).to.be.false;
      });

      it("respects minWETHOut slippage protection", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);

        // Set absurdly high minimum — should revert from router
        await expect(genesis.endGenesis(ethers.parseEther("999999")))
          .to.be.reverted;
      });
    });

    describe("LP Fee Collection", function () {
      it("reverts collectLPFees before LP is created", async function () {
        await expect(genesis.collectLPFees(deployer.address))
          .to.be.revertedWithCustomError(genesis, "LPNotCreated");
      });

      it("collects and distributes LP fees after creation", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);

        const tokenId = await genesis.lpTokenId();

        // Simulate fees by sending tokens to PositionManager and setting fees
        const hburnIsToken0 = (await hburn.getAddress()).toLowerCase() < (await mockWeth.getAddress()).toLowerCase();
        const feeHburn = ethers.parseEther("100");
        const feeWeth = ethers.parseEther("0.5");

        // Transfer HBURN fees to PM (Alice has HBURN from genesis)
        await hburn.connect(alice).transfer(await mockPositionManager.getAddress(), feeHburn);

        // Mint WETH fees to PM AND fund MockWETH with ETH for withdraw()
        await mockWeth.mint(await mockPositionManager.getAddress(), feeWeth);
        await deployer.sendTransaction({
          to: await mockWeth.getAddress(),
          value: ethers.parseEther("10"), // ETH backing so weth.withdraw() works
        });

        if (hburnIsToken0) {
          await mockPositionManager.setFees(tokenId, feeHburn, feeWeth);
        } else {
          await mockPositionManager.setFees(tokenId, feeWeth, feeHburn);
        }

        // Collect fees — HBURN burned, WETH→ETH sent to BuyAndBurn
        await expect(genesis.collectLPFees(await buyBurn.getAddress()))
          .to.emit(genesis, "LPFeesCollected");

        // HBURN fees should be at dead address
        expect(await hburn.balanceOf(DEAD)).to.equal(feeHburn);
      });
    });

    describe("Max Supply Cap (M-03)", function () {
      it("enforces MAX_HBURN_SUPPLY", async function () {
        expect(await genesis.MAX_HBURN_SUPPLY())
          .to.equal(ethers.parseEther("1000000000000"));
      });
    });

    describe("View Functions", function () {
      it("currentWeek returns correct week", async function () {
        expect(await genesis.currentWeek()).to.equal(1);
        await time.increase(7 * DAY);
        expect(await genesis.currentWeek()).to.equal(2);
        await time.increase(7 * DAY);
        expect(await genesis.currentWeek()).to.equal(3);
        await time.increase(7 * DAY);
        expect(await genesis.currentWeek()).to.equal(4);
        await time.increase(7 * DAY);
        expect(await genesis.currentWeek()).to.equal(4); // capped
      });

      it("currentMintRatio returns ratio and bonus", async function () {
        const [ratio, bonus] = await genesis.currentMintRatio();
        expect(ratio).to.equal(100);
        expect(bonus).to.equal(115);
      });

      it("effectiveUserPercent returns 97", async function () {
        expect(await genesis.effectiveUserPercent()).to.equal(97);
      });

      it("lpInfo returns correct state", async function () {
        const [created, tokenId, reserveHBURN, fundTitanX] = await genesis.lpInfo();
        expect(created).to.be.false;
        expect(tokenId).to.equal(0);
        expect(reserveHBURN).to.equal(0);
        expect(fundTitanX).to.equal(0);
      });

      it("lpInfo updates after burns and endGenesis", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        const expected = calcGenesis(ethers.parseEther("100000"), 1);

        let [created, , reserveHBURN, fundTitanX] = await genesis.lpInfo();
        expect(created).to.be.false;
        expect(reserveHBURN).to.equal(expected.lpReserve);
        expect(fundTitanX).to.equal(ethers.parseEther("8000"));

        await time.increase(29 * DAY);
        await genesis.endGenesis(0);

        [created] = await genesis.lpInfo();
        expect(created).to.be.true;
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  3. BURN EPOCHS (unchanged from v2)
  // ═══════════════════════════════════════════════════════════════
  describe("3. BurnEpochs", function () {
    beforeEach(async function () {
      await deployAll();
      const start = await epochs.firstEpochStart();
      await time.increaseTo(start);
    });

    describe("Burning", function () {
      it("allows burning TitanX in active epoch", async function () {
        await expect(
          epochs.connect(alice).burnTitanX(ethers.parseEther("10000"))
        ).to.emit(epochs, "BurnedInEpoch");
      });

      it("allows burning DragonX in active epoch", async function () {
        await expect(
          epochs.connect(alice).burnDragonX(ethers.parseEther("10000"))
        ).to.emit(epochs, "BurnedInEpoch");
      });

      it("sends burned tokens to dead address", async function () {
        const deadBefore = await titanX.balanceOf(DEAD);
        await epochs.connect(alice).burnTitanX(ethers.parseEther("5000"));
        const deadAfter = await titanX.balanceOf(DEAD);
        expect(deadAfter - deadBefore).to.equal(ethers.parseEther("5000"));
      });

      it("weights DragonX burns at 2x", async function () {
        const amt = ethers.parseEther("10000");
        await epochs.connect(alice).burnTitanX(amt);
        await epochs.connect(bob).burnDragonX(amt);

        const epochId = await epochs.currentEpochId();
        const a = await epochs.getUserEpochBurn(epochId, alice.address);
        const b = await epochs.getUserEpochBurn(epochId, bob.address);
        expect(b).to.equal(a * 2n);
      });

      it("rejects zero amount", async function () {
        await expect(epochs.connect(alice).burnTitanX(0))
          .to.be.revertedWithCustomError(epochs, "ZeroAmount");
      });

      it("tracks global burn statistics", async function () {
        await epochs.connect(alice).burnTitanX(ethers.parseEther("5000"));
        await epochs.connect(bob).burnDragonX(ethers.parseEther("3000"));
        expect(await epochs.totalTitanXBurned()).to.equal(ethers.parseEther("5000"));
        expect(await epochs.totalDragonXBurned()).to.equal(ethers.parseEther("3000"));
      });
    });

    describe("Streak System", function () {
      it("starts at 1.2x on first participation", async function () {
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(12);
      });

      it("increments streak across consecutive epochs", async function () {
        const amt = ethers.parseEther("1000");
        await epochs.connect(alice).burnTitanX(amt);
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(12);

        await time.increase(8 * DAY);
        await epochs.connect(alice).burnTitanX(amt);
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(14);

        await time.increase(8 * DAY);
        await epochs.connect(alice).burnTitanX(amt);
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(16);
      });

      it("resets streak when missing an epoch", async function () {
        const amt = ethers.parseEther("1000");
        await epochs.connect(alice).burnTitanX(amt);
        await time.increase(8 * DAY);
        await epochs.connect(alice).burnTitanX(amt);
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(14);

        await time.increase(16 * DAY);
        await expect(epochs.connect(alice).burnTitanX(amt))
          .to.emit(epochs, "StreakReset");
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(12);
      });

      it("caps at 3.0x (30)", async function () {
        const amt = ethers.parseEther("1000");
        for (let i = 0; i < 15; i++) {
          await epochs.connect(alice).burnTitanX(amt);
          if (i < 14) await time.increase(8 * DAY);
        }
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(30);
      });
    });

    describe("Epoch Finalization & Rewards", function () {
      it("distributes 80% ETH to burners, 20% to BuyAndBurn", async function () {
        await deployer.sendTransaction({ to: await epochs.getAddress(), value: ethers.parseEther("10") });
        await epochs.connect(alice).burnTitanX(ethers.parseEther("10000"));
        await time.increase(8 * DAY);

        const buyBurnBefore = await ethers.provider.getBalance(await buyBurn.getAddress());
        await epochs.finalizeEpoch(0);
        const buyBurnAfter = await ethers.provider.getBalance(await buyBurn.getAddress());

        expect(buyBurnAfter - buyBurnBefore).to.equal(ethers.parseEther("2"));
        expect(await epochs.getEpochRewards(0)).to.equal(ethers.parseEther("8"));
      });

      it("allows claiming rewards", async function () {
        await deployer.sendTransaction({ to: await epochs.getAddress(), value: ethers.parseEther("1") });
        await epochs.connect(alice).burnTitanX(ethers.parseEther("10000"));
        await time.increase(8 * DAY);
        await epochs.finalizeEpoch(0);

        const balBefore = await ethers.provider.getBalance(alice.address);
        await epochs.connect(alice).claimRewards(0);
        const balAfter = await ethers.provider.getBalance(alice.address);
        expect(balAfter).to.be.gt(balBefore);
      });

      it("prevents double claiming", async function () {
        await deployer.sendTransaction({ to: await epochs.getAddress(), value: ethers.parseEther("1") });
        await epochs.connect(alice).burnTitanX(ethers.parseEther("10000"));
        await time.increase(8 * DAY);
        await epochs.finalizeEpoch(0);
        await epochs.connect(alice).claimRewards(0);

        await expect(epochs.connect(alice).claimRewards(0))
          .to.be.revertedWithCustomError(epochs, "AlreadyClaimed");
      });

      it("supports batch claiming", async function () {
        for (let i = 0; i < 3; i++) {
          await deployer.sendTransaction({ to: await epochs.getAddress(), value: ethers.parseEther("1") });
          await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
          await time.increase(8 * DAY);
          await epochs.finalizeEpoch(i);
        }

        const balBefore = await ethers.provider.getBalance(alice.address);
        await epochs.connect(alice).batchClaimRewards([0, 1, 2]);
        expect(await ethers.provider.getBalance(alice.address)).to.be.gt(balBefore);
      });

      it("carries over ETH when epoch has no burners (M-05)", async function () {
        await deployer.sendTransaction({ to: await epochs.getAddress(), value: ethers.parseEther("5") });
        await time.increase(8 * DAY);
        await expect(epochs.finalizeEpoch(0)).to.emit(epochs, "OrphanedETHCarriedOver");
        expect(await epochs.carryOverETH()).to.equal(ethers.parseEther("5"));
      });
    });

    describe("Emergency Pause (M-02)", function () {
      it("guardian can pause and unpause", async function () {
        await epochs.connect(guardian).pause();
        await expect(epochs.connect(alice).burnTitanX(ethers.parseEther("1000")))
          .to.be.revertedWithCustomError(epochs, "EnforcedPause");
        await epochs.connect(guardian).unpause();
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
      });

      it("non-guardian cannot pause", async function () {
        await expect(epochs.connect(alice).pause())
          .to.be.revertedWithCustomError(epochs, "OnlyGuardian");
      });

      it("claims still work when paused", async function () {
        await deployer.sendTransaction({ to: await epochs.getAddress(), value: ethers.parseEther("1") });
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
        await time.increase(8 * DAY);
        await epochs.finalizeEpoch(0);
        await epochs.connect(guardian).pause();
        await epochs.connect(alice).claimRewards(0);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  4. HELLBURN STAKING (97% base amounts)
  // ═══════════════════════════════════════════════════════════════
  describe("4. HellBurnStaking", function () {
    beforeEach(async function () {
      await deployAll();

      // Mint HBURN via genesis — amounts are now 97% of pre-v3
      await genesis.connect(alice).burn(ethers.parseEther("500000"));
      await genesis.connect(bob).burn(ethers.parseEther("300000"));

      await time.increase(28 * DAY);
      await genesis.connect(alice).claimVested();
      await genesis.connect(bob).claimVested();

      const sa = await staking.getAddress();
      await hburn.connect(alice).approve(sa, ethers.MaxUint256);
      await hburn.connect(bob).approve(sa, ethers.MaxUint256);
    });

    describe("Start Stake", function () {
      it("allows starting a stake", async function () {
        await expect(
          staking.connect(alice).startStake(ethers.parseEther("50000"), 888)
        ).to.emit(staking, "StakeStarted");

        const ids = await staking.getUserStakes(alice.address);
        expect(ids.length).to.equal(1);
      });

      it("rejects duration under 28 days", async function () {
        await expect(staking.connect(alice).startStake(ethers.parseEther("1000"), 10))
          .to.be.revertedWithCustomError(staking, "InvalidDuration");
      });

      it("rejects duration over 3500 days", async function () {
        await expect(staking.connect(alice).startStake(ethers.parseEther("1000"), 5000))
          .to.be.revertedWithCustomError(staking, "InvalidDuration");
      });

      it("rejects zero amount", async function () {
        await expect(staking.connect(alice).startStake(0, 100))
          .to.be.revertedWithCustomError(staking, "ZeroAmount");
      });

      it("transfers HBURN from user to contract", async function () {
        const balBefore = await hburn.balanceOf(alice.address);
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 100);
        const balAfter = await hburn.balanceOf(alice.address);
        expect(balBefore - balAfter).to.equal(ethers.parseEther("10000"));
      });
    });

    describe("Time Bonus", function () {
      it("calculates higher shares for longer stakes", async function () {
        const amt = ethers.parseEther("10000");
        await staking.connect(alice).startStake(amt, 28);
        await staking.connect(bob).startStake(amt, 888);

        const [, sharesA] = await staking.getStakeInfo(0);
        const [, sharesB] = await staking.getStakeInfo(1);
        expect(sharesB).to.be.gt(sharesA);
        expect(sharesB).to.be.lt(sharesA * 2n);
      });

      it("max bonus at 3500 days (Diamond)", async function () {
        const amt = ethers.parseEther("10000");
        await staking.connect(alice).startStake(amt, 3500);
        const [, shares] = await staking.getStakeInfo(0);
        expect(shares).to.equal(ethers.parseEther("35000"));
      });
    });

    describe("ETH Yield Distribution", function () {
      it("distributes ETH to stakers", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("50000"), 888);
        await deployer.sendTransaction({ to: await staking.getAddress(), value: ethers.parseEther("5") });
        const pending = await staking.pendingETHReward(0);
        expect(pending).to.be.gt(0);
      });

      it("distributes proportionally to shares", async function () {
        const amt = ethers.parseEther("10000");
        await staking.connect(alice).startStake(amt, 3500);
        await staking.connect(bob).startStake(amt, 28);
        await deployer.sendTransaction({ to: await staking.getAddress(), value: ethers.parseEther("10") });

        const pendingA = await staking.pendingETHReward(0);
        const pendingB = await staking.pendingETHReward(1);
        expect(pendingA).to.be.gt(pendingB * 3n);
      });
    });

    describe("End Stake & Penalties", function () {
      it("prevents unstaking before 50% maturity", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 100);
        await time.increase(30 * DAY);
        await expect(staking.connect(alice).endStake(0))
          .to.be.revertedWithCustomError(staking, "StakeNotMature");
      });

      it("applies penalty between 50-100% maturity", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 100);
        await time.increase(75 * DAY);
        const balBefore = await hburn.balanceOf(alice.address);
        await staking.connect(alice).endStake(0);
        const balAfter = await hburn.balanceOf(alice.address);
        const returned = balAfter - balBefore;
        expect(returned).to.be.closeTo(ethers.parseEther("5000"), ethers.parseEther("500"));
      });

      it("returns full amount at 100% maturity", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);
        const balBefore = await hburn.balanceOf(alice.address);
        await staking.connect(alice).endStake(0);
        const balAfter = await hburn.balanceOf(alice.address);
        expect(balAfter - balBefore).to.equal(ethers.parseEther("10000"));
      });

      it("only owner can end their stake (H-03 fix)", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);
        await expect(staking.connect(bob).endStake(0))
          .to.be.revertedWithCustomError(staking, "NotStakeOwner");
      });

      it("penalty burns 50% to dead address", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 100);
        await time.increase(50 * DAY);
        const deadBefore = await hburn.balanceOf(DEAD);
        await staking.connect(alice).endStake(0);
        expect(await hburn.balanceOf(DEAD)).to.be.gt(deadBefore);
      });
    });

    describe("Loyalty & Re-Stake (H-05 fix)", function () {
      it("rejects reStake without prior completed stake", async function () {
        await expect(staking.connect(alice).reStake(ethers.parseEther("10000"), 100))
          .to.be.revertedWithCustomError(staking, "NoPriorStake");
      });

      it("reStake grants 1.1x loyalty bonus on shares", async function () {
        const amt = ethers.parseEther("10000");
        await staking.connect(alice).startStake(amt, 100);
        const [, sharesNormal] = await staking.getStakeInfo(0);
        await time.increase(100 * DAY);
        await staking.connect(alice).endStake(0);

        await staking.connect(alice).reStake(amt, 100);
        const [, sharesRe] = await staking.getStakeInfo(1);
        expect(sharesRe).to.be.closeTo((sharesNormal * 1100n) / 1000n, sharesNormal / 100n);
      });

      it("grants Phoenix status after 3 consecutive re-stakes", async function () {
        const amt = ethers.parseEther("5000");
        await staking.connect(alice).startStake(amt, 28);
        for (let i = 0; i < 3; i++) {
          await time.increase(28 * DAY);
          await staking.connect(alice).endStake(i);
          if (i < 2) {
            await staking.connect(alice).reStake(amt, 28);
          } else {
            await expect(staking.connect(alice).reStake(amt, 28))
              .to.emit(staking, "PhoenixStatusGranted");
          }
        }
        expect(await staking.hasPhoenixStatus(alice.address)).to.be.true;
      });
    });

    describe("Fuel Mechanic", function () {
      it("allows adding TitanX fuel to active stake", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("50000"), 888);
        await expect(staking.connect(alice).addFuelTitanX(0, ethers.parseEther("1000000")))
          .to.emit(staking, "FuelAdded");
      });

      it("increases shares after fueling", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("50000"), 888);
        const [, sharesBefore] = await staking.getStakeInfo(0);
        await staking.connect(alice).addFuelTitanX(0, ethers.parseEther("5000000"));
        const [, sharesAfter] = await staking.getStakeInfo(0);
        expect(sharesAfter).to.be.gt(sharesBefore);
      });

      it("caps fuel bonus at 1.5x", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("50000"), 888);
        await titanX.mint(alice.address, ethers.parseEther("100000000000"));
        await titanX.connect(alice).approve(await staking.getAddress(), ethers.MaxUint256);

        for (let i = 0; i < 5; i++) {
          try { await staking.connect(alice).addFuelTitanX(0, ethers.parseEther("10000000000")); }
          catch { break; }
        }
        const [, , , , fuelBonus] = await staking.getStakeInfo(0);
        expect(fuelBonus).to.be.lte(1500);
      });

      it("only stake owner can add fuel", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("50000"), 888);
        await expect(staking.connect(bob).addFuelTitanX(0, ethers.parseEther("1000")))
          .to.be.revertedWithCustomError(staking, "NotStakeOwner");
      });
    });

    describe("Emergency Pause (M-02)", function () {
      it("guardian can pause staking", async function () {
        await staking.connect(guardian).pause();
        await expect(staking.connect(alice).startStake(ethers.parseEther("1000"), 28))
          .to.be.revertedWithCustomError(staking, "EnforcedPause");
      });

      it("endStake still works when paused", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);
        await staking.connect(guardian).pause();
        await staking.connect(alice).endStake(0);
      });
    });

    describe("Tier System", function () {
      it("returns correct tiers", async function () {
        expect(await staking.getTier(28)).to.equal(1);
        expect(await staking.getTier(90)).to.equal(2);
        expect(await staking.getTier(369)).to.equal(3);
        expect(await staking.getTier(888)).to.equal(4);
        expect(await staking.getTier(3500)).to.equal(5);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  5. BUYANDBURN
  // ═══════════════════════════════════════════════════════════════
  describe("5. BuyAndBurn", function () {
    beforeEach(deployAll);

    it("receives ETH", async function () {
      await deployer.sendTransaction({ to: await buyBurn.getAddress(), value: ethers.parseEther("1") });
      expect(await buyBurn.pendingETH()).to.equal(ethers.parseEther("1"));
    });

    it("rejects zero slippage (C-02 fix)", async function () {
      await deployer.sendTransaction({ to: await buyBurn.getAddress(), value: ethers.parseEther("1") });
      await expect(buyBurn.executeBuyAndBurn(0))
        .to.be.revertedWithCustomError(buyBurn, "ZeroSlippage");
    });

    it("rejects when below minimum", async function () {
      await expect(buyBurn.executeBuyAndBurn(1))
        .to.be.revertedWithCustomError(buyBurn, "BelowMinimum");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  6. INTEGRATION TESTS
  // ═══════════════════════════════════════════════════════════════
  describe("6. Integration", function () {
    beforeEach(deployAll);

    it("full genesis flow: burn → vest → claim → stake → earn → unstake", async function () {
      // 1. Burn TitanX in genesis
      await genesis.connect(alice).burn(ethers.parseEther("200000"));
      const immediateBalance = await hburn.balanceOf(alice.address);
      expect(immediateBalance).to.be.gt(0);

      // 2. Vest and claim
      await time.increase(28 * DAY);
      await genesis.connect(alice).claimVested();
      const fullBalance = await hburn.balanceOf(alice.address);
      expect(fullBalance).to.be.gt(immediateBalance);

      // Verify LP reserve was taken
      const expected = calcGenesis(ethers.parseEther("200000"), 1);
      expect(fullBalance).to.equal(expected.userAmount);

      // 3. Stake HBURN
      await hburn.connect(alice).approve(await staking.getAddress(), ethers.MaxUint256);
      const stakeAmount = fullBalance / 2n;
      await staking.connect(alice).startStake(stakeAmount, 369);

      // 4. Earn ETH yield
      await deployer.sendTransaction({ to: await staking.getAddress(), value: ethers.parseEther("50") });
      const pendingETH = await staking.pendingETHReward(0);
      expect(pendingETH).to.be.gt(0);

      // 5. Unstake at maturity
      await time.increase(369 * DAY);
      await staking.connect(alice).endStake(0);
      expect(await hburn.balanceOf(alice.address)).to.be.closeTo(fullBalance, ethers.parseEther("1"));

      const [, , , , , active] = await staking.getStakeInfo(0);
      expect(active).to.be.false;
    });

    it("full fair launch flow: genesis → endGenesis → LP created → tradeable", async function () {
      // 1. Multiple users participate
      await genesis.connect(alice).burn(ethers.parseEther("500000"));
      await genesis.connect(bob).burn(ethers.parseEther("300000"));

      // 2. Verify reserves accumulated
      expect(await genesis.genesisFundTitanX()).to.equal(ethers.parseEther("64000")); // 8% of 800K
      expect(await genesis.lpReserveHBURN()).to.be.gt(0);

      // 3. End genesis → LP created automatically
      await time.increase(29 * DAY);
      await expect(genesis.endGenesis(0))
        .to.emit(genesis, "GenesisPhaseEnded")
        .to.emit(genesis, "LiquidityPoolCreated");

      // 4. LP is permanently locked
      expect(await genesis.lpCreated()).to.be.true;
      expect(await genesis.lpTokenId()).to.be.gt(0);

      // 5. Genesis minting permanently disabled
      expect(await hburn.genesisMintingEnded()).to.be.true;
    });

    it("genesis minting permanently stops", async function () {
      await genesis.connect(alice).burn(ethers.parseEther("100000"));
      const supplyBefore = await hburn.totalSupply();

      await time.increase(29 * DAY);
      await genesis.endGenesis(0);

      expect(await hburn.genesisMintingEnded()).to.be.true;
      expect(await hburn.totalSupply()).to.equal(supplyBefore);
    });

    it("multiple users compete in epochs fairly", async function () {
      const start = await epochs.firstEpochStart();
      await time.increaseTo(start);

      await deployer.sendTransaction({ to: await epochs.getAddress(), value: ethers.parseEther("9") });

      const amt = ethers.parseEther("10000");
      await epochs.connect(alice).burnTitanX(amt);
      await epochs.connect(bob).burnDragonX(amt);

      await time.increase(8 * DAY);
      await epochs.finalizeEpoch(0);

      const aliceReward = await epochs.pendingReward(0, alice.address);
      const bobReward = await epochs.pendingReward(0, bob.address);
      expect(bobReward).to.be.closeTo(aliceReward * 2n, aliceReward / 10n);
    });
  });
});
