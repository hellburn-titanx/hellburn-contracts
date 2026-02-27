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

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

/**
 * @title MockSwapRouter
 * @notice Simulates Uniswap V3 swap by minting tokenOut at a fixed 1:1000 rate.
 *         Used only for testing BuyAndBurn.
 */
contract MockSwapRouter {
    uint256 public constant RATE = 1000; // 1 WETH = 1000 HBURN

    address public hburnToken;

    constructor(address _hburn) {
        hburnToken = _hburn;
    }

    function exactInputSingle(
        ISwapRouter.ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        // Pull WETH from caller
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);

        // Calculate output (1 WETH = RATE HBURN)
        amountOut = params.amountIn * RATE;
        require(amountOut >= params.amountOutMinimum, "Slippage");

        // Mint HBURN to recipient (we need mintable mock)
        MockMintable(params.tokenOut).mint(params.recipient, amountOut);
    }
}

interface MockMintable {
    function mint(address to, uint256 amount) external;
}
