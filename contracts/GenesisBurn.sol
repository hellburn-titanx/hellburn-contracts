// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/ITitanX.sol";
import "./interfaces/ISwapRouter.sol";
import "./interfaces/INonfungiblePositionManager.sol";
import "./HellBurnToken.sol";

/**
 * @title GenesisBurn (Fair Launch Edition)
 * @notice 28-day genesis phase: users burn TitanX to mint HBURN.
 *
 * FAIR LAUNCH MECHANISM:
 *   - 3% of all minted HBURN goes to an LP reserve (held by this contract)
 *   - 8% of incoming TitanX (Genesis Fund) is accumulated in this contract
 *   - At endGenesis(), the contract:
 *     1. Swaps accumulated TitanX → WETH via Uniswap V3
 *     2. Creates a full-range HBURN/WETH Uniswap V3 LP position
 *     3. LP-NFT is permanently locked in this contract (no admin access)
 *   - The initial HBURN price is determined automatically:
 *     price = WETH_received / LP_HBURN_reserve
 *   - No insider tokens, no pre-mine, fully trustless
 *
 * AUDIT FIXES v2:
 *   [H-01] Per-tranche vesting — each burn starts its own 28-day vest
 *   [M-03] Max supply cap enforced
 *   [L-01] Zero-address checks
 *   [L-04] Corrected error semantics
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

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // Uniswap V3 constants
    uint24 public constant POOL_FEE = 10000; // 1% fee tier
    // Full-range ticks for 1% fee tier (tickSpacing = 200)
    int24 public constant MIN_TICK = -887200;
    int24 public constant MAX_TICK = 887200;

    // ─── Immutables ──────────────────────────────────────────────────
    ITitanX public immutable titanX;
    address public immutable dragonXVault;
    address public immutable treasury;
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

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(
        address _titanX,
        address _dragonXVault,
        address _treasury,
        address _hburn,
        address _swapRouter,
        address _positionManager,
        address _weth,
        uint24 _titanXWethPoolFee
    ) {
        require(_titanX != address(0) && _dragonXVault != address(0), "zero addr");
        require(_treasury != address(0) && _hburn != address(0), "zero addr");
        require(_swapRouter != address(0) && _positionManager != address(0), "zero addr");
        require(_weth != address(0), "zero addr");

        titanX = ITitanX(_titanX);
        dragonXVault = _dragonXVault;
        treasury = _treasury;
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

        // Mint LP reserve to this contract
        hburn.mint(address(this), lpAmount);
        lpReserveHBURN += lpAmount;

        // Mint immediate portion to user
        hburn.mint(msg.sender, immediateAmount);

        // Mint vested portion to this contract
        hburn.mint(address(this), vestedAmount);

        // [H-01] Record as separate vesting tranche
        vestingTranches[msg.sender].push(VestingTranche({
            amount: vestedAmount,
            vestingStart: block.timestamp,
            claimed: 0
        }));

        totalTitanXBurned += titanXAmount;
        totalHBURNMinted += hburnAmount;

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
     * @param minWETHOut Minimum WETH from TitanX swap (MEV protection).
     *                   Frontend should use a quote or TWAP for this value.
     */
    function endGenesis(uint256 minWETHOut) external nonReentrant {
        if (block.timestamp <= genesisEnd) revert GenesisNotYetEnded();
        if (genesisEnded) revert GenesisAlreadyEnded();

        genesisEnded = true;
        hburn.endGenesisMinting();

        emit GenesisPhaseEnded(totalTitanXBurned, totalHBURNMinted);

        // If nobody participated, skip LP creation
        if (genesisFundTitanX == 0 || lpReserveHBURN == 0) return;

        _createLiquidityPool(minWETHOut);
    }

    // ─── Collect LP Fees (Public Good) ───────────────────────────────
    /**
     * @notice Collects trading fees from the LP position.
     *         HBURN fees → burned (dead address).
     *         WETH fees → sent to BuyAndBurn contract as ETH.
     *         Callable by anyone. No admin access to funds.
     *
     * @param buyAndBurn Address of BuyAndBurn contract to receive WETH fees
     */
    function collectLPFees(address buyAndBurn) external nonReentrant {
        if (!lpCreated) revert LPNotCreated();
        require(buyAndBurn != address(0), "zero addr");

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

        // Burn HBURN fees
        if (hburnFees > 0) {
            IERC20(address(hburn)).safeTransfer(DEAD_ADDRESS, hburnFees);
        }

        // Send WETH fees → ETH → BuyAndBurn
        if (wethFees > 0) {
            weth.withdraw(wethFees);
            (bool sent,) = buyAndBurn.call{value: wethFees}("");
            if (!sent) revert TransferFailed();
        }

        emit LPFeesCollected(hburnFees, wethFees);
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
        // 22% treasury (3500-day stake)
        titan.safeTransfer(treasury, treasuryAmount);

        // 8% Genesis Fund — stays in this contract for LP creation
        genesisFundTitanX += genesisAmount;
    }

    function _createLiquidityPool(uint256 minWETHOut) internal {
        // ── Step 1: Swap Genesis Fund TitanX → WETH ──────────────────
        uint256 titanXBalance = genesisFundTitanX;
        IERC20(address(titanX)).forceApprove(address(swapRouter), titanXBalance);

        uint256 wethReceived = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(titanX),
                tokenOut: address(weth),
                fee: titanXWethPoolFee,
                recipient: address(this),
                deadline: block.timestamp + 300,
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
                deadline: block.timestamp + 300
            })
        );

        lpTokenId = tokenId;
        lpCreated = true;

        emit LiquidityPoolCreated(tokenId, hburnForLP, wethReceived, liquidity);
    }

    /**
     * @dev Calculates sqrtPriceX96 = sqrt(amount1/amount0) * 2^96
     *      Uses a simplified integer sqrt approach safe for on-chain use.
     *      amount0 = token0 reserve, amount1 = token1 reserve
     */
    function _calculateSqrtPriceX96(uint256 amount0, uint256 amount1)
        internal pure returns (uint160)
    {
        // price = amount1 / amount0
        // sqrtPrice = sqrt(amount1 / amount0) = sqrt(amount1) / sqrt(amount0)
        // sqrtPriceX96 = sqrtPrice * 2^96

        // To maintain precision: sqrt(amount1 * 2^192 / amount0)
        // = sqrt(amount1 * 2^192) / sqrt(amount0)
        // But this overflows for large numbers, so we use:
        // sqrtPriceX96 = sqrt(amount1) * 2^96 / sqrt(amount0)

        uint256 sqrtAmount1 = _sqrt(amount1);
        uint256 sqrtAmount0 = _sqrt(amount0);

        require(sqrtAmount0 > 0, "zero amount0");

        // Multiply by 2^96 before dividing to maintain precision
        return uint160((sqrtAmount1 * (1 << 96)) / sqrtAmount0);
    }

    /// @dev Babylonian square root
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
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
    function onERC721Received(address, address, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return this.onERC721Received.selector;
    }
}
