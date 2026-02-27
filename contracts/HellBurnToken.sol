// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title HellBurnToken (HBURN)
 * @notice ERC-20 token for the HellBurn protocol. Zero inflation after genesis.
 * @dev Minting is exclusively controlled by the Genesis contract and permanently
 *      disabled once the genesis phase ends. No admin keys, no owner functions.
 */
contract HellBurnToken is ERC20, ERC20Burnable, ReentrancyGuard {

    // ─── State ───────────────────────────────────────────────────────
    address public immutable genesisContract;
    address public immutable stakingContract;
    address public immutable buyAndBurnContract;

    bool public genesisMintingEnded;

    // ─── Errors ──────────────────────────────────────────────────────
    error OnlyGenesis();
    error MintingEnded();

    // ─── Events ──────────────────────────────────────────────────────
    event GenesisMintingPermanentlyEnded(uint256 totalSupply);

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(
        address _genesis,
        address _staking,
        address _buyBurn
    ) ERC20("HellBurn", "HBURN") {
        require(_genesis != address(0) && _staking != address(0) && _buyBurn != address(0), "zero addr");
        genesisContract = _genesis;
        stakingContract = _staking;
        buyAndBurnContract = _buyBurn;
    }

    // ─── Minting (Genesis Only) ──────────────────────────────────────
    function mint(address to, uint256 amount) external {
        if (msg.sender != genesisContract) revert OnlyGenesis();
        if (genesisMintingEnded) revert MintingEnded();
        _mint(to, amount);
    }

    function endGenesisMinting() external {
        if (msg.sender != genesisContract) revert OnlyGenesis();
        genesisMintingEnded = true;
        emit GenesisMintingPermanentlyEnded(totalSupply());
    }
}
