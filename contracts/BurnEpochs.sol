// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/ITitanX.sol";

/**
 * @title BurnEpochs
 * @notice Competitive 8-day burn epochs with streak multiplier system.
 *
 * AUDIT FIXES v2:
 *   [C-01] Per-epoch ETH tracking instead of address(this).balance
 *   [H-02] Underflow guard on epochId == 0
 *   [M-02] Emergency pause (deposits only, not withdrawals)
 *   [M-04] SafeERC20 for DragonX transfers
 *   [M-05] Orphaned ETH rolls over to next epoch
 */
contract BurnEpochs is ReentrancyGuard, Pausable {

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant EPOCH_DURATION = 8 days;
    uint256 public constant STREAK_INCREMENT = 2;
    uint256 public constant MAX_STREAK_MULT = 30;
    uint256 public constant STREAK_BASIS = 10;
    uint256 public constant DRAGONX_WEIGHT = 2;
    uint256 public constant TITANX_WEIGHT = 1;

    uint256 public constant REWARDS_PERCENT = 80;
    uint256 public constant BUYBURN_PERCENT = 20;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ─── Immutables ──────────────────────────────────────────────────
    ITitanX public immutable titanX;
    address public immutable dragonX;
    address public immutable buyAndBurn;
    address public immutable treasury;
    address public immutable guardian;

    uint256 public immutable firstEpochStart;

    // ─── Epoch State ─────────────────────────────────────────────────
    struct Epoch {
        uint256 totalWeightedBurns;
        uint256 ethRewards;
        uint256 ethDeposited;       // [C-01] ETH received DURING this epoch
        bool finalized;
        mapping(address => uint256) userWeightedBurns;
        mapping(address => bool) claimed;
    }

    mapping(uint256 => Epoch) public epochs;

    // [C-01] Unallocated ETH from epochs with 0 burns
    uint256 public carryOverETH;

    // ─── User State ──────────────────────────────────────────────────
    struct UserStreak {
        uint256 lastParticipatedEpoch;
        uint256 streakCount;
    }

    mapping(address => UserStreak) public userStreaks;

    // ─── Global Stats ────────────────────────────────────────────────
    uint256 public totalTitanXBurned;
    uint256 public totalDragonXBurned;
    uint256 public totalETHDistributed;

    // ─── Events ──────────────────────────────────────────────────────
    event BurnedInEpoch(
        address indexed user, uint256 indexed epochId, address token,
        uint256 amount, uint256 weightedAmount, uint256 streakMultiplier
    );
    event EpochFinalized(uint256 indexed epochId, uint256 ethRewards, uint256 totalWeightedBurns);
    event RewardsClaimed(address indexed user, uint256 indexed epochId, uint256 ethAmount);
    event StreakReset(address indexed user, uint256 previousStreak);
    event ETHReceived(uint256 indexed epochId, uint256 amount);
    event OrphanedETHCarriedOver(uint256 indexed epochId, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────
    error EpochNotActive();
    error EpochNotEnded();
    error EpochNotFinalized();
    error AlreadyClaimed();
    error ZeroAmount();
    error NoBurnsInEpoch();
    error TransferFailed();
    error OnlyGuardian();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(
        address _titanX,
        address _dragonX,
        address _buyAndBurn,
        address _treasury,
        uint256 _firstEpochStart,
        address _guardian
    ) {
        require(_titanX != address(0) && _dragonX != address(0), "zero addr");
        require(_buyAndBurn != address(0) && _treasury != address(0), "zero addr");
        require(_guardian != address(0), "zero addr");

        titanX = ITitanX(_titanX);
        dragonX = _dragonX;
        buyAndBurn = _buyAndBurn;
        treasury = _treasury;
        guardian = _guardian;
        firstEpochStart = _firstEpochStart;
    }

    // ─── Receive ETH ─────────────────────────────────────────────────
    receive() external payable {
        _recordETHDeposit(msg.value);
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

    // ─── Core: Burn ──────────────────────────────────────────────────
    function burnTitanX(uint256 amount) external nonReentrant whenNotPaused {
        _burn(address(titanX), amount, TITANX_WEIGHT);
    }

    function burnDragonX(uint256 amount) external nonReentrant whenNotPaused {
        _burn(dragonX, amount, DRAGONX_WEIGHT);
    }

    // ─── Core: Finalize Epoch ────────────────────────────────────────
    function finalizeEpoch(uint256 epochId) external nonReentrant {
        Epoch storage epoch = epochs[epochId];
        if (epoch.finalized) return;
        if (!_isEpochEnded(epochId)) revert EpochNotEnded();

        // [C-01] Use per-epoch tracked ETH + carry-over
        uint256 epochETH = epoch.ethDeposited + carryOverETH;
        carryOverETH = 0;

        // [SLITHER-FIX] CEI pattern: set finalized BEFORE external calls
        epoch.finalized = true;

        if (epochETH > 0 && epoch.totalWeightedBurns > 0) {
            uint256 rewardsForEpoch = (epochETH * REWARDS_PERCENT) / 100;
            uint256 buyBurnAmount = epochETH - rewardsForEpoch;

            epoch.ethRewards = rewardsForEpoch;
            totalETHDistributed += epoch.ethRewards;

            // External call AFTER all state changes
            if (buyBurnAmount > 0) {
                (bool sent,) = buyAndBurn.call{value: buyBurnAmount}("");
                if (!sent) revert TransferFailed();
            }
        } else if (epochETH > 0) {
            // [M-05] No burners → carry ETH to next epoch
            carryOverETH = epochETH;
            emit OrphanedETHCarriedOver(epochId, epochETH);
        }

        emit EpochFinalized(epochId, epoch.ethRewards, epoch.totalWeightedBurns);
    }

    // ─── Core: Claim (NOT pausable — users can always withdraw) ─────
    function claimRewards(uint256 epochId) external nonReentrant {
        Epoch storage epoch = epochs[epochId];
        if (!epoch.finalized) revert EpochNotFinalized();
        if (epoch.claimed[msg.sender]) revert AlreadyClaimed();
        if (epoch.userWeightedBurns[msg.sender] == 0) revert NoBurnsInEpoch();

        uint256 userShare = (epoch.ethRewards * epoch.userWeightedBurns[msg.sender])
                            / epoch.totalWeightedBurns;

        epoch.claimed[msg.sender] = true;

        if (userShare > 0) {
            (bool sent,) = msg.sender.call{value: userShare}("");
            if (!sent) revert TransferFailed();
        }

        emit RewardsClaimed(msg.sender, epochId, userShare);
    }

    function batchClaimRewards(uint256[] calldata epochIds) external nonReentrant {
        uint256 totalReward = 0;

        for (uint256 i = 0; i < epochIds.length; i++) {
            Epoch storage epoch = epochs[epochIds[i]];
            if (!epoch.finalized) continue;
            if (epoch.claimed[msg.sender]) continue;
            if (epoch.userWeightedBurns[msg.sender] == 0) continue;

            uint256 userShare = (epoch.ethRewards * epoch.userWeightedBurns[msg.sender])
                                / epoch.totalWeightedBurns;

            epoch.claimed[msg.sender] = true;
            totalReward += userShare;

            emit RewardsClaimed(msg.sender, epochIds[i], userShare);
        }

        if (totalReward > 0) {
            (bool sent,) = msg.sender.call{value: totalReward}("");
            if (!sent) revert TransferFailed();
        }
    }

    // ─── Views ───────────────────────────────────────────────────────
    function currentEpochId() public view returns (uint256) {
        if (block.timestamp < firstEpochStart) return 0;
        return (block.timestamp - firstEpochStart) / EPOCH_DURATION;
    }

    function epochStartTime(uint256 epochId) public view returns (uint256) {
        return firstEpochStart + (epochId * EPOCH_DURATION);
    }

    function epochEndTime(uint256 epochId) public view returns (uint256) {
        return epochStartTime(epochId) + EPOCH_DURATION;
    }

    function isEpochActive(uint256 epochId) public view returns (bool) {
        return epochId == currentEpochId() && block.timestamp >= firstEpochStart;
    }

    function getUserStreakMultiplier(address user) public view returns (uint256) {
        return _getStreakMultiplier(user);
    }

    function getUserEpochBurn(uint256 epochId, address user) external view returns (uint256) {
        return epochs[epochId].userWeightedBurns[user];
    }

    function getEpochTotalBurns(uint256 epochId) external view returns (uint256) {
        return epochs[epochId].totalWeightedBurns;
    }

    function getEpochRewards(uint256 epochId) external view returns (uint256) {
        return epochs[epochId].ethRewards;
    }

    function getEpochDeposited(uint256 epochId) external view returns (uint256) {
        return epochs[epochId].ethDeposited;
    }

    function hasClaimedEpoch(uint256 epochId, address user) external view returns (bool) {
        return epochs[epochId].claimed[user];
    }

    function pendingReward(uint256 epochId, address user) external view returns (uint256) {
        Epoch storage epoch = epochs[epochId];
        if (!epoch.finalized || epoch.claimed[user] || epoch.totalWeightedBurns == 0) return 0;
        return (epoch.ethRewards * epoch.userWeightedBurns[user]) / epoch.totalWeightedBurns;
    }

    // ─── Internal ────────────────────────────────────────────────────
    function _recordETHDeposit(uint256 amount) internal {
        if (amount == 0) return;
        uint256 epochId = currentEpochId();
        epochs[epochId].ethDeposited += amount;
        emit ETHReceived(epochId, amount);
    }

    function _burn(address token, uint256 amount, uint256 weight) internal {
        if (amount == 0) revert ZeroAmount();

        uint256 epochId = currentEpochId();
        if (block.timestamp < firstEpochStart) revert EpochNotActive();

        if (token == address(titanX)) {
            bool success = titanX.transferFrom(msg.sender, DEAD_ADDRESS, amount);
            if (!success) revert TransferFailed();
            totalTitanXBurned += amount;
        } else {
            _safeTransferFrom(token, msg.sender, DEAD_ADDRESS, amount);
            totalDragonXBurned += amount;
        }

        _updateStreak(msg.sender, epochId);

        uint256 streakMult = _getStreakMultiplier(msg.sender);
        uint256 weightedBurn = (amount * weight * streakMult) / STREAK_BASIS;

        Epoch storage epoch = epochs[epochId];
        epoch.userWeightedBurns[msg.sender] += weightedBurn;
        epoch.totalWeightedBurns += weightedBurn;

        emit BurnedInEpoch(msg.sender, epochId, token, amount, weightedBurn, streakMult);
    }

    // [H-02] Safe streak update with underflow guard
    function _updateStreak(address user, uint256 epochId) internal {
        UserStreak storage streak = userStreaks[user];

        // Only skip if user has actually participated before (streakCount > 0)
        // and already participated in this epoch
        if (streak.streakCount > 0 && streak.lastParticipatedEpoch == epochId) return;

        if (streak.streakCount > 0 && streak.lastParticipatedEpoch == epochId - 1) {
            streak.streakCount++;
        } else if (streak.streakCount > 0) {
            emit StreakReset(user, streak.streakCount);
            streak.streakCount = 1;
        } else {
            streak.streakCount = 1;
        }

        streak.lastParticipatedEpoch = epochId;
    }

    function _getStreakMultiplier(address user) internal view returns (uint256) {
        uint256 count = userStreaks[user].streakCount;
        uint256 mult = STREAK_BASIS + (count * STREAK_INCREMENT);
        return mult > MAX_STREAK_MULT ? MAX_STREAK_MULT : mult;
    }

    function _isEpochEnded(uint256 epochId) internal view returns (bool) {
        return block.timestamp >= epochEndTime(epochId);
    }

    // [M-04] Safe transferFrom for non-standard ERC-20
    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(bytes4(keccak256("transferFrom(address,address,uint256)")), from, to, amount)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }
}
