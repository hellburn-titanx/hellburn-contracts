// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockTitanX
 * @notice Mock TitanX with staking functions for testing treasury auto-stake.
 */
contract MockTitanX is ERC20 {
    struct StakeRecord {
        uint256 amount;
        uint256 numOfDays;
        address staker;
    }

    StakeRecord[] public stakes;
    uint256 public pendingETHPayout; // Pre-fund this for testing claimUserAvailableETHPayouts

    constructor() ERC20("TitanX", "TITANX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function startStake(uint256 amount, uint256 numOfDays) external {
        // Transfer tokens from caller (like real TitanX does)
        _transfer(msg.sender, address(this), amount);
        stakes.push(StakeRecord(amount, numOfDays, msg.sender));
    }

    function endStake(uint256 /* id */) external {
        // No-op in mock
    }

    function claimUserAvailableETHPayouts() external {
        uint256 payout = pendingETHPayout;
        if (payout > 0) {
            pendingETHPayout = 0;
            (bool sent,) = msg.sender.call{value: payout}("");
            require(sent, "ETH transfer failed");
        }
    }

    // ─── Test Helpers ────────────────────────────────────────────────
    function fundETHPayout() external payable {
        pendingETHPayout += msg.value;
    }

    function getStakeCount() external view returns (uint256) {
        return stakes.length;
    }

    function getStake(uint256 idx) external view returns (uint256 amount, uint256 numOfDays, address staker) {
        StakeRecord memory s = stakes[idx];
        return (s.amount, s.numOfDays, s.staker);
    }

    // Needed so the mock can receive ETH
    receive() external payable {}

    // Dummy functions from ITitanX interface
    function getCurrentContractDay() external pure returns (uint256) { return 1; }
    function getCurrentMintCost() external pure returns (uint256) { return 0; }
}
