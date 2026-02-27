// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/ITitanX.sol";

/**
 * @title HellBurnStaking
 * @notice Stake HBURN to earn real ETH yield.
 *
 * AUDIT FIXES v2:
 *   [H-03] O(1) stake ownership via mapping instead of O(n) array search
 *   [H-04] Fuel recalculation preserves loyalty bonus
 *   [H-05] reStake requires prior completed stake
 *   [M-01] Penalty: 50% burned, 50% stays in contract as HBURN (benefits stakers via deflation)
 *   [M-02] Emergency pause (deposits only)
 *   [L-01] Zero-address checks
 */
contract HellBurnStaking is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant MIN_STAKE_DAYS = 28;
    uint256 public constant MAX_STAKE_DAYS = 3500;
    uint256 public constant GRACE_PERIOD = 7 days;
    uint256 public constant BASIS = 1000;

    uint256 public constant MAX_TIME_BONUS = 3500;
    uint256 public constant MAX_FUEL_BONUS = 1500;
    uint256 public constant FUEL_BASIS = 1000;
    uint256 public constant DRAGONX_FUEL_WEIGHT = 2;

    uint256 public constant LOYALTY_RESTAKE_BONUS = 1100;
    uint256 public constant PHOENIX_BONUS = 1050;
    uint256 public constant PHOENIX_THRESHOLD = 3;

    uint256 public constant PENALTY_BURN_PERCENT = 50;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ─── Immutables ──────────────────────────────────────────────────
    IERC20 public immutable hburn;
    ITitanX public immutable titanX;
    address public immutable dragonX;
    address public immutable guardian;

    // ─── Stake State ─────────────────────────────────────────────────
    struct Stake {
        address owner;           // [H-03] Direct owner reference
        uint256 amount;
        uint256 shares;
        uint256 startTime;
        uint256 endTime;
        uint256 fuelBonus;       // basis 1000
        uint256 loyaltyBonus;    // [H-04] Store loyalty bonus for fuel recalc
        bool active;
        bool isRestake;
    }

    uint256 public nextStakeId;
    mapping(uint256 => Stake) public stakes;
    mapping(address => uint256[]) public userStakeIds;

    // ─── Global Shares ───────────────────────────────────────────────
    uint256 public totalShares;

    // ─── Loyalty Tracking ────────────────────────────────────────────
    mapping(address => uint256) public consecutiveRestakes;
    mapping(address => bool) public hasPhoenixStatus;
    mapping(address => uint256) public completedStakes;  // [H-05] Track completed stakes

    // ─── ETH Rewards ─────────────────────────────────────────────────
    uint256 public totalETHReceived;
    uint256 public ethPerShare;
    mapping(uint256 => uint256) public stakeETHDebt;

    // ─── Events ──────────────────────────────────────────────────────
    event StakeStarted(
        address indexed user, uint256 indexed stakeId,
        uint256 amount, uint256 shares, uint256 duration, bool isRestake
    );
    event StakeEnded(
        address indexed user, uint256 indexed stakeId,
        uint256 amountReturned, uint256 ethReward, uint256 penalty
    );
    event FuelAdded(
        address indexed user, uint256 indexed stakeId,
        address token, uint256 amount, uint256 newFuelBonus
    );
    event PhoenixStatusGranted(address indexed user);
    event ETHRewardsReceived(uint256 amount);
    event PenaltyDistributed(uint256 burned, uint256 keptInContract);

    // ─── Errors ──────────────────────────────────────────────────────
    error InvalidDuration();
    error ZeroAmount();
    error StakeNotActive();
    error StakeNotMature();
    error NotStakeOwner();
    error FuelMaxReached();
    error TransferFailed();
    error NoPriorStake();
    error OnlyGuardian();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _hburn, address _titanX, address _dragonX, address _guardian) {
        require(_hburn != address(0) && _titanX != address(0), "zero addr");
        require(_dragonX != address(0) && _guardian != address(0), "zero addr");
        hburn = IERC20(_hburn);
        titanX = ITitanX(_titanX);
        dragonX = _dragonX;
        guardian = _guardian;
    }

    // ─── Receive ETH ────────────────────────────────────────────────
    receive() external payable {
        _distributeETH(msg.value);
    }

    function depositETH() external payable {
        _distributeETH(msg.value);
    }

    // ─── Emergency Pause [M-02] ──────────────────────────────────────
    function pause() external {
        if (msg.sender != guardian) revert OnlyGuardian();
        _pause();
    }

    function unpause() external {
        if (msg.sender != guardian) revert OnlyGuardian();
        _unpause();
    }

    // ─── Start Stake ─────────────────────────────────────────────────
    function startStake(uint256 amount, uint256 numDays) external nonReentrant whenNotPaused returns (uint256) {
        return _startStake(amount, numDays, false);
    }

    // [H-05] reStake requires at least one completed stake
    function reStake(uint256 amount, uint256 numDays) external nonReentrant whenNotPaused returns (uint256) {
        if (completedStakes[msg.sender] == 0) revert NoPriorStake();
        return _startStake(amount, numDays, true);
    }

    // ─── End Stake (NOT pausable) ────────────────────────────────────
    function endStake(uint256 stakeId) external nonReentrant {
        Stake storage s = stakes[stakeId];
        if (!s.active) revert StakeNotActive();
        if (s.owner != msg.sender) revert NotStakeOwner();  // [H-03] O(1) check

        s.active = false;

        // Calculate ETH rewards
        uint256 ethReward = _pendingETH(stakeId);
        totalShares -= s.shares;

        // Calculate penalty
        uint256 penalty = 0;
        uint256 amountReturned = s.amount;
        uint256 maturityPct = _maturityPercent(s);

        if (maturityPct < 50) {
            revert StakeNotMature();
        } else if (maturityPct < 100) {
            uint256 penaltyPct = (100 - maturityPct) * 2;
            penalty = (s.amount * penaltyPct) / 100;
            amountReturned = s.amount - penalty;

            if (penalty > 0) {
                // [M-01] 50% burned permanently, 50% stays in contract
                // (stays as HBURN backing — effectively benefits all holders)
                uint256 burnPortion = (penalty * PENALTY_BURN_PERCENT) / 100;
                uint256 keptPortion = penalty - burnPortion;

                hburn.safeTransfer(DEAD_ADDRESS, burnPortion);
                // keptPortion stays in contract — not transferred anywhere

                emit PenaltyDistributed(burnPortion, keptPortion);
            }
        }

        // [H-05] Track completed stakes for reStake validation
        completedStakes[msg.sender]++;

        // Return HBURN
        if (amountReturned > 0) {
            hburn.safeTransfer(msg.sender, amountReturned);
        }

        // Return ETH rewards
        if (ethReward > 0) {
            (bool sent,) = msg.sender.call{value: ethReward}("");
            if (!sent) revert TransferFailed();
        }

        emit StakeEnded(msg.sender, stakeId, amountReturned, ethReward, penalty);
    }

    // ─── Fuel Mechanic ───────────────────────────────────────────────
    function addFuelTitanX(uint256 stakeId, uint256 amount) external nonReentrant whenNotPaused {
        _addFuel(stakeId, address(titanX), amount, 1);
    }

    function addFuelDragonX(uint256 stakeId, uint256 amount) external nonReentrant whenNotPaused {
        _addFuel(stakeId, dragonX, amount, DRAGONX_FUEL_WEIGHT);
    }

    // ─── Views ───────────────────────────────────────────────────────
    function getUserStakes(address user) external view returns (uint256[] memory) {
        return userStakeIds[user];
    }

    function getStakeInfo(uint256 stakeId) external view returns (
        uint256 amount, uint256 shares, uint256 startTime,
        uint256 endTime, uint256 fuelBonus, bool active,
        uint256 maturityPct, uint256 pendingETH_
    ) {
        Stake storage s = stakes[stakeId];
        return (
            s.amount, s.shares, s.startTime, s.endTime,
            s.fuelBonus, s.active,
            _maturityPercent(s),
            s.active ? _pendingETH(stakeId) : 0
        );
    }

    function pendingETHReward(uint256 stakeId) external view returns (uint256) {
        return _pendingETH(stakeId);
    }

    function getTier(uint256 numDays) public pure returns (uint8) {
        if (numDays >= 3500) return 5; // Diamond
        if (numDays >= 888) return 4;  // Platinum
        if (numDays >= 369) return 3;  // Gold
        if (numDays >= 90) return 2;   // Silver
        return 1;                       // Bronze
    }

    // ─── Internal ────────────────────────────────────────────────────
    function _startStake(uint256 amount, uint256 numDays, bool isRestake)
        internal returns (uint256 stakeId)
    {
        if (amount == 0) revert ZeroAmount();
        if (numDays < MIN_STAKE_DAYS || numDays > MAX_STAKE_DAYS) revert InvalidDuration();

        hburn.safeTransferFrom(msg.sender, address(this), amount);

        uint256 timeBonus = _timeBonus(numDays);
        uint256 loyaltyBonus = _loyaltyBonus(msg.sender, isRestake);
        uint256 shares = (amount * timeBonus * loyaltyBonus) / (BASIS * BASIS);

        stakeId = nextStakeId++;
        stakes[stakeId] = Stake({
            owner: msg.sender,       // [H-03]
            amount: amount,
            shares: shares,
            startTime: block.timestamp,
            endTime: block.timestamp + (numDays * 1 days),
            fuelBonus: FUEL_BASIS,
            loyaltyBonus: loyaltyBonus,  // [H-04] Store for fuel recalc
            active: true,
            isRestake: isRestake
        });

        userStakeIds[msg.sender].push(stakeId);
        totalShares += shares;
        stakeETHDebt[stakeId] = ethPerShare;

        emit StakeStarted(msg.sender, stakeId, amount, shares, numDays, isRestake);
    }

    function _addFuel(uint256 stakeId, address token, uint256 amount, uint256 weight) internal {
        if (amount == 0) revert ZeroAmount();

        Stake storage s = stakes[stakeId];
        if (!s.active) revert StakeNotActive();
        if (s.owner != msg.sender) revert NotStakeOwner();  // [H-03]
        if (s.fuelBonus >= MAX_FUEL_BONUS) revert FuelMaxReached();

        // Burn the token
        if (token == address(titanX)) {
            bool success = titanX.transferFrom(msg.sender, DEAD_ADDRESS, amount);
            if (!success) revert TransferFailed();
        } else {
            _safeTransferFrom(token, msg.sender, DEAD_ADDRESS, amount);
        }

        // Calculate fuel increment
        uint256 fuelIncrement = (amount * weight) / 1e9;
        if (fuelIncrement == 0) fuelIncrement = 1;

        // Remove old shares, recalculate with new fuel
        totalShares -= s.shares;
        s.fuelBonus = s.fuelBonus + fuelIncrement;
        if (s.fuelBonus > MAX_FUEL_BONUS) s.fuelBonus = MAX_FUEL_BONUS;

        // [H-04] Recalculate shares including loyalty bonus
        uint256 numDays = (s.endTime - s.startTime) / 1 days;
        uint256 timeBonus = _timeBonus(numDays);
        s.shares = (s.amount * timeBonus * s.fuelBonus * s.loyaltyBonus) / (BASIS * FUEL_BASIS * BASIS);

        totalShares += s.shares;

        emit FuelAdded(msg.sender, stakeId, token, amount, s.fuelBonus);
    }

    function _distributeETH(uint256 amount) internal {
        if (totalShares > 0 && amount > 0) {
            ethPerShare += (amount * 1e18) / totalShares;
            totalETHReceived += amount;
            emit ETHRewardsReceived(amount);
        }
    }

    function _pendingETH(uint256 stakeId) internal view returns (uint256) {
        Stake storage s = stakes[stakeId];
        if (!s.active || totalShares == 0) return 0;
        return (s.shares * (ethPerShare - stakeETHDebt[stakeId])) / 1e18;
    }

    function _timeBonus(uint256 numDays) internal pure returns (uint256) {
        if (numDays <= MIN_STAKE_DAYS) return BASIS;
        uint256 bonus = BASIS + ((numDays - MIN_STAKE_DAYS) * (MAX_TIME_BONUS - BASIS)) / (MAX_STAKE_DAYS - MIN_STAKE_DAYS);
        return bonus > MAX_TIME_BONUS ? MAX_TIME_BONUS : bonus;
    }

    function _loyaltyBonus(address user, bool isRestake) internal returns (uint256) {
        if (!isRestake) {
            consecutiveRestakes[user] = 0;
            return BASIS;
        }

        consecutiveRestakes[user]++;

        if (consecutiveRestakes[user] >= PHOENIX_THRESHOLD && !hasPhoenixStatus[user]) {
            hasPhoenixStatus[user] = true;
            emit PhoenixStatusGranted(user);
        }

        uint256 bonus = LOYALTY_RESTAKE_BONUS;
        if (hasPhoenixStatus[user]) {
            bonus = (bonus * PHOENIX_BONUS) / BASIS;
        }

        return bonus;
    }

    function _maturityPercent(Stake storage s) internal view returns (uint256) {
        if (block.timestamp >= s.endTime + GRACE_PERIOD) return 110;
        if (block.timestamp >= s.endTime) return 100;
        uint256 totalDuration = s.endTime - s.startTime;
        uint256 elapsed = block.timestamp - s.startTime;
        return (elapsed * 100) / totalDuration;
    }

    // Safe transferFrom for non-standard ERC-20
    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(bytes4(keccak256("transferFrom(address,address,uint256)")), from, to, amount)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }
}
