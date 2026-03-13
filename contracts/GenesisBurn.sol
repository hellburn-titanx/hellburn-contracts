// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/ITitanX.sol";
import "./interfaces/ISwapRouter.sol";
import "./interfaces/INonfungiblePositionManager.sol";
import "./interfaces/IERC20Burnable.sol";
import "./HellBurnToken.sol";

/**
 * @title GenesisBurn (Fair Launch Edition)
 * @notice 28-day genesis phase: users burn TitanX to mint HBURN.
 *
 * AUDIT FIXES v2:
 *   [H-01] Per-tranche vesting — each burn starts its own 28-day vest
 *   [M-03] Max supply cap enforced
 *   [L-01] Zero-address checks
 *   [L-04] Corrected error semantics
 *
 * AUDIT FIXES v3 (SpyWolf):
 *   [H-02] _calculateSqrtPriceX96 uses single-sqrt (OZ Math.mulDiv) — no double truncation
 *   [H-03] MIN_BURN_AMOUNT enforced; claimVestedPaged() added for gas-safe claiming
 *   [M-01] minWETHOut > 0 enforced in endGenesis
 *   [M-02] Caller-supplied deadline flows through endGenesis → swap and LP mint
 *   [M-05] hburn.burn() used instead of safeTransfer(DEAD_ADDRESS) in collectLPFees
 *   [I-04] onERC721Received validates sender is positionManager
 */
contract GenesisBurn is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant GENESIS_DURATION = 28 days;
    uint256 public constant VESTING_DURATION = 28 days;
    uint256 public constant IMMEDIATE_PERCENT = 25;
    uint256 public constant VESTED_PERCENT = 75;

    uint256 public constant BURN_PERCENT = 35;
    uint256 public constant DRAGONX_PERCENT = 35;
    uint256 public constant TREASURY_PERCENT = 22;
    uint256 public constant GENESIS_FEE_PERCENT = 8;

    // Fair Launch: 3% of minted HBURN goes to LP reserve
    uint256 public constant LP_RESERVE_PERCENT = 3;

    uint256 public constant WEEK1_BONUS = 115;
    uint256 public constant WEEK2_BONUS = 110;
    uint256 public constant WEEK3_BONUS = 105;
    uint256 public constant WEEK4_BONUS = 100;
    uint256 public constant BASIS = 100;

    // [M-03] Max supply cap
    uint256 public constant MAX_HBURN_SUPPLY = 1_000_000_000_000 ether; // 1 trillion

    // [H-03] Minimum burn to prevent tranche array bloat / gas griefing
    uint256 public constant MIN_BURN_AMOUNT = 1e18; // 1 full TitanX token

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // Uniswap V3 constants
    uint24 public constant POOL_FEE = 10000; // 1% fee tier
    // Full-range ticks for 1% fee tier (tickSpacing = 200)
    int24 public constant MIN_TICK = -887200;
    int24 public constant MAX_TICK = 887200;

    // ─── Immutables ──────────────────────────────────────────────────
    ITitanX public immutable titanX;
    address public immutable dragonXVault;
    address public immutable buyAndBurn;
    HellBurnToken public immutable hburn;

    // Uniswap
    ISwapRouter public immutable swapRouter;
    INonfungiblePositionManager public immutable positionManager;
    IWETH public immutable weth;

    // TitanX/WETH pool fee for the genesis fund swap
    uint24 public immutable titanXWethPoolFee;

    uint256 public immutable genesisStart;
    uint256 public immutable genesisEnd;

    // ─── State ───────────────────────────────────────────────────────
    uint256 public totalTitanXBurned;
    uint256 public totalHBURNMinted;
    bool public genesisEnded;

    // Fair Launch LP state
    uint256 public lpReserveHBURN;       // HBURN accumulated for LP
    uint256 public genesisFundTitanX;    // TitanX accumulated from 8% fee
    uint256 public lpTokenId;            // Uniswap V3 NFT position ID
    bool public lpCreated;

    // Treasury auto-stake state (22% TitanX — fully trustless)
    uint256 public treasuryTitanX;       // TitanX accumulated from 22% fee
    bool public treasuryStaked;          // Whether treasury has been staked

    // [H-01] Per-tranche vesting
    struct VestingTranche {
        uint256 amount;
        uint256 vestingStart;
        uint256 claimed;
    }

    mapping(address => VestingTranche[]) public vestingTranches;

    // ─── Events ──────────────────────────────────────────────────────
    event GenesisBurnExecuted(
        address indexed user, uint256 titanXAmount, uint256 hburnMinted,
        uint256 immediateAmount, uint256 vestedAmount, uint256 lpReserveAmount,
        uint256 week
    );
    event VestingClaimed(address indexed user, uint256 amount);
    event GenesisPhaseEnded(uint256 totalBurned, uint256 totalMinted);
    event LiquidityPoolCreated(
        uint256 tokenId, uint256 hburnAmount, uint256 wethAmount,
        uint256 liquidity
    );
    event LPFeesCollected(uint256 hburnBurned, uint256 wethToBuyBurn);
    event TreasuryStaked(uint256 titanXAmount, uint256 numDays);
    event TreasuryYieldClaimed(uint256 ethAmount);

    // ─── Errors ──────────────────────────────────────────────────────
    error GenesisNotStarted();
    error GenesisAlreadyEnded();
    error GenesisNotYetEnded();
    error ZeroAmount();
    error NothingToClaim();
    error TransferFailed();
    error MaxSupplyExceeded();
    error LPAlreadyCreated();
    error LPNotCreated();
    error InsufficientLiquidity();
    error TreasuryAlreadyStaked();
    error NothingToStake();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(
        address _titanX,
        address _dragonXVault,
        address _hburn,
        address _swapRouter,
        address _positionManager,
        address _weth,
        uint24 _titanXWethPoolFee,
        address _buyAndBurn
    ) {
        require(_titanX != address(0) && _dragonXVault != address(0), "zero addr");
        require(_hburn != address(0) && _buyAndBurn != address(0), "zero addr");
        require(_swapRouter != address(0) && _positionManager != address(0), "zero addr");
        require(_weth != address(0), "zero addr");

        titanX = ITitanX(_titanX);
        dragonXVault = _dragonXVault;
        buyAndBurn = _buyAndBurn;
        hburn = HellBurnToken(_hburn);

        swapRouter = ISwapRouter(_swapRouter);
        positionManager = INonfungiblePositionManager(_positionManager);
        weth = IWETH(_weth);
        titanXWethPoolFee = _titanXWethPoolFee;

        genesisStart = block.timestamp;
        genesisEnd = block.timestamp + GENESIS_DURATION;
    }

    // ─── Receive ETH (needed for WETH unwrap) ────────────────────────
    receive() external payable {}

    // ─── Genesis Burn ────────────────────────────────────────────────
    function burn(uint256 titanXAmount) external nonReentrant {
        if (block.timestamp < genesisStart) revert GenesisNotStarted();
        if (block.timestamp > genesisEnd || genesisEnded) revert GenesisAlreadyEnded();
        if (titanXAmount == 0) revert ZeroAmount();
        // [H-03] Enforce minimum to prevent vesting tranche array bloat / gas griefing
        require(titanXAmount >= MIN_BURN_AMOUNT, "burn: below minimum 1 TitanX");

        // Transfer TitanX from user
        IERC20(address(titanX)).safeTransferFrom(msg.sender, address(this), titanXAmount);

        // Distribute TitanX (8% Genesis Fund stays in contract)
        _distributeTitanX(titanXAmount);

        // Calculate total HBURN to mint
        (uint256 hburnAmount, uint256 week) = _calculateMintAmount(titanXAmount);

        // [M-03] Enforce max supply
        if (totalHBURNMinted + hburnAmount > MAX_HBURN_SUPPLY) revert MaxSupplyExceeded();

        // ── Fair Launch Split: 3% → LP reserve, 97% → user ──────────
        uint256 lpAmount = (hburnAmount * LP_RESERVE_PERCENT) / 100;
        uint256 userAmount = hburnAmount - lpAmount;

        uint256 immediateAmount = (userAmount * IMMEDIATE_PERCENT) / 100;
        uint256 vestedAmount = userAmount - immediateAmount;

        // ── CEI: all state changes BEFORE external mint calls ────────
        lpReserveHBURN += lpAmount;
        totalTitanXBurned += titanXAmount;
        totalHBURNMinted += hburnAmount;

        // [H-01] Record vesting tranche before any external calls
        vestingTranches[msg.sender].push(VestingTranche({
            amount: vestedAmount,
            vestingStart: block.timestamp,
            claimed: 0
        }));

        // ── External calls (minting) last ────────────────────────────
        hburn.mint(address(this), lpAmount);
        hburn.mint(msg.sender, immediateAmount);
        hburn.mint(address(this), vestedAmount);

        emit GenesisBurnExecuted(
            msg.sender, titanXAmount, hburnAmount,
            immediateAmount, vestedAmount, lpAmount, week
        );
    }

    // ─── Claim Vested ────────────────────────────────────────────────
    function claimVested() external nonReentrant {
        uint256 totalClaimable = 0;
        VestingTranche[] storage tranches = vestingTranches[msg.sender];

        for (uint256 i = 0; i < tranches.length; i++) {
            uint256 trancheClaimable = _trancheClaimable(tranches[i]);
            if (trancheClaimable > 0) {
                tranches[i].claimed += trancheClaimable;
                totalClaimable += trancheClaimable;
            }
        }

        if (totalClaimable == 0) revert NothingToClaim();

        IERC20(address(hburn)).safeTransfer(msg.sender, totalClaimable);
        emit VestingClaimed(msg.sender, totalClaimable);
    }

    /**
     * @notice [H-03] Paginated vesting claim — prevents gas griefing on large tranche arrays.
     *         Process `count` tranches starting at `startIdx`.
     *         Call repeatedly until all tranches are processed.
     * @param startIdx First tranche index to process (0-based)
     * @param count    Number of tranches to process in this call
     */
    function claimVestedPaged(uint256 startIdx, uint256 count) external nonReentrant {
        VestingTranche[] storage tranches = vestingTranches[msg.sender];
        uint256 end = startIdx + count;
        if (end > tranches.length) end = tranches.length;
        require(startIdx < end, "no tranches in range");

        uint256 totalClaimable = 0;
        for (uint256 i = startIdx; i < end; i++) {
            uint256 trancheClaimable = _trancheClaimable(tranches[i]);
            if (trancheClaimable > 0) {
                tranches[i].claimed += trancheClaimable;
                totalClaimable += trancheClaimable;
            }
        }

        if (totalClaimable == 0) revert NothingToClaim();

        IERC20(address(hburn)).safeTransfer(msg.sender, totalClaimable);
        emit VestingClaimed(msg.sender, totalClaimable);
    }

    // ═════════════════════════════════════════════════════════════════
    // ═══ FAIR LAUNCH: End Genesis + Create LP (Trustless) ═══════════
    // ═════════════════════════════════════════════════════════════════
    /**
     * @notice Ends genesis, swaps accumulated TitanX → WETH, creates
     *         a permanent full-range Uniswap V3 LP position.
     *
     *         Callable by ANYONE after genesis period ends.
     *         The LP-NFT is permanently locked in this contract.
     *         No admin, no owner, no withdraw function exists.
     *
     * @param minWETHOut Minimum WETH from TitanX swap (MEV protection, MUST be > 0).
     *                   Use an off-chain quote or TWAP to calculate a safe value.
     * @param deadline   Unix timestamp after which the swap/LP tx reverts.
     *                   Set off-chain: Math.floor(Date.now()/1000) + 300
     */
    function endGenesis(uint256 minWETHOut, uint256 deadline) external nonReentrant {
        if (block.timestamp <= genesisEnd) revert GenesisNotYetEnded();
        if (genesisEnded) revert GenesisAlreadyEnded();
        // [M-01] Enforce non-zero slippage protection
        require(minWETHOut > 0, "endGenesis: minWETHOut must be > 0");
        // [M-02] Deadline must be in the future (caller-supplied, not block.timestamp+N)
        require(deadline > block.timestamp, "endGenesis: deadline expired");

        genesisEnded = true;
        hburn.endGenesisMinting();

        emit GenesisPhaseEnded(totalTitanXBurned, totalHBURNMinted);

        // If nobody participated, skip LP creation
        if (genesisFundTitanX == 0 || lpReserveHBURN == 0) return;

        _createLiquidityPool(minWETHOut, deadline);
    }

    // ─── Collect LP Fees (Public Good) ───────────────────────────────
    /**
     * @notice Collects trading fees from the LP position.
     *         HBURN fees → burned (dead address).
     *         WETH fees → sent to BuyAndBurn contract as ETH.
     *         Callable by anyone. No admin access to funds.
     */
    function collectLPFees() external nonReentrant {
        if (!lpCreated) revert LPNotCreated();

        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: lpTokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        // Determine token ordering
        bool hburnIsToken0 = address(hburn) < address(weth);
        uint256 hburnFees = hburnIsToken0 ? amount0 : amount1;
        uint256 wethFees = hburnIsToken0 ? amount1 : amount0;

        // Burn HBURN fees — [M-05] use burn() so totalSupply decreases
        if (hburnFees > 0) {
            hburn.burn(hburnFees);
        }

        // Send WETH fees → ETH → BuyAndBurn
        if (wethFees > 0) {
            weth.withdraw(wethFees);
            (bool sent,) = buyAndBurn.call{value: wethFees}("");
            if (!sent) revert TransferFailed();
        }

        emit LPFeesCollected(hburnFees, wethFees);
    }

    // ─── Treasury Auto-Stake (Trustless) ─────────────────────────────
    /**
     * @notice Stakes ALL accumulated treasury TitanX for 3500 days.
     *         Callable by anyone after genesis ends.
     *         The stake generates ETH yield over time.
     *         No one can withdraw the staked TitanX — it's locked for 3500 days.
     */
    function stakeTreasury() external nonReentrant {
        if (!genesisEnded) revert GenesisNotYetEnded();
        if (treasuryStaked) revert TreasuryAlreadyStaked();
        if (treasuryTitanX == 0) revert NothingToStake();

        treasuryStaked = true;
        uint256 amount = treasuryTitanX;

        // Approve TitanX to itself for staking (required by some implementations)
        IERC20(address(titanX)).forceApprove(address(titanX), amount);
        titanX.startStake(amount, 3500);

        emit TreasuryStaked(amount, 3500);
    }

    /**
     * @notice Claims accumulated ETH yield from the treasury TitanX stake
     *         and forwards ALL to BuyAndBurn (buys HBURN + burns it).
     *         Callable by anyone. No admin. Fully permissionless.
     */
    function claimTreasuryYield() external nonReentrant {
        uint256 balBefore = address(this).balance;
        titanX.claimUserAvailableETHPayouts();
        uint256 claimed = address(this).balance - balBefore;

        if (claimed > 0) {
            (bool sent,) = buyAndBurn.call{value: claimed}("");
            if (!sent) revert TransferFailed();
            emit TreasuryYieldClaimed(claimed);
        }
    }

    // ─── Views ───────────────────────────────────────────────────────
    function claimableAmount(address user) external view returns (uint256) {
        uint256 total = 0;
        VestingTranche[] storage tranches = vestingTranches[user];
        for (uint256 i = 0; i < tranches.length; i++) {
            total += _trancheClaimable(tranches[i]);
        }
        return total;
    }

    function getUserTrancheCount(address user) external view returns (uint256) {
        return vestingTranches[user].length;
    }

    function currentWeek() external view returns (uint256) {
        return _currentWeek();
    }

    function currentMintRatio() external view returns (uint256 ratio, uint256 bonus) {
        uint256 week = _currentWeek();
        ratio = _weekRatio(week);
        bonus = _weekBonus(week);
    }

    /// @notice Returns effective user share (97% after LP reserve)
    function effectiveUserPercent() external pure returns (uint256) {
        return 100 - LP_RESERVE_PERCENT;
    }

    /// @notice Returns LP creation status and reserves
    function lpInfo() external view returns (
        bool created, uint256 tokenId, uint256 reserveHBURN, uint256 fundTitanX
    ) {
        return (lpCreated, lpTokenId, lpReserveHBURN, genesisFundTitanX);
    }

    /// @notice Returns treasury auto-stake status
    function treasuryInfo() external view returns (
        uint256 titanXAmount, bool staked
    ) {
        return (treasuryTitanX, treasuryStaked);
    }

    // ─── Internal ────────────────────────────────────────────────────
    function _distributeTitanX(uint256 amount) internal {
        uint256 burnAmount = (amount * BURN_PERCENT) / 100;
        uint256 dragonAmount = (amount * DRAGONX_PERCENT) / 100;
        uint256 treasuryAmount = (amount * TREASURY_PERCENT) / 100;
        uint256 genesisAmount = amount - burnAmount - dragonAmount - treasuryAmount;

        IERC20 titan = IERC20(address(titanX));

        // 35% permanent burn
        titan.safeTransfer(DEAD_ADDRESS, burnAmount);
        // 35% DragonX vault
        titan.safeTransfer(dragonXVault, dragonAmount);
        // 22% treasury — stays in contract for auto-stake (trustless)
        treasuryTitanX += treasuryAmount;

        // 8% Genesis Fund — stays in this contract for LP creation
        genesisFundTitanX += genesisAmount;
    }

    function _createLiquidityPool(uint256 minWETHOut, uint256 deadline) internal {
        // ── Step 1: Swap Genesis Fund TitanX → WETH ──────────────────
        uint256 titanXBalance = genesisFundTitanX;
        IERC20(address(titanX)).forceApprove(address(swapRouter), titanXBalance);

        uint256 wethReceived = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(titanX),
                tokenOut: address(weth),
                fee: titanXWethPoolFee,
                recipient: address(this),
                deadline: deadline,      // [M-02] caller-supplied deadline
                amountIn: titanXBalance,
                amountOutMinimum: minWETHOut,
                sqrtPriceLimitX96: 0
            })
        );

        // ── Step 2: Create & Initialize Pool ─────────────────────────
        uint256 hburnForLP = lpReserveHBURN;
        bool hburnIsToken0 = address(hburn) < address(weth);

        // Calculate sqrtPriceX96 for initial price
        // price = token1/token0, so we need the right ratio
        uint160 sqrtPriceX96;
        if (hburnIsToken0) {
            // price = WETH per HBURN = wethReceived / hburnForLP
            // sqrtPriceX96 = sqrt(price) * 2^96
            sqrtPriceX96 = _calculateSqrtPriceX96(hburnForLP, wethReceived);
        } else {
            // price = HBURN per WETH = hburnForLP / wethReceived
            sqrtPriceX96 = _calculateSqrtPriceX96(wethReceived, hburnForLP);
        }

        // slither-disable-next-line unused-return — pool address not needed; contract is immutable
        positionManager.createAndInitializePoolIfNecessary(
            hburnIsToken0 ? address(hburn) : address(weth),
            hburnIsToken0 ? address(weth) : address(hburn),
            POOL_FEE,
            sqrtPriceX96
        );

        // ── Step 3: Mint Full-Range LP Position ──────────────────────
        IERC20(address(hburn)).forceApprove(address(positionManager), hburnForLP);
        IERC20(address(weth)).forceApprove(address(positionManager), wethReceived);

        (uint256 tokenId, uint128 liquidity,,) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: hburnIsToken0 ? address(hburn) : address(weth),
                token1: hburnIsToken0 ? address(weth) : address(hburn),
                fee: POOL_FEE,
                tickLower: MIN_TICK,
                tickUpper: MAX_TICK,
                amount0Desired: hburnIsToken0 ? hburnForLP : wethReceived,
                amount1Desired: hburnIsToken0 ? wethReceived : hburnForLP,
                amount0Min: 0,    // First LP sets the price — accept any ratio
                amount1Min: 0,
                recipient: address(this), // LP-NFT permanently locked here
                deadline: deadline        // [M-02] caller-supplied deadline
            })
        );

        // slither-disable-next-line reentrancy-benign
        // Rationale: endGenesis() sets genesisEnded=true as first action (CEI).
        // positionManager is an immutable trusted address. nonReentrant guards endGenesis().
        lpTokenId = tokenId;
        lpCreated = true;

        emit LiquidityPoolCreated(tokenId, hburnForLP, wethReceived, liquidity);
    }

    /**
     * @dev [H-02] Calculates sqrtPriceX96 = sqrt(amount1/amount0) * 2^96
     *      Uses a single integer sqrt on a scaled value to avoid double-truncation
     *      error from independently computing sqrt(amount1) and sqrt(amount0).
     *
     *      Correct formula: sqrt(amount1 * 2^192 / amount0)
     *      We compute this as sqrt(Math.mulDiv(amount1, 1<<192, amount0))
     *      which keeps full precision before the single truncating sqrt.
     */
    function _calculateSqrtPriceX96(uint256 amount0, uint256 amount1)
        internal pure returns (uint160)
    {
        require(amount0 > 0, "zero amount0");
        // Scale amount1 by 2^192 before dividing by amount0, then take single sqrt.
        // Math.mulDiv handles the intermediate overflow safely.
        uint256 ratioX192 = Math.mulDiv(amount1, 1 << 192, amount0);
        uint256 sqrtRatioX96 = Math.sqrt(ratioX192);
        return uint160(sqrtRatioX96);
    }

    function _calculateMintAmount(uint256 titanXAmount)
        internal view returns (uint256 hburnAmount, uint256 week)
    {
        week = _currentWeek();
        uint256 ratio = _weekRatio(week);
        uint256 bonus = _weekBonus(week);
        hburnAmount = (titanXAmount * ratio * bonus) / (100 * 100);
    }

    function _weekRatio(uint256 week) internal pure returns (uint256) {
        if (week == 1) return 100;
        if (week == 2) return 95;
        if (week == 3) return 90;
        return 85;
    }

    function _weekBonus(uint256 week) internal pure returns (uint256) {
        if (week == 1) return WEEK1_BONUS;
        if (week == 2) return WEEK2_BONUS;
        if (week == 3) return WEEK3_BONUS;
        return WEEK4_BONUS;
    }

    function _currentWeek() internal view returns (uint256) {
        if (block.timestamp < genesisStart) return 0;
        uint256 elapsed = block.timestamp - genesisStart;
        uint256 week = (elapsed / 7 days) + 1;
        return week > 4 ? 4 : week;
    }

    function _trancheClaimable(VestingTranche storage t) internal view returns (uint256) {
        if (t.amount == 0) return 0;

        uint256 elapsed = block.timestamp - t.vestingStart;
        uint256 totalUnlocked;

        if (elapsed >= VESTING_DURATION) {
            totalUnlocked = t.amount;
        } else {
            totalUnlocked = (t.amount * elapsed) / VESTING_DURATION;
        }

        return totalUnlocked > t.claimed ? totalUnlocked - t.claimed : 0;
    }

    // ─── ERC721 Receiver (required to hold Uniswap V3 LP NFT) ───────
    // [I-04] Validate that the NFT comes from the NonfungiblePositionManager only
    function onERC721Received(address, address, uint256, bytes calldata)
        external view returns (bytes4)
    {
        require(msg.sender == address(positionManager), "only positionManager NFTs accepted");
        return this.onERC721Received.selector;
    }
}
