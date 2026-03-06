// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/INonfungiblePositionManager.sol";

/**
 * @title MockNonfungiblePositionManager
 * @notice Simulates Uniswap V3 NonfungiblePositionManager for testing.
 *         Accepts tokens, returns a fake tokenId, tracks positions.
 */
contract MockNonfungiblePositionManager {
    uint256 public nextTokenId = 1;

    struct Position {
        address token0;
        address token1;
        uint256 amount0;
        uint256 amount1;
        address owner;
    }

    mapping(uint256 => Position) public positions;

    // Accumulated fees (can be set by test)
    mapping(uint256 => uint256) public fees0;
    mapping(uint256 => uint256) public fees1;

    bool public poolInitialized;
    uint160 public initialSqrtPrice;

    event PoolCreated(address token0, address token1, uint24 fee, uint160 sqrtPriceX96);
    event PositionMinted(uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool) {
        poolInitialized = true;
        initialSqrtPrice = sqrtPriceX96;
        emit PoolCreated(token0, token1, fee, sqrtPriceX96);
        // Return a fake pool address
        return address(uint160(uint256(keccak256(abi.encodePacked(token0, token1, fee)))));
    }

    function mint(INonfungiblePositionManager.MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        // Pull tokens from caller
        IERC20(params.token0).transferFrom(msg.sender, address(this), params.amount0Desired);
        IERC20(params.token1).transferFrom(msg.sender, address(this), params.amount1Desired);

        tokenId = nextTokenId++;
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;

        // Fake liquidity = sqrt(amount0 * amount1) simplified
        liquidity = uint128(amount0 > amount1 ? amount1 : amount0);

        positions[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            amount0: amount0,
            amount1: amount1,
            owner: params.recipient
        });

        emit PositionMinted(tokenId, liquidity, amount0, amount1);

        // Send ERC721-like callback to recipient if it's a contract
        if (params.recipient.code.length > 0) {
            (bool ok,) = params.recipient.call(
                abi.encodeWithSignature(
                    "onERC721Received(address,address,uint256,bytes)",
                    msg.sender, address(0), tokenId, ""
                )
            );
            require(ok, "ERC721 callback failed");
        }
    }

    function collect(INonfungiblePositionManager.CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        amount0 = fees0[params.tokenId];
        amount1 = fees1[params.tokenId];

        Position storage pos = positions[params.tokenId];

        if (amount0 > 0) {
            fees0[params.tokenId] = 0;
            IERC20(pos.token0).transfer(params.recipient, amount0);
        }
        if (amount1 > 0) {
            fees1[params.tokenId] = 0;
            IERC20(pos.token1).transfer(params.recipient, amount1);
        }
    }

    // ── Test Helpers ──────────────────────────────────────────────
    /// @notice Simulate accumulated trading fees for testing collectLPFees
    function setFees(uint256 tokenId, uint256 _fees0, uint256 _fees1) external {
        fees0[tokenId] = _fees0;
        fees1[tokenId] = _fees1;
    }
}
