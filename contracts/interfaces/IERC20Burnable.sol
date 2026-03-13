// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface for ERC20Burnable tokens.
///         Used by BuyAndBurn, HellBurnStaking, and GenesisBurn
///         to call burn() so totalSupply decreases correctly.
interface IERC20Burnable {
    function burn(uint256 amount) external;
}
