// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ITitanX
 * @notice Minimal interface for interacting with the TitanX protocol
 * @dev TitanX mainnet: 0xf19308f923582a6f7c465e5ce7a9dc1bec6665b1
 */
interface ITitanX {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function totalSupply() external view returns (uint256);

    // TitanX staking
    function startStake(uint256 amount, uint256 numOfDays) external;
    function endStake(uint256 id) external;
    function claimUserAvailableETHPayouts() external;

    // TitanX protocol info
    function getCurrentContractDay() external view returns (uint256);
    function getCurrentMintCost() external view returns (uint256);
}
