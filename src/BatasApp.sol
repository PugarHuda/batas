// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { AquaApp } from "@1inch/aqua/src/AquaApp.sol";

import { Mandate, MandateLib } from "./Mandate.sol";
import { IBatasCallback } from "./IBatasCallback.sol";

/// @title BatasApp
/// @notice A constant-product Aqua application whose every swap must satisfy the maker's mandate.
/// @dev Same `Mandate` type the router's program is compiled from, and the same pricing library,
///   so this is a second surface over one system rather than a parallel implementation.
/// @dev Aqua's security model is a single sentence: whichever app the maker ships to may pull
///   their tokens, and `Aqua.pull()` checks nothing beyond `msg.sender`. This contract is
///   therefore not merely a strategy — it is the only thing standing between an autonomous
///   agent and the maker's wallet. Every limit is checked here, before `pull()`, because after
///   `pull()` the tokens have already left.
contract BatasApp is AquaApp {
    using Math for uint256;
    using MandateLib for Mandate;

    error MandateExpired(uint64 expiry, uint256 nowTs);
    error MandateAmountInExceeded(uint256 amountIn, uint128 maxAmountIn);
    error MandateRateTooLow(uint256 amountOut, uint256 amountIn, uint128 minRateE18);
    error InsufficientOutputAmount(uint256 amountOut, uint256 amountOutMin);
    error ZeroAmountIn();

    event MandateEnforced(
        bytes32 indexed mandateHash, address indexed maker, address indexed taker, uint256 amountIn, uint256 amountOut
    );

    uint256 private constant _E18 = 1e18;

    constructor(IAqua aqua_) AquaApp(aqua_) { }

    /// @notice Price a swap without executing it. Reverts for exactly the reasons a real swap would,
    ///   so an agent can tell a rejected trade from a bad price before spending gas.
    function quote(Mandate calldata m, uint256 amountIn) external view returns (uint256 amountOut) {
        bytes32 mandateHash = m.hash();
        (uint256 balanceIn, uint256 balanceOut) =
            AQUA.safeBalances(m.maker, address(this), mandateHash, m.tokenIn, m.tokenOut);
        amountOut = _quote(m, balanceIn, balanceOut, amountIn);
        _checkMandate(m, amountIn, amountOut);
    }

    /// @notice Swap against a mandated position. Output leaves first; the callback must return the
    ///   input before the function ends, exactly as Aqua's own examples do.
    function swap(Mandate calldata m, uint256 amountIn, uint256 amountOutMin, address to, bytes calldata takerData)
        external
        nonReentrantStrategy(m.maker, MandateLib.hash(m))
        returns (uint256 amountOut)
    {
        bytes32 mandateHash = m.hash();

        (uint256 balanceIn, uint256 balanceOut) =
            AQUA.safeBalances(m.maker, address(this), mandateHash, m.tokenIn, m.tokenOut);

        amountOut = _quote(m, balanceIn, balanceOut, amountIn);
        _checkMandate(m, amountIn, amountOut);
        require(amountOut >= amountOutMin, InsufficientOutputAmount(amountOut, amountOutMin));

        AQUA.pull(m.maker, mandateHash, m.tokenOut, amountOut, to);
        IBatasCallback(msg.sender).batasSwapCallback(
            m.tokenIn, m.tokenOut, amountIn, amountOut, m.maker, mandateHash, takerData
        );
        _safeCheckAquaPush(m.maker, mandateHash, m.tokenIn, balanceIn + amountIn);

        emit MandateEnforced(mandateHash, m.maker, msg.sender, amountIn, amountOut);
    }

    /// @dev Pricing lives in MandateLib, shared with the compiled SwapVM program, so the two
    ///   enforcement surfaces cannot drift apart. Constant product after a maker fee, rounding
    ///   toward the maker at every step.
    function _quote(Mandate calldata m, uint256 balanceIn, uint256 balanceOut, uint256 amountIn)
        internal
        pure
        returns (uint256 amountOut)
    {
        amountOut = MandateLib.quoteExactIn(m, balanceIn, balanceOut, amountIn);
    }

    /// @dev The mandate itself. Ordered cheapest check first.
    function _checkMandate(Mandate calldata m, uint256 amountIn, uint256 amountOut) internal view {
        require(amountIn != 0, ZeroAmountIn());
        require(block.timestamp < m.expiry, MandateExpired(m.expiry, block.timestamp));
        require(amountIn <= m.maxAmountIn, MandateAmountInExceeded(amountIn, m.maxAmountIn));

        // Cross-multiplied so no division is needed: amountOut / amountIn >= minRateE18 / 1e18.
        // ponytail: amountOut * 1e18 only overflows past ~1.1e59 tokens, far beyond any real supply.
        require(
            amountOut * _E18 >= amountIn * m.minRateE18, MandateRateTooLow(amountOut, amountIn, m.minRateE18)
        );
    }
}
