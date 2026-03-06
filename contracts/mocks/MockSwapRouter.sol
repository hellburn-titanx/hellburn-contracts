// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/ISwapRouter.sol";

/**
 * @title MockWETH
 * @notice Simplified WETH mock for testing.
 */
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool sent,) = msg.sender.call{value: amount}("");
        require(sent, "ETH transfer failed");
    }

    /// @notice Test helper: mint WETH without ETH backing
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

/**
 * @title MockSwapRouter
 * @notice Simulates Uniswap V3 swaps for testing.
 *         Supports two swap directions:
 *         - WETH → HBURN (for BuyAndBurn): mints HBURN at 1:1000 rate
 *         - TitanX → WETH (for GenesisBurn Fair Launch): transfers pre-funded WETH at configurable rate
 *
 *         For TitanX→WETH: pre-fund this contract with WETH via MockWETH.mint()
 */
contract MockSwapRouter {
    uint256 public constant HBURN_RATE = 1000;    // 1 WETH = 1000 HBURN
    uint256 public titanXToWethRate = 100000;      // 100000 TitanX = 1 WETH (configurable)

    address public weth;

    constructor(address _weth) {
        weth = _weth;
    }

    /// @notice Set the TitanX→WETH exchange rate for testing
    function setTitanXRate(uint256 _rate) external {
        titanXToWethRate = _rate;
    }

    function exactInputSingle(
        ISwapRouter.ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        // Pull tokenIn from caller
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);

        if (params.tokenOut == weth) {
            // TitanX → WETH direction (for GenesisBurn)
            amountOut = params.amountIn / titanXToWethRate;
            require(amountOut >= params.amountOutMinimum, "Slippage");

            // Transfer WETH from our balance (must be pre-funded)
            require(IERC20(weth).balanceOf(address(this)) >= amountOut, "MockRouter: insufficient WETH");
            IERC20(weth).transfer(params.recipient, amountOut);
        } else {
            // WETH → HBURN direction (for BuyAndBurn)
            amountOut = params.amountIn * HBURN_RATE;
            require(amountOut >= params.amountOutMinimum, "Slippage");

            // Mint HBURN to recipient
            MockMintable(params.tokenOut).mint(params.recipient, amountOut);
        }
    }
}

interface MockMintable {
    function mint(address to, uint256 amount) external;
}
