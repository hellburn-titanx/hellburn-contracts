// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/ITitanX.sol";
import "./HellBurnToken.sol";

/**
 * @title GenesisBurn
 * @notice 28-day genesis phase: users burn TitanX to mint HBURN.
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

    uint256 public constant WEEK1_BONUS = 115;
    uint256 public constant WEEK2_BONUS = 110;
    uint256 public constant WEEK3_BONUS = 105;
    uint256 public constant WEEK4_BONUS = 100;
    uint256 public constant BASIS = 100;

    // [M-03] Max supply cap — no more HBURN can be minted beyond this
    uint256 public constant MAX_HBURN_SUPPLY = 1_000_000_000_000 ether; // 1 trillion

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ─── Immutables ──────────────────────────────────────────────────
    ITitanX public immutable titanX;
    address public immutable dragonXVault;
    address public immutable treasury;
    address public immutable genesisAddress;
    HellBurnToken public immutable hburn;

    uint256 public immutable genesisStart;
    uint256 public immutable genesisEnd;

    // ─── State ───────────────────────────────────────────────────────
    uint256 public totalTitanXBurned;
    uint256 public totalHBURNMinted;
    bool public genesisEnded;

    // [H-01] Per-tranche vesting instead of single timestamp
    struct VestingTranche {
        uint256 amount;         // HBURN amount in this tranche
        uint256 vestingStart;   // when this tranche started vesting
        uint256 claimed;        // already claimed from this tranche
    }

    mapping(address => VestingTranche[]) public vestingTranches;

    // ─── Events ──────────────────────────────────────────────────────
    event GenesisBurnExecuted(
        address indexed user, uint256 titanXAmount, uint256 hburnMinted,
        uint256 immediateAmount, uint256 vestedAmount, uint256 week
    );
    event VestingClaimed(address indexed user, uint256 amount);
    event GenesisPhaseEnded(uint256 totalBurned, uint256 totalMinted);

    // ─── Errors ──────────────────────────────────────────────────────
    error GenesisNotStarted();
    error GenesisAlreadyEnded();
    error GenesisNotYetEnded();  // [L-04] Renamed for clarity
    error ZeroAmount();
    error NothingToClaim();
    error TransferFailed();
    error MaxSupplyExceeded();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(
        address _titanX,
        address _dragonXVault,
        address _treasury,
        address _genesisAddress,
        address _hburn
    ) {
        // [L-01] Zero-address checks
        require(_titanX != address(0) && _dragonXVault != address(0), "zero addr");
        require(_treasury != address(0) && _genesisAddress != address(0), "zero addr");
        require(_hburn != address(0), "zero addr");

        titanX = ITitanX(_titanX);
        dragonXVault = _dragonXVault;
        treasury = _treasury;
        genesisAddress = _genesisAddress;
        hburn = HellBurnToken(_hburn);

        genesisStart = block.timestamp;
        genesisEnd = block.timestamp + GENESIS_DURATION;
    }

    // ─── Genesis Burn ────────────────────────────────────────────────
    function burn(uint256 titanXAmount) external nonReentrant {
        if (block.timestamp < genesisStart) revert GenesisNotStarted();
        if (block.timestamp > genesisEnd || genesisEnded) revert GenesisAlreadyEnded();
        if (titanXAmount == 0) revert ZeroAmount();

        // Transfer TitanX from user
        IERC20(address(titanX)).safeTransferFrom(msg.sender, address(this), titanXAmount);

        // Distribute TitanX
        _distributeTitanX(titanXAmount);

        // Calculate HBURN to mint
        (uint256 hburnAmount, uint256 week) = _calculateMintAmount(titanXAmount);

        // [M-03] Enforce max supply
        if (totalHBURNMinted + hburnAmount > MAX_HBURN_SUPPLY) revert MaxSupplyExceeded();

        // 25% immediate, 75% vested
        uint256 immediateAmount = (hburnAmount * IMMEDIATE_PERCENT) / 100;
        uint256 vestedAmount = hburnAmount - immediateAmount;

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
            immediateAmount, vestedAmount, week
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

    // ─── End Genesis ─────────────────────────────────────────────────
    function endGenesis() external {
        if (block.timestamp <= genesisEnd) revert GenesisNotYetEnded();
        if (genesisEnded) revert GenesisAlreadyEnded();

        genesisEnded = true;
        hburn.endGenesisMinting();

        emit GenesisPhaseEnded(totalTitanXBurned, totalHBURNMinted);
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

    // ─── Internal ────────────────────────────────────────────────────
    function _distributeTitanX(uint256 amount) internal {
        uint256 burnAmount = (amount * BURN_PERCENT) / 100;
        uint256 dragonAmount = (amount * DRAGONX_PERCENT) / 100;
        uint256 treasuryAmount = (amount * TREASURY_PERCENT) / 100;
        uint256 genesisAmount = amount - burnAmount - dragonAmount - treasuryAmount;

        IERC20 titan = IERC20(address(titanX));
        titan.safeTransfer(DEAD_ADDRESS, burnAmount);
        titan.safeTransfer(dragonXVault, dragonAmount);
        titan.safeTransfer(treasury, treasuryAmount);
        titan.safeTransfer(genesisAddress, genesisAmount);
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

    // [H-01] Per-tranche claimable calculation
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
}
