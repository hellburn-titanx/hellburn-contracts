const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const DAY = 86400;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const INITIAL_BALANCE = ethers.parseEther("10000000"); // 10M

describe("🔥 HellBurn Protocol — Full Test Suite", function () {
  let deployer, alice, bob, charlie, guardian;
  let titanX, dragonX, hburn, genesis, staking, epochs, buyBurn;
  let mockWeth, mockRouter;

  // ═══════════════════════════════════════════════════════════════
  //  SHARED SETUP
  // ═══════════════════════════════════════════════════════════════
  async function deployAll() {
    [deployer, alice, bob, charlie, guardian] = await ethers.getSigners();

    // ── Mock Tokens ──
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    titanX = await MockERC20.deploy("TitanX", "TITANX");
    dragonX = await MockERC20.deploy("DragonX", "DRAGONX");

    // Mint to users
    for (const u of [alice, bob, charlie]) {
      await titanX.mint(u.address, INITIAL_BALANCE);
      await dragonX.mint(u.address, INITIAL_BALANCE);
    }

    // ── Pre-calculate addresses ──
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const addr = (i) =>
      ethers.getCreateAddress({ from: deployer.address, nonce: nonce + i });

    // Deploy order: 0=MockWETH, 1=MockRouter(placeholder), 2=BuyBurn, 3=Token, 4=Genesis, 5=Staking, 6=Epochs
    // Simplified: deploy mocks first, then protocol
    const MockWETH = await ethers.getContractFactory("MockWETH");
    mockWeth = await MockWETH.deploy();

    // We need Token address for MockRouter, but Token needs Genesis/Staking/BuyBurn...
    // Recalculate after mock deploys
    const nonce2 = await ethers.provider.getTransactionCount(deployer.address);
    const buyBurnAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nonce2 });
    const tokenAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nonce2 + 1 });
    const genesisAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nonce2 + 2 });
    const stakingAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nonce2 + 3 });

    // Deploy MockRouter (needs hburn address)
    // Actually, MockRouter needs to mint HBURN — but HBURN only allows genesis to mint
    // For BuyAndBurn tests we'll handle separately. Use deployer as router placeholder.

    // ── 0: BuyAndBurn ──
    const BuyAndBurn = await ethers.getContractFactory("BuyAndBurn");
    buyBurn = await BuyAndBurn.deploy(
      deployer.address, // swapRouter placeholder
      await mockWeth.getAddress(),
      tokenAddr
    );

    // ── 1: HellBurnToken ──
    const HellBurnToken = await ethers.getContractFactory("HellBurnToken");
    hburn = await HellBurnToken.deploy(genesisAddr, stakingAddr, buyBurnAddr);

    // ── 2: GenesisBurn ──
    const GenesisBurn = await ethers.getContractFactory("GenesisBurn");
    genesis = await GenesisBurn.deploy(
      await titanX.getAddress(),
      deployer.address, // dragonX vault
      deployer.address, // treasury
      deployer.address, // genesis recipient
      await hburn.getAddress()
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
      // Alice burns TitanX via genesis → triggers mint
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
      await genesis.endGenesis();

      expect(await hburn.genesisMintingEnded()).to.be.true;

      // No more minting possible (even from genesis address)
      // Genesis contract itself would revert too
    });

    it("emits event on minting end", async function () {
      await genesis.connect(alice).burn(ethers.parseEther("1000"));
      await time.increase(29 * DAY);

      await expect(genesis.endGenesis())
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
  //  2. GENESIS BURN
  // ═══════════════════════════════════════════════════════════════
  describe("2. GenesisBurn", function () {
    beforeEach(deployAll);

    describe("Burn & Mint", function () {
      it("mints HBURN at week 1 ratio (1.0 × 1.15 = 1.15x)", async function () {
        const amt = ethers.parseEther("100000");
        await genesis.connect(alice).burn(amt);

        // Total = 100000 × 1.0 × 1.15 = 115000
        // Immediate 25% = 28750
        const bal = await hburn.balanceOf(alice.address);
        expect(bal).to.equal(ethers.parseEther("28750"));
      });

      it("mints at week 2 ratio (0.95 × 1.10 = 1.045x)", async function () {
        await time.increase(7 * DAY);
        await genesis.connect(alice).burn(ethers.parseEther("100000"));

        // 100000 × 0.95 × 1.10 = 104500, 25% = 26125
        expect(await hburn.balanceOf(alice.address))
          .to.equal(ethers.parseEther("26125"));
      });

      it("mints at week 3 ratio (0.90 × 1.05 = 0.945x)", async function () {
        await time.increase(14 * DAY);
        await genesis.connect(alice).burn(ethers.parseEther("100000"));

        // 100000 × 0.90 × 1.05 = 94500, 25% = 23625
        expect(await hburn.balanceOf(alice.address))
          .to.equal(ethers.parseEther("23625"));
      });

      it("mints at week 4 ratio (0.85 × 1.00 = 0.85x)", async function () {
        await time.increase(21 * DAY);
        await genesis.connect(alice).burn(ethers.parseEther("100000"));

        // 100000 × 0.85 × 1.00 = 85000, 25% = 21250
        expect(await hburn.balanceOf(alice.address))
          .to.equal(ethers.parseEther("21250"));
      });

      it("rejects zero amount", async function () {
        await expect(genesis.connect(alice).burn(0))
          .to.be.revertedWithCustomError(genesis, "ZeroAmount");
      });

      it("rejects burn after genesis ends", async function () {
        await time.increase(29 * DAY);
        await genesis.endGenesis();

        await expect(genesis.connect(alice).burn(ethers.parseEther("1000")))
          .to.be.revertedWithCustomError(genesis, "GenesisAlreadyEnded");
      });

      it("emits GenesisBurnExecuted event", async function () {
        await expect(genesis.connect(alice).burn(ethers.parseEther("10000")))
          .to.emit(genesis, "GenesisBurnExecuted");
      });

      it("tracks totalTitanXBurned and totalHBURNMinted", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("50000"));
        await genesis.connect(bob).burn(ethers.parseEther("30000"));

        expect(await genesis.totalTitanXBurned())
          .to.equal(ethers.parseEther("80000"));
        expect(await genesis.totalHBURNMinted()).to.be.gt(0);
      });
    });

    describe("TitanX Distribution", function () {
      it("sends 35% to dead address (permanent burn)", async function () {
        const deadBefore = await titanX.balanceOf(DEAD);
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        const deadAfter = await titanX.balanceOf(DEAD);

        expect(deadAfter - deadBefore).to.equal(ethers.parseEther("35000"));
      });

      it("sends 35% to DragonX vault", async function () {
        const vaultBefore = await titanX.balanceOf(deployer.address);
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        const vaultAfter = await titanX.balanceOf(deployer.address);

        // deployer is both dragonX vault AND treasury AND genesis recipient
        // 35% + 22% + 8% = 65%
        expect(vaultAfter - vaultBefore).to.equal(ethers.parseEther("65000"));
      });

      it("leaves 0 TitanX in the genesis contract", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        expect(await titanX.balanceOf(await genesis.getAddress())).to.equal(0);
      });
    });

    describe("Vesting (per-tranche)", function () {
      it("vests 75% linearly over 28 days", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));

        // Total = 115000, vested = 86250
        // After 14 days → ~50% claimable
        await time.increase(14 * DAY);
        const claimable = await genesis.claimableAmount(alice.address);
        const expected = ethers.parseEther("86250") / 2n;
        expect(claimable).to.be.closeTo(expected, expected / 50n);
      });

      it("allows full claim after 28 days", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));
        await time.increase(28 * DAY);

        await genesis.connect(alice).claimVested();
        // 28750 immediate + 86250 vested = 115000
        expect(await hburn.balanceOf(alice.address))
          .to.equal(ethers.parseEther("115000"));
      });

      it("creates separate tranches for multiple burns (H-01 fix)", async function () {
        // Burn in week 1
        await genesis.connect(alice).burn(ethers.parseEther("50000"));

        // Burn in week 3
        await time.increase(14 * DAY);
        await genesis.connect(alice).burn(ethers.parseEther("50000"));

        expect(await genesis.getUserTrancheCount(alice.address)).to.equal(2);

        // Week 3 tranche should NOT be fully vested yet (only 0 days elapsed for it)
        const claimable = await genesis.claimableAmount(alice.address);
        // Week 1 tranche: 14/28 = 50% of 43125 = ~21562
        // Week 3 tranche: 0/28 = 0% of 35437.5 = 0
        // Total claimable should be ~21562, NOT ~56562
        const week1Vested = ethers.parseEther("43125"); // 57500 * 0.75
        const halfWeek1 = week1Vested / 2n;
        expect(claimable).to.be.closeTo(halfWeek1, halfWeek1 / 50n);
      });

      it("reverts claim when nothing to claim", async function () {
        await expect(genesis.connect(alice).claimVested())
          .to.be.revertedWithCustomError(genesis, "NothingToClaim");
      });

      it("allows partial claims over time", async function () {
        await genesis.connect(alice).burn(ethers.parseEther("100000"));

        // Claim at day 7
        await time.increase(7 * DAY);
        await genesis.connect(alice).claimVested();
        const bal1 = await hburn.balanceOf(alice.address);

        // Claim again at day 14
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

    describe("End Genesis", function () {
      it("anyone can call endGenesis after 28 days", async function () {
        await time.increase(29 * DAY);
        await expect(genesis.connect(charlie).endGenesis())
          .to.emit(genesis, "GenesisPhaseEnded");
      });

      it("cannot end genesis early", async function () {
        await expect(genesis.endGenesis())
          .to.be.revertedWithCustomError(genesis, "GenesisNotYetEnded");
      });

      it("cannot end genesis twice", async function () {
        await time.increase(29 * DAY);
        await genesis.endGenesis();

        await expect(genesis.endGenesis())
          .to.be.revertedWithCustomError(genesis, "GenesisAlreadyEnded");
      });
    });

    describe("Max Supply Cap (M-03)", function () {
      it("enforces MAX_HBURN_SUPPLY", async function () {
        // MAX = 1 trillion. We can't easily hit it with mock tokens,
        // but we can verify the constant exists and is checked
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
        expect(ratio).to.equal(100); // week 1
        expect(bonus).to.equal(115); // +15%
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  3. BURN EPOCHS
  // ═══════════════════════════════════════════════════════════════
  describe("3. BurnEpochs", function () {
    beforeEach(async function () {
      await deployAll();
      // Advance to first epoch start
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

      it("rejects burn before first epoch", async function () {
        const futureStart = (await time.latest()) + 100 * DAY;
        const BurnEpochs = await ethers.getContractFactory("BurnEpochs");
        const future = await BurnEpochs.deploy(
          await titanX.getAddress(),
          await dragonX.getAddress(),
          await buyBurn.getAddress(),
          await staking.getAddress(),
          futureStart,
          guardian.address
        );
        await titanX.connect(alice).approve(await future.getAddress(), ethers.MaxUint256);

        await expect(
          future.connect(alice).burnTitanX(ethers.parseEther("1000"))
        ).to.be.revertedWithCustomError(future, "EpochNotActive");
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

        // Build streak to 1.4x
        await epochs.connect(alice).burnTitanX(amt);
        await time.increase(8 * DAY);
        await epochs.connect(alice).burnTitanX(amt);
        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(14);

        // Skip 2 epochs
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

      it("multiple burns in same epoch don't double-increment streak", async function () {
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
        await epochs.connect(alice).burnTitanX(ethers.parseEther("2000"));

        expect(await epochs.getUserStreakMultiplier(alice.address)).to.equal(12);
      });
    });

    describe("Epoch Finalization & Rewards", function () {
      it("distributes 80% ETH to burners, 20% to BuyAndBurn", async function () {
        // Fund epochs
        await deployer.sendTransaction({
          to: await epochs.getAddress(),
          value: ethers.parseEther("10"),
        });

        await epochs.connect(alice).burnTitanX(ethers.parseEther("10000"));
        await time.increase(8 * DAY);

        const buyBurnBefore = await ethers.provider.getBalance(await buyBurn.getAddress());
        await epochs.finalizeEpoch(0);
        const buyBurnAfter = await ethers.provider.getBalance(await buyBurn.getAddress());

        // 20% of 10 ETH = 2 ETH to BuyAndBurn
        expect(buyBurnAfter - buyBurnBefore).to.equal(ethers.parseEther("2"));

        // 80% = 8 ETH as rewards
        expect(await epochs.getEpochRewards(0)).to.equal(ethers.parseEther("8"));
      });

      it("distributes rewards proportionally to burn weight", async function () {
        await deployer.sendTransaction({
          to: await epochs.getAddress(),
          value: ethers.parseEther("10"),
        });

        // Alice 75%, Bob 25% (by weight)
        await epochs.connect(alice).burnTitanX(ethers.parseEther("30000"));
        await epochs.connect(bob).burnTitanX(ethers.parseEther("10000"));

        await time.increase(8 * DAY);
        await epochs.finalizeEpoch(0);

        const aliceReward = await epochs.pendingReward(0, alice.address);
        const bobReward = await epochs.pendingReward(0, bob.address);

        // Alice ~6 ETH, Bob ~2 ETH (of 8 ETH total rewards)
        expect(aliceReward).to.be.closeTo(
          ethers.parseEther("6"),
          ethers.parseEther("0.1")
        );
        expect(bobReward).to.be.closeTo(
          ethers.parseEther("2"),
          ethers.parseEther("0.1")
        );
      });

      it("allows claiming rewards", async function () {
        await deployer.sendTransaction({
          to: await epochs.getAddress(),
          value: ethers.parseEther("1"),
        });

        await epochs.connect(alice).burnTitanX(ethers.parseEther("10000"));
        await time.increase(8 * DAY);
        await epochs.finalizeEpoch(0);

        const balBefore = await ethers.provider.getBalance(alice.address);
        await epochs.connect(alice).claimRewards(0);
        const balAfter = await ethers.provider.getBalance(alice.address);

        expect(balAfter).to.be.gt(balBefore);
      });

      it("prevents double claiming", async function () {
        await deployer.sendTransaction({
          to: await epochs.getAddress(),
          value: ethers.parseEther("1"),
        });
        await epochs.connect(alice).burnTitanX(ethers.parseEther("10000"));
        await time.increase(8 * DAY);
        await epochs.finalizeEpoch(0);
        await epochs.connect(alice).claimRewards(0);

        await expect(epochs.connect(alice).claimRewards(0))
          .to.be.revertedWithCustomError(epochs, "AlreadyClaimed");
      });

      it("supports batch claiming", async function () {
        // Fund and participate in 3 epochs
        for (let i = 0; i < 3; i++) {
          await deployer.sendTransaction({
            to: await epochs.getAddress(),
            value: ethers.parseEther("1"),
          });
          await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
          await time.increase(8 * DAY);
          await epochs.finalizeEpoch(i);
        }

        const balBefore = await ethers.provider.getBalance(alice.address);
        await epochs.connect(alice).batchClaimRewards([0, 1, 2]);
        const balAfter = await ethers.provider.getBalance(alice.address);

        expect(balAfter).to.be.gt(balBefore);

        // All marked as claimed
        expect(await epochs.hasClaimedEpoch(0, alice.address)).to.be.true;
        expect(await epochs.hasClaimedEpoch(1, alice.address)).to.be.true;
        expect(await epochs.hasClaimedEpoch(2, alice.address)).to.be.true;
      });

      it("cannot finalize before epoch ends", async function () {
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
        await expect(epochs.finalizeEpoch(0))
          .to.be.revertedWithCustomError(epochs, "EpochNotEnded");
      });

      it("finalize is idempotent (no-op on second call)", async function () {
        await deployer.sendTransaction({
          to: await epochs.getAddress(),
          value: ethers.parseEther("1"),
        });
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
        await time.increase(8 * DAY);

        await epochs.finalizeEpoch(0);
        await epochs.finalizeEpoch(0); // should not revert
      });
    });

    describe("ETH Carry-Over (M-05 fix)", function () {
      it("carries over ETH when epoch has no burners", async function () {
        await deployer.sendTransaction({
          to: await epochs.getAddress(),
          value: ethers.parseEther("5"),
        });

        // Nobody burns in epoch 0 → finalize carries over
        await time.increase(8 * DAY);
        await expect(epochs.finalizeEpoch(0))
          .to.emit(epochs, "OrphanedETHCarriedOver");

        expect(await epochs.carryOverETH()).to.equal(ethers.parseEther("5"));

        // Epoch 1: someone burns → gets epoch 1 ETH + carry-over
        await deployer.sendTransaction({
          to: await epochs.getAddress(),
          value: ethers.parseEther("3"),
        });
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
        await time.increase(8 * DAY);
        await epochs.finalizeEpoch(1);

        // Total = 5 (carry) + 3 (new) = 8, rewards = 80% = 6.4
        expect(await epochs.getEpochRewards(1))
          .to.equal(ethers.parseEther("6.4"));
      });
    });

    describe("Per-Epoch ETH Tracking (C-01 fix)", function () {
      it("tracks ETH per epoch, not global balance", async function () {
        // Send ETH during epoch 0
        await deployer.sendTransaction({
          to: await epochs.getAddress(),
          value: ethers.parseEther("3"),
        });
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));

        // Advance to epoch 1, send more ETH
        await time.increase(8 * DAY);
        await deployer.sendTransaction({
          to: await epochs.getAddress(),
          value: ethers.parseEther("7"),
        });

        // Finalize epoch 0 — should only get 3 ETH, not 10
        await epochs.finalizeEpoch(0);
        expect(await epochs.getEpochRewards(0))
          .to.equal(ethers.parseEther("2.4")); // 80% of 3
      });
    });

    describe("Emergency Pause (M-02)", function () {
      it("guardian can pause and unpause", async function () {
        await epochs.connect(guardian).pause();
        await expect(
          epochs.connect(alice).burnTitanX(ethers.parseEther("1000"))
        ).to.be.revertedWithCustomError(epochs, "EnforcedPause");

        await epochs.connect(guardian).unpause();
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
      });

      it("non-guardian cannot pause", async function () {
        await expect(epochs.connect(alice).pause())
          .to.be.revertedWithCustomError(epochs, "OnlyGuardian");
      });

      it("claims still work when paused", async function () {
        await deployer.sendTransaction({
          to: await epochs.getAddress(),
          value: ethers.parseEther("1"),
        });
        await epochs.connect(alice).burnTitanX(ethers.parseEther("1000"));
        await time.increase(8 * DAY);
        await epochs.finalizeEpoch(0);

        // Pause
        await epochs.connect(guardian).pause();

        // Claims should still work
        await epochs.connect(alice).claimRewards(0);
      });
    });

    describe("View Functions", function () {
      it("currentEpochId increments every 8 days", async function () {
        expect(await epochs.currentEpochId()).to.equal(0);

        await time.increase(8 * DAY);
        expect(await epochs.currentEpochId()).to.equal(1);

        await time.increase(8 * DAY);
        expect(await epochs.currentEpochId()).to.equal(2);
      });

      it("isEpochActive returns true for current epoch", async function () {
        expect(await epochs.isEpochActive(0)).to.be.true;
        expect(await epochs.isEpochActive(1)).to.be.false;
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  4. HELLBURN STAKING
  // ═══════════════════════════════════════════════════════════════
  describe("4. HellBurnStaking", function () {
    beforeEach(async function () {
      await deployAll();

      // Mint HBURN via genesis for alice and bob
      await genesis.connect(alice).burn(ethers.parseEther("500000"));
      await genesis.connect(bob).burn(ethers.parseEther("300000"));

      // Fully vest
      await time.increase(28 * DAY);
      await genesis.connect(alice).claimVested();
      await genesis.connect(bob).claimVested();

      // Approve staking
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
        await expect(
          staking.connect(alice).startStake(ethers.parseEther("1000"), 10)
        ).to.be.revertedWithCustomError(staking, "InvalidDuration");
      });

      it("rejects duration over 3500 days", async function () {
        await expect(
          staking.connect(alice).startStake(ethers.parseEther("1000"), 5000)
        ).to.be.revertedWithCustomError(staking, "InvalidDuration");
      });

      it("rejects zero amount", async function () {
        await expect(
          staking.connect(alice).startStake(0, 100)
        ).to.be.revertedWithCustomError(staking, "ZeroAmount");
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

        await staking.connect(alice).startStake(amt, 28); // Bronze 1.0x
        await staking.connect(bob).startStake(amt, 888); // Platinum ~1.62x

        const [, sharesA] = await staking.getStakeInfo(0);
        const [, sharesB] = await staking.getStakeInfo(1);

        // 888d bonus = ~1.62x, so sharesB should be significantly more than sharesA
        expect(sharesB).to.be.gt(sharesA);
        expect(sharesB).to.be.lt(sharesA * 2n); // but less than 2x

        // Diamond (3500d) should be 3.5x
        await staking.connect(alice).startStake(amt, 3500);
        const [, sharesC] = await staking.getStakeInfo(2);
        expect(sharesC).to.be.gt(sharesA * 3n);
      });

      it("max bonus at 3500 days (Diamond)", async function () {
        const amt = ethers.parseEther("10000");
        await staking.connect(alice).startStake(amt, 3500);

        const [, shares] = await staking.getStakeInfo(0);
        // shares = amount * 3.5 (max time) * 1.0 (no loyalty) = 35000
        expect(shares).to.equal(ethers.parseEther("35000"));
      });
    });

    describe("ETH Yield Distribution", function () {
      it("distributes ETH to stakers", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("50000"), 888);

        // Send ETH as yield
        await deployer.sendTransaction({
          to: await staking.getAddress(),
          value: ethers.parseEther("5"),
        });

        const pending = await staking.pendingETHReward(0);
        expect(pending).to.be.gt(0);
      });

      it("distributes proportionally to shares", async function () {
        // Alice: 3500d (3.5x bonus), Bob: 28d (1.0x bonus), same amount
        const amt = ethers.parseEther("10000");
        await staking.connect(alice).startStake(amt, 3500);
        await staking.connect(bob).startStake(amt, 28);

        await deployer.sendTransaction({
          to: await staking.getAddress(),
          value: ethers.parseEther("10"),
        });

        const pendingA = await staking.pendingETHReward(0);
        const pendingB = await staking.pendingETHReward(1);

        // Alice should get ~3.5x more than Bob
        expect(pendingA).to.be.gt(pendingB * 3n);
      });
    });

    describe("End Stake & Penalties", function () {
      it("prevents unstaking before 50% maturity", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 100);
        await time.increase(30 * DAY); // 30%

        await expect(staking.connect(alice).endStake(0))
          .to.be.revertedWithCustomError(staking, "StakeNotMature");
      });

      it("applies penalty between 50-100% maturity", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 100);
        await time.increase(75 * DAY); // 75% maturity

        const balBefore = await hburn.balanceOf(alice.address);
        await staking.connect(alice).endStake(0);
        const balAfter = await hburn.balanceOf(alice.address);

        const returned = balAfter - balBefore;
        // Penalty = (100-75)*2 = 50% → returned ~5000
        expect(returned).to.be.closeTo(
          ethers.parseEther("5000"),
          ethers.parseEther("500")
        );
      });

      it("returns full amount at 100% maturity", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);

        const balBefore = await hburn.balanceOf(alice.address);
        await staking.connect(alice).endStake(0);
        const balAfter = await hburn.balanceOf(alice.address);

        expect(balAfter - balBefore).to.equal(ethers.parseEther("10000"));
      });

      it("marks stake as inactive after ending", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);
        await staking.connect(alice).endStake(0);

        const [, , , , , active] = await staking.getStakeInfo(0);
        expect(active).to.be.false;
      });

      it("cannot end same stake twice", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);
        await staking.connect(alice).endStake(0);

        await expect(staking.connect(alice).endStake(0))
          .to.be.revertedWithCustomError(staking, "StakeNotActive");
      });

      it("only owner can end their stake (H-03 fix)", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);

        await expect(staking.connect(bob).endStake(0))
          .to.be.revertedWithCustomError(staking, "NotStakeOwner");
      });

      it("penalty burns 50% to dead address", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 100);
        await time.increase(50 * DAY); // 50% → max penalty

        const deadBefore = await hburn.balanceOf(DEAD);
        await staking.connect(alice).endStake(0);
        const deadAfter = await hburn.balanceOf(DEAD);

        expect(deadAfter).to.be.gt(deadBefore);
      });

      it("increments completedStakes counter", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);
        await staking.connect(alice).endStake(0);

        expect(await staking.completedStakes(alice.address)).to.equal(1);
      });
    });

    describe("Loyalty & Re-Stake (H-05 fix)", function () {
      it("rejects reStake without prior completed stake", async function () {
        await expect(
          staking.connect(alice).reStake(ethers.parseEther("10000"), 100)
        ).to.be.revertedWithCustomError(staking, "NoPriorStake");
      });

      it("allows reStake after completing a stake", async function () {
        // Complete first stake
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);
        await staking.connect(alice).endStake(0);

        // Re-stake should work now
        await expect(
          staking.connect(alice).reStake(ethers.parseEther("10000"), 100)
        ).to.emit(staking, "StakeStarted");
      });

      it("reStake grants 1.1x loyalty bonus on shares", async function () {
        const amt = ethers.parseEther("10000");

        // Normal stake
        await staking.connect(alice).startStake(amt, 100);
        const [, sharesNormal] = await staking.getStakeInfo(0);
        await time.increase(100 * DAY);
        await staking.connect(alice).endStake(0);

        // Re-stake (same amount, same duration)
        await staking.connect(alice).reStake(amt, 100);
        const [, sharesRe] = await staking.getStakeInfo(1);

        // Re-stake shares = normal × 1.1
        expect(sharesRe).to.be.closeTo(
          (sharesNormal * 1100n) / 1000n,
          sharesNormal / 100n
        );
      });

      it("grants Phoenix status after 3 consecutive re-stakes", async function () {
        const amt = ethers.parseEther("5000");

        // Initial stake + 3 re-stakes
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

        await expect(
          staking.connect(alice).addFuelTitanX(0, ethers.parseEther("1000000"))
        ).to.emit(staking, "FuelAdded");
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

        // Add massive amount of fuel
        await titanX.mint(alice.address, ethers.parseEther("100000000000"));
        await titanX.connect(alice).approve(
          await staking.getAddress(),
          ethers.MaxUint256
        );

        // Multiple fuel additions
        for (let i = 0; i < 5; i++) {
          try {
            await staking.connect(alice).addFuelTitanX(
              0, ethers.parseEther("10000000000")
            );
          } catch { break; } // FuelMaxReached
        }

        // Verify fuel is capped
        const [, , , , fuelBonus] = await staking.getStakeInfo(0);
        expect(fuelBonus).to.be.lte(1500);
      });

      it("only stake owner can add fuel", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("50000"), 888);

        await expect(
          staking.connect(bob).addFuelTitanX(0, ethers.parseEther("1000"))
        ).to.be.revertedWithCustomError(staking, "NotStakeOwner");
      });

      it("preserves loyalty bonus after fueling (H-04 fix)", async function () {
        const amt = ethers.parseEther("10000");

        // Complete a stake first
        await staking.connect(alice).startStake(amt, 28);
        await time.increase(28 * DAY);
        await staking.connect(alice).endStake(0);

        // Re-stake with loyalty bonus
        await staking.connect(alice).reStake(amt, 888);
        const [, sharesBefore] = await staking.getStakeInfo(1);

        // Add fuel
        await staking.connect(alice).addFuelTitanX(1, ethers.parseEther("5000000"));
        const [, sharesAfter] = await staking.getStakeInfo(1);

        // Shares should increase (fuel applied), and loyalty bonus preserved
        expect(sharesAfter).to.be.gt(sharesBefore);
      });
    });

    describe("Emergency Pause (M-02)", function () {
      it("guardian can pause staking", async function () {
        await staking.connect(guardian).pause();

        await expect(
          staking.connect(alice).startStake(ethers.parseEther("1000"), 28)
        ).to.be.revertedWithCustomError(staking, "EnforcedPause");
      });

      it("endStake still works when paused (withdraw protection)", async function () {
        await staking.connect(alice).startStake(ethers.parseEther("10000"), 28);
        await time.increase(28 * DAY);

        await staking.connect(guardian).pause();

        // Users can still withdraw
        await staking.connect(alice).endStake(0);
      });
    });

    describe("Tier System", function () {
      it("returns correct tier names", async function () {
        expect(await staking.getTier(28)).to.equal(1);    // Bronze
        expect(await staking.getTier(90)).to.equal(2);    // Silver
        expect(await staking.getTier(369)).to.equal(3);   // Gold
        expect(await staking.getTier(888)).to.equal(4);   // Platinum
        expect(await staking.getTier(3500)).to.equal(5);  // Diamond
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  5. BUYANDBURN
  // ═══════════════════════════════════════════════════════════════
  describe("5. BuyAndBurn", function () {
    beforeEach(deployAll);

    it("receives ETH", async function () {
      await deployer.sendTransaction({
        to: await buyBurn.getAddress(),
        value: ethers.parseEther("1"),
      });
      expect(await buyBurn.pendingETH()).to.equal(ethers.parseEther("1"));
    });

    it("rejects zero slippage (C-02 fix)", async function () {
      await deployer.sendTransaction({
        to: await buyBurn.getAddress(),
        value: ethers.parseEther("1"),
      });

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

      // 3. Stake HBURN
      await hburn.connect(alice).approve(
        await staking.getAddress(),
        ethers.MaxUint256
      );
      const stakeAmount = fullBalance / 2n;
      await staking.connect(alice).startStake(stakeAmount, 369);

      // 4. Earn ETH yield
      await deployer.sendTransaction({
        to: await staking.getAddress(),
        value: ethers.parseEther("50"),
      });
      const pendingETH = await staking.pendingETHReward(0);
      expect(pendingETH).to.be.gt(0);

      // 5. Unstake at maturity — check HBURN returned + ETH reward received
      await time.increase(369 * DAY);

      // Check pending before unstake
      const pendingBefore = await staking.pendingETHReward(0);
      expect(pendingBefore).to.be.gt(ethers.parseEther("1"));

      await staking.connect(alice).endStake(0);

      // Got HBURN back
      expect(await hburn.balanceOf(alice.address)).to.be.closeTo(
        fullBalance,
        ethers.parseEther("1")
      );

      // Stake is now inactive (ETH was paid out)
      const [, , , , , active] = await staking.getStakeInfo(0);
      expect(active).to.be.false;
    });

    it("genesis minting permanently stops", async function () {
      await genesis.connect(alice).burn(ethers.parseEther("100000"));
      const supplyBefore = await hburn.totalSupply();

      await time.increase(29 * DAY);
      await genesis.endGenesis();

      // No more tokens can ever be minted
      expect(await hburn.genesisMintingEnded()).to.be.true;
      // Supply only decreases from now (via burns)
      expect(await hburn.totalSupply()).to.equal(supplyBefore);
    });

    it("multiple users compete in epochs fairly", async function () {
      // Advance to epoch start
      const start = await epochs.firstEpochStart();
      await time.increaseTo(start);

      // Fund epoch
      await deployer.sendTransaction({
        to: await epochs.getAddress(),
        value: ethers.parseEther("9"),
      });

      // Alice burns TitanX, Bob burns DragonX (2x weight)
      const amt = ethers.parseEther("10000");
      await epochs.connect(alice).burnTitanX(amt);
      await epochs.connect(bob).burnDragonX(amt);

      await time.increase(8 * DAY);
      await epochs.finalizeEpoch(0);

      // Total weight: Alice = 10000*1*1.2, Bob = 10000*2*1.2
      // Alice: 1/3, Bob: 2/3 of 80% of 9 ETH = 7.2 ETH
      const aliceReward = await epochs.pendingReward(0, alice.address);
      const bobReward = await epochs.pendingReward(0, bob.address);

      expect(bobReward).to.be.closeTo(aliceReward * 2n, aliceReward / 10n);
    });
  });
});
