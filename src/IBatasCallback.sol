// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Implemented by takers. Called after output tokens have been sent but before the
///   app verifies payment, so the taker can source the input however it likes.
interface IBatasCallback {
    function batasSwapCallback(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address maker,
        bytes32 mandateHash,
        bytes calldata takerData
    ) external;
}
