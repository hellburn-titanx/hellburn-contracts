// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/ISwapRouter.sol";

/**
 * @title BuyAndBurn
 * @notice Receives ETH, buys HBURN on Uniswap V3, and permanently burns it.
 *         Callable by anyone (public good).
 *
 * AUDIT FIXES v2:
 *   [C-02] Removed zero-slippage function. All swaps require minHBURNOut.
 *   [L-01] Zero-address checks in constructor.
 */
contract BuyAndBurn is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ───────────────────────────────────────────────────
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint24 public constant POOL_FEE = 10000;  // 1% fee tier
    uint256 public constant MIN_BUY_AMOUNT = 0.001 ether;

    // ─── Immutables ──────────────────────────────────────────────────
    ISwapRouter public immutable swapRouter;
    IWETH public immutable weth;
    IERC20 public immutable hburn;

    // ─── State ───────────────────────────────────────────────────────
    uint256 public totalETHUsed;
    uint256 public totalHBURNBurned;

    // ─── Events ──────────────────────────────────────────────────────
    event BuyAndBurnExecuted(
        address indexed caller,
        uint256 ethSpent,
        uint256 hburnBought,
        uint256 hburnBurned
    );

    // ─── Errors ──────────────────────────────────────────────────────
    error InsufficientBalance();
    error SwapFailed();
    error BelowMinimum();
    error ZeroSlippage();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _swapRouter, address _weth, address _hburn) {
        require(_swapRouter != address(0) && _weth != address(0) && _hburn != address(0), "zero addr");
        swapRouter = ISwapRouter(_swapRouter);
        weth = IWETH(_weth);
        hburn = IERC20(_hburn);
    }

    // ─── Receive ETH ─────────────────────────────────────────────────
    receive() external payable {}

    // ─── Buy & Burn ──────────────────────────────────────────────────
    /**
     * @notice Buy HBURN with all available ETH and burn it.
     *         Caller MUST provide a minimum output to prevent sandwich attacks.
     *         Use a frontend with TWAP oracle or off-chain quote for minHBURNOut.
     * @param minHBURNOut Minimum HBURN to receive (MEV protection, MUST be > 0)
     */
    function executeBuyAndBurn(uint256 minHBURNOut) external nonReentrant {
        // [C-02] Enforce non-zero slippage protection
        if (minHBURNOut == 0) revert ZeroSlippage();

        uint256 ethBalance = address(this).balance;
        if (ethBalance < MIN_BUY_AMOUNT) revert BelowMinimum();

        // Wrap ETH to WETH
        weth.deposit{value: ethBalance}();
        IERC20(address(weth)).forceApprove(address(swapRouter), ethBalance);

        // Swap WETH → HBURN via Uniswap V3
        uint256 hburnBought = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(hburn),
                fee: POOL_FEE,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: ethBalance,
                amountOutMinimum: minHBURNOut,
                sqrtPriceLimitX96: 0
            })
        );

        // Burn all bought HBURN
        uint256 burnAmount = hburn.balanceOf(address(this));
        hburn.safeTransfer(DEAD_ADDRESS, burnAmount);

        totalETHUsed += ethBalance;
        totalHBURNBurned += burnAmount;

        emit BuyAndBurnExecuted(msg.sender, ethBalance, hburnBought, burnAmount);
    }

    // ─── Views ───────────────────────────────────────────────────────
    function pendingETH() external view returns (uint256) {
        return address(this).balance;
    }
}
