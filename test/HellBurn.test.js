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

describe("🔥 HellBurn Protocol — Full Test Suite (Trustless v4.0)", function () {
  let deployer, alice, bob, charlie;
  let titanX, dragonX, hburn, genesis, staking, epochs, buyBurn;
  let mockWeth, mockRouter, mockPositionManager;

  // ═══════════════════════════════════════════════════════════════════
  //  SHARED SETUP
  // ═══════════════════════════════════════════════════════════════════
  async function deployAll() {
    [deployer, alice, bob, charlie] = await ethers.getSigners();

    // ── Mock Tokens ──
    const MockTitanX = await ethers.getContractFactory("MockTitanX");
    titanX = await MockTitanX.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
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

    // ── 2: GenesisBurn (Trustless — 8 params, no treasury address) ──
    const GenesisBurn = await ethers.getContractFactory("GenesisBurn");
    genesis = await GenesisBurn.deploy(
      await titanX.getAddress(),               // _titanX
      deployer.address,                        // _dragonXVault
      await hburn.getAddress(),                // _hburn
      await mockRouter.getAddress(),           // _swapRouter
      await mockPositionManager.getAddress(),  // _positionManager
      await mockWeth.getAddress(),             // _weth
      3000,                                    // _titanXWethPoolFee
      await buyBurn.getAddress()               // _buyAndBurn
    );

    // ── 3: HellBurnStaking (no guardian) ──
    const Staking = await ethers.getContractFactory("HellBurnStaking");
    staking = await Staking.deploy(
      await hburn.getAddress(),
      await titanX.getAddress(),
      await dragonX.getAddress()
    );

    // ── 4: BurnEpochs (no guardian) ──
    const firstEpoch = (await time.latest()) + DAY;
    const BurnEpochs = await ethers.getContractFactory("BurnEpochs");
    epochs = await BurnEpochs.deploy(
      await titanX.getAddress(),
      await dragonX.getAddress(),
      await buyBurn.getAddress(),
      await staking.getAddress(),
      firstEpoch
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

  // ═══════════════════════════════════════════════════════════════════
  //  1. HELLBURN TOKEN
  // ═══════════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════════
  //  2. GENESIS BURN (Trustless Fair Launch)
  // ═══════════════════════════════════════════════════════════════════
  describe("2. GenesisBurn", function () {
    beforeEach(deployAll);

    describe("Burn & Mint (97% to user, 3% LP reserve)", function () {
      it("mints HBURN at week 1 ratio with LP reserve", async function () {
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 1);
        await genesis.connect(alice).burn(amt);
        expect(await hburn.balanceOf(alice.address)).to.equal(expected.immediate);
        expect(await genesis.lpReserveHBURN()).to.equal(expected.lpReserve);
      });

      it("mints at week 2 ratio", async function () {
        await time.increase(7 * DAY);
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 2);
        await genesis.connect(alice).burn(amt);
        expect(await hburn.balanceOf(alice.address)).to.equal(expected.immediate);
      });

      it("mints at week 3 ratio", async function () {
        await time.increase(14 * DAY);
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 3);
        await genesis.connect(alice).burn(amt);
        expect(await hburn.balanceOf(alice.address)).to.equal(expected.immediate);
      });

      it("mints at week 4 ratio", async function () {
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

      it("emits GenesisBurnExecuted with LP reserve amount", async function () {
        const amt = ethers.parseEther("10000");
        const expected = calcGenesis(amt, 1);
        await expect(genesis.connect(alice).burn(amt))
          .to.emit(genesis, "GenesisBurnExecuted")
          .withArgs(alice.address, amt, expected.total, expected.immediate, expected.vested, expected.lpReserve, 1);
      });
    });

    describe("TitanX Distribution (Trustless)", function () {
      it("sends 35% to dead address (permanent burn)", async function () {
        const deadBefore = await titanX.balanceOf(DEAD);
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        expect(await titanX.balanceOf(DEAD) - deadBefore).to.equal(ethers.parseEther("35000"));
      });

      it("sends 35% to DragonX vault", async function () {
        const vaultBefore = await titanX.balanceOf(deployer.address);
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        // deployer is dragonXVault = 35%
        expect(await titanX.balanceOf(deployer.address) - vaultBefore).to.equal(ethers.parseEther("35000"));
      });

      it("keeps 22% treasury TitanX IN the contract (not external wallet)", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        expect(await genesis.treasuryTitanX()).to.equal(ethers.parseEther("22000"));
        // TitanX stays in genesis contract (22% + 8% = 30%)
        expect(await titanX.balanceOf(await genesis.getAddress()))
          .to.equal(ethers.parseEther("30000"));
      });

      it("keeps 8% LP Fund TitanX in the contract", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        expect(await genesis.genesisFundTitanX()).to.equal(ethers.parseEther("8000"));
      });

      it("accumulates treasury + LP fund across multiple burns", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await genesis.connect(bob).burn(ethers.parseEther("50000"));
        expect(await genesis.treasuryTitanX()).to.equal(ethers.parseEther("33000")); // 22% of 150K
        expect(await genesis.genesisFundTitanX()).to.equal(ethers.parseEther("12000")); // 8% of 150K
      });

      it("NO external treasury address — no rug vector", async function () {
        // Verify there is no treasury() function that returns an external address
        expect(genesis.treasury).to.be.undefined;
      });
    });

    describe("Treasury Auto-Stake (Trustless)", function () {
      it("stakeTreasury reverts before genesis ends", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await expect(genesis.stakeTreasury())
          .to.be.revertedWithCustomError(genesis, "GenesisNotYetEnded");
      });

      it("stakeTreasury stakes ALL treasury TitanX for 3500 days", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);

        await expect(genesis.stakeTreasury())
          .to.emit(genesis, "TreasuryStaked")
          .withArgs(ethers.parseEther("22000"), 3500);

        expect(await genesis.treasuryStaked()).to.be.true;

        // Verify TitanX was transferred to TitanX contract for staking
        const [amount, numDays, staker] = await titanX.getStake(0);
        expect(amount).to.equal(ethers.parseEther("22000"));
        expect(numDays).to.equal(3500);
        expect(staker).to.equal(await genesis.getAddress());
      });

      it("stakeTreasury reverts if already staked", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);
        await genesis.stakeTreasury();

        await expect(genesis.stakeTreasury())
          .to.be.revertedWithCustomError(genesis, "TreasuryAlreadyStaked");
      });

      it("stakeTreasury callable by anyone (permissionless)", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);

        // Charlie (random person) can stake the treasury
        await expect(genesis.connect(charlie).stakeTreasury())
          .to.emit(genesis, "TreasuryStaked");
      });

      it("claimTreasuryYield forwards ETH to BuyAndBurn", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);
        await genesis.stakeTreasury();

        // Simulate TitanX ETH yield by funding the mock
        await titanX.fundETHPayout({ value: ethers.parseEther("2") });

        const buyBurnBefore = await ethers.provider.getBalance(await buyBurn.getAddress());
        await expect(genesis.claimTreasuryYield())
          .to.emit(genesis, "TreasuryYieldClaimed")
          .withArgs(ethers.parseEther("2"));
        const buyBurnAfter = await ethers.provider.getBalance(await buyBurn.getAddress());

        expect(buyBurnAfter - buyBurnBefore).to.equal(ethers.parseEther("2"));
      });

      it("claimTreasuryYield callable by anyone", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);
        await genesis.stakeTreasury();

        await titanX.fundETHPayout({ value: ethers.parseEther("1") });
        await expect(genesis.connect(bob).claimTreasuryYield())
          .to.emit(genesis, "TreasuryYieldClaimed");
      });

      it("treasuryInfo returns correct state", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        let [amount, staked] = await genesis.treasuryInfo();
        expect(amount).to.equal(ethers.parseEther("22000"));
        expect(staked).to.be.false;

        await time.increase(29 * DAY);
        await genesis.endGenesis(0);
        await genesis.stakeTreasury();

        [amount, staked] = await genesis.treasuryInfo();
        expect(amount).to.equal(ethers.parseEther("22000"));
        expect(staked).to.be.true;
      });
    });

    describe("Vesting (per-tranche, 97% base)", function () {
      it("vests 75% of user amount linearly over 28 days", async function () {
        const amt = ethers.parseEther("100000");
        const expected = calcGenesis(amt, 1);
        await genesis.connect(alice).burn(amt);
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
        expect(await hburn.balanceOf(alice.address)).to.equal(expected.userAmount);
      });

      it("creates separate tranches (H-01 fix)", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("50000"));
        await time.increase(14 * DAY);
        await genesis.connect(alice).burn(ethers.parseEther("50000"));
        expect(await genesis.getUserTrancheCount(alice.address)).to.equal(2);
      });

      it("reverts claim when nothing to claim", async function () {
        await expect(genesis.connect(alice).claimVested())
          .to.be.revertedWithCustomError(genesis, "NothingToClaim");
      });
    });

    describe("End Genesis (Fair Launch LP Creation)", function () {
      it("anyone can call endGenesis after 28 days", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);
        await expect(genesis.connect(charlie).endGenesis(0))
          .to.emit(genesis, "GenesisPhaseEnded");
      });

      it("creates LP via PositionManager", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);
        await expect(genesis.connect(charlie).endGenesis(0))
          .to.emit(genesis, "LiquidityPoolCreated");
        expect(await genesis.lpCreated()).to.be.true;
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

      it("handles zero participation (no LP)", async function () {
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);
        expect(await genesis.genesisEnded()).to.be.true;
        expect(await genesis.lpCreated()).to.be.false;
      });
    });

    describe("LP Fee Collection", function () {
      it("reverts before LP created", async function () {
        await expect(genesis.collectLPFees())
          .to.be.revertedWithCustomError(genesis, "LPNotCreated");
      });

      it("collects and distributes fees", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(29 * DAY);
        await genesis.endGenesis(0);

        const tokenId = await genesis.lpTokenId();
        const hburnIsToken0 = (await hburn.getAddress()).toLowerCase() < (await mockWeth.getAddress()).toLowerCase();
        const feeHburn = ethers.parseEther("100");
        const feeWeth = ethers.parseEther("0.5");

        await hburn.connect(alice).transfer(await mockPositionManager.getAddress(), feeHburn);
        await mockWeth.mint(await mockPositionManager.getAddress(), feeWeth);
        await deployer.sendTransaction({ to: await mockWeth.getAddress(), value: ethers.parseEther("10") });

        if (hburnIsToken0) {
          await mockPositionManager.setFees(tokenId, feeHburn, feeWeth);
        } else {
          await mockPositionManager.setFees(tokenId, feeWeth, feeHburn);
        }

        await expect(genesis.collectLPFees())
          .to.emit(genesis, "LPFeesCollected");
        expect(await hburn.balanceOf(DEAD)).to.equal(feeHburn);
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
        expect(await genesis.currentWeek()).to.equal(4);
      });

      it("effectiveUserPercent returns 97", async function () {
        expect(await genesis.effectiveUserPercent()).to.equal(97);
      });

      it("lpInfo and treasuryInfo update correctly", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        const expected = calcGenesis(ethers.parseEther("100000"), 1);

        let [created, , reserveHBURN, fundTitanX] = await genesis.lpInfo();
        expect(created).to.be.false;
        expect(reserveHBURN).to.equal(expected.lpReserve);
        expect(fundTitanX).to.equal(ethers.parseEther("8000"));

        let [tAmount, tStaked] = await genesis.treasuryInfo();
        expect(tAmount).to.equal(ethers.parseEther("22000"));
        expect(tStaked).to.be.false;
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  3. BURN EPOCHS (No guardian, no pause — fully permissionless)
  // ═══════════════════════════════════════════════════════════════════
  describe("3. BurnEpochs", function () {
    beforeEach(async function () {
      await deployAll();
      const start = await epochs.firstEpochStart();
      await time.increaseTo(start);
    });

    describe("Burning", function () {
      it("allows burning TitanX", async function () {
        await expect(epochs.connect(alice).burnTitanX(ethers.parseEther("10000")))
          .to.emit(epochs, "BurnedInEpoch");
      });

      it("allows burning DragonX", async function () {
        await expect(epochs.connect(alice).burnDragonX(ethers.parseEther("10000")))
          .to.emit(epochs, "BurnedInEpoch");
      });

      it("sends burned tokens to dead address", async function () {
        const deadBefore = await titanX.balanceOf(DEAD);
        await epochs.connect(alice).burnTitanX(ethers.parseEther("5000"));
        expect(await titanX.balanceOf(DEAD) - deadBefore).to.equal(ethers.parseEther("5000"));
      });

      it("weights DragonX at 2x", async function () {
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
    });

    describe("Streak System", function () {
      it("starts at 1.2x", async function () {
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(12);
      });

      it("increments across consecutive epochs", async function () {
        const amt = ethers.parseEther("1000");
        await epochs.connect(alice).burnTitanX(amt);
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(12);
        await time.increase(8 * DAY);
        await epochs.connect(alice).burnTitanX(amt);
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(14);
      });

      it("resets when missing an epoch", async function () {
        const amt = ethers.parseEther("1000");
        await epochs.connect(alice).burnTitanX(amt);
        await time.increase(8 * DAY);
        await epochs.connect(alice).burnTitanX(amt);
        await time.increase(16 * DAY); // skip 2 epochs
        await expect(epochs.connect(alice).burnTitanX(amt))
          .to.emit(epochs, "StreakReset");
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(12);
      });

      it("caps at 3.0x", async function () {
        const amt = ethers.parseEther("1000");
        for (let i = 0; i < 15; i++) {
          await epochs.connect(alice).burnTitanX(amt);
          if (i < 14) await time.increase(8 * DAY);
        }
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(30);
      });
    });

    describe("Epoch Finalization & Rewards", function () {
      it("distributes 80/20 split", async function () {
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
        expect(await ethers.provider.getBalance(alice.address)).to.be.gt(balBefore);
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

      it("carries over ETH with no burners (M-05)", async function () {
        await deployer.sendTransaction({ to: await epochs.getAddress(), value: ethers.parseEther("5") });
        await time.increase(8 * DAY);
        await expect(epochs.finalizeEpoch(0)).to.emit(epochs, "OrphanedETHCarriedOver");
        expect(await epochs.carryOverETH()).to.equal(ethers.parseEther("5"));
      });

      it("NO pause function exists — fully permissionless", async function () {
        expect(epochs.pause).to.be.undefined;
        expect(epochs.unpause).to.be.undefined;
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  4. HELLBURN STAKING (No guardian — fully permissionless)
  // ═══════════════════════════════════════════════════════════════════
  describe("4. HellBurnStaking", function () {
    beforeEach(async function () {
      await deployAll();
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
        await expect(staking.connect(alice).startStake(ethers.parseEther("50000"), 888))
          .to.emit(staking, "StakeStarted");
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
    });

    describe("Time Bonus", function () {
      it("higher shares for longer stakes", async function () {
        const amt = ethers.parseEther("10000");
        await staking.connect(alice).startStake(amt, 28);
        await staking.connect(bob).startStake(amt, 888);
        const [, sharesA] = await staking.getStakeInfo(0);
        const [, sharesB] = await staking.getStakeInfo(1);
        expect(sharesB).to.be.gt(sharesA);
      });

      it("max bonus at 3500 days", async function () {
        const amt = ethers.parseEther("10000");
        await staking.connect(alice).startStake(amt, 3500);
        const [, shares] = await staking.getStakeInfo(0);
        expect(shares).to.equal(ethers.parseEther("35000"));
      });
    });

    describe("ETH Yield", function () {
      it("distributes ETH to stakers", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("50000"), 888);
        await deployer.sendTransaction({ to: await staking.getAddress(), value: ethers.parseEther("5") });
        expect(await staking.pendingETHReward(0)).to.be.gt(0);
      });

      it("distributes proportionally", async function () {
        const amt = ethers.parseEther("10000");
        await staking.connect(alice).startStake(amt, 3500);
        await staking.connect(bob).startStake(amt, 28);
        await deployer.sendTransaction({ to: await staking.getAddress(), value: ethers.parseEther("10") });
        expect(await staking.pendingETHReward(0)).to.be.gt((await staking.pendingETHReward(1)) * 3n);
      });
    });

    describe("End Stake & Penalties", function () {
      it("prevents unstaking before 50%", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 100);
        await time.increase(30 * DAY);
        await expect(staking.connect(alice).endStake(0))
          .to.be.revertedWithCustomError(staking, "StakeNotMature");
      });

      it("returns full amount at maturity", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);
        const balBefore = await hburn.balanceOf(alice.address);
        await staking.connect(alice).endStake(0);
        expect(await hburn.balanceOf(alice.address) - balBefore).to.equal(ethers.parseEther("10000"));
      });

      it("only owner can end stake (H-03)", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);
        await expect(staking.connect(bob).endStake(0))
          .to.be.revertedWithCustomError(staking, "NotStakeOwner");
      });

      it("NO pause function — users can always stake and unstake", async function () {
        expect(staking.pause).to.be.undefined;
        expect(staking.unpause).to.be.undefined;
      });
    });

    describe("Loyalty & Re-Stake", function () {
      it("reStake grants 1.1x loyalty bonus", async function () {
        const amt = ethers.parseEther("10000");
        await staking.connect(alice).startStake(amt, 100);
        const [, sharesNormal] = await staking.getStakeInfo(0);
        await time.increase(100 * DAY);
        await staking.connect(alice).endStake(0);
        await staking.connect(alice).reStake(amt, 100);
        const [, sharesRe] = await staking.getStakeInfo(1);
        expect(sharesRe).to.be.closeTo((sharesNormal * 1100n) / 1000n, sharesNormal / 100n);
      });
    });

    describe("Fuel Mechanic", function () {
      it("allows adding TitanX fuel", async function () {
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
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  5. BUYANDBURN
  // ═══════════════════════════════════════════════════════════════════
  describe("5. BuyAndBurn", function () {
    beforeEach(deployAll);

    it("receives ETH", async function () {
      await deployer.sendTransaction({ to: await buyBurn.getAddress(), value: ethers.parseEther("1") });
      expect(await buyBurn.pendingETH()).to.equal(ethers.parseEther("1"));
    });

    it("rejects zero slippage (C-02)", async function () {
      await deployer.sendTransaction({ to: await buyBurn.getAddress(), value: ethers.parseEther("1") });
      await expect(buyBurn.executeBuyAndBurn(0))
        .to.be.revertedWithCustomError(buyBurn, "ZeroSlippage");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  6. INTEGRATION
  // ═══════════════════════════════════════════════════════════════════
  describe("6. Integration", function () {
    beforeEach(deployAll);

    it("full genesis → vest → claim → stake → earn → unstake", async function () {
      await genesis.connect(alice).burn(ethers.parseEther("200000"));
      const immediateBalance = await hburn.balanceOf(alice.address);
      expect(immediateBalance).to.be.gt(0);

      await time.increase(28 * DAY);
      await genesis.connect(alice).claimVested();
      const fullBalance = await hburn.balanceOf(alice.address);
      const expected = calcGenesis(ethers.parseEther("200000"), 1);
      expect(fullBalance).to.equal(expected.userAmount);

      await hburn.connect(alice).approve(await staking.getAddress(), ethers.MaxUint256);
      await staking.connect(alice).startStake(fullBalance / 2n, 369);
      await deployer.sendTransaction({ to: await staking.getAddress(), value: ethers.parseEther("50") });
      expect(await staking.pendingETHReward(0)).to.be.gt(0);

      await time.increase(369 * DAY);
      await staking.connect(alice).endStake(0);
      expect(await hburn.balanceOf(alice.address)).to.be.closeTo(fullBalance, ethers.parseEther("1"));
    });

    it("full fair launch: genesis → endGenesis → LP + treasury staked → yield → BuyBurn", async function () {
      // 1. Genesis participation
      await genesis.connect(alice).burn(ethers.parseEther("500000"));
      await genesis.connect(bob).burn(ethers.parseEther("300000"));

      // 2. Verify reserves
      expect(await genesis.genesisFundTitanX()).to.equal(ethers.parseEther("64000")); // 8% of 800K
      expect(await genesis.treasuryTitanX()).to.equal(ethers.parseEther("176000")); // 22% of 800K

      // 3. End genesis → LP created
      await time.increase(29 * DAY);
      await expect(genesis.endGenesis(0))
        .to.emit(genesis, "LiquidityPoolCreated");

      // 4. Stake treasury → TitanX locked for 3500 days
      await expect(genesis.stakeTreasury())
        .to.emit(genesis, "TreasuryStaked");

      // 5. Treasury generates ETH yield
      await titanX.fundETHPayout({ value: ethers.parseEther("5") });
      const buyBurnBefore = await ethers.provider.getBalance(await buyBurn.getAddress());
      await genesis.claimTreasuryYield();
      const buyBurnAfter = await ethers.provider.getBalance(await buyBurn.getAddress());
      expect(buyBurnAfter - buyBurnBefore).to.equal(ethers.parseEther("5"));

      // 6. Everything is trustless
      expect(await genesis.lpCreated()).to.be.true;
      expect(await genesis.treasuryStaked()).to.be.true;
      expect(await hburn.genesisMintingEnded()).to.be.true;
    });

    it("NO admin privileges anywhere — fully trustless", async function () {
      // GenesisBurn: no admin
      expect(genesis.pause).to.be.undefined;
      expect(genesis.owner).to.be.undefined;

      // BurnEpochs: no guardian
      expect(epochs.pause).to.be.undefined;
      expect(epochs.guardian).to.be.undefined;

      // Staking: no guardian
      expect(staking.pause).to.be.undefined;
      expect(staking.guardian).to.be.undefined;

      // BuyAndBurn: no admin
      expect(buyBurn.pause).to.be.undefined;
      expect(buyBurn.owner).to.be.undefined;
    });
  });
});
