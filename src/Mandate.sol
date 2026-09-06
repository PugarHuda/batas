// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { PolicyEnvelope } from "./PolicyEnvelope.sol";
import { Deadline, Salt } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { FeeFlatIn } from "@1inch/swap-vm/src/instructions/FeeFlat.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";

/// @notice A scoped, expiring grant of authority over a maker's liquidity.
/// @dev The encoded mandate *is* the Aqua strategy for `BatasApp`. `Aqua.ship()` hashes the
///   strategy bytes, so the mandate hash and the strategy hash are the same value: the terms are
///   the identity of the liquidity allocation, not metadata attached to it. Aqua rejects
///   re-shipping a hash it has already seen, which makes the terms immutable for the position.
struct Mandate {
    address maker;
    address agent;
    address tokenIn;
    address tokenOut;
    /// @dev Largest input the maker will settle in a single swap.
    uint128 maxAmountIn;
    /// @dev Floor price: minimum amountOut per 1e18 of amountIn.
    uint128 minRateE18;
    /// @dev Unix timestamp after which the mandate no longer authorises anything.
    uint64 expiry;
    /// @dev Maker fee, in SwapVM's 1e7 basis. 0.003e7 is 0.3%.
    uint24 feeBps;
    /// @dev Distinguishes otherwise identical mandates. Aqua permanently burns a strategy hash on
    ///   `dock()`, so renewing the same terms requires a fresh salt.
    uint64 salt;
}

library MandateLib {
    /// @dev SwapVM's fee basis.
    uint256 internal constant BPS = 1e7;

    /// @dev Must match what the maker passes to `Aqua.ship()` byte for byte.
    function encode(Mandate memory m) internal pure returns (bytes memory) {
        return abi.encode(m);
    }

    function hash(Mandate memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    /// @notice Compile a mandate into the SwapVM program that enforces it.
    /// @dev This is what makes the two enforcement surfaces one system rather than two. The same
    ///   `Mandate` either configures `BatasApp` directly or is compiled here into bytecode for
    ///   `BatasRouter`; both then price and refuse identically, which
    ///   `test/MandateAgreement.t.sol` checks trade by trade.
    ///
    ///   Instruction order is deliberate. `PolicyEnvelope` sits first so it wraps everything after
    ///   it, `Deadline` supplies the expiry term rather than duplicating one into the envelope,
    ///   and the fee precedes the curve so the swap prices the amount actually being exchanged.
    function toProgram(Mandate memory m) internal pure returns (bytes memory) {
        return bytes.concat(
            PolicyEnvelope.build(m.maxAmountIn, m.minRateE18),
            Deadline.build(uint40(m.expiry)),
            FeeFlatIn.build(m.feeBps),
            XYCSwap.build(),
            Salt.build(m.salt)
        );
    }

    /// @notice Price an exact-input swap exactly as the compiled program would.
    /// @dev Mirrors `FeeFlatIn` wrapping `XYCSwap`: the fee is taken off the input first, ceiling
    ///   division so it rounds toward the maker, and the curve prices what remains.
    function quoteExactIn(Mandate memory m, uint256 balanceIn, uint256 balanceOut, uint256 amountIn)
        internal
        pure
        returns (uint256 amountOut)
    {
        uint256 fee = (amountIn * m.feeBps + BPS - 1) / BPS;
        uint256 net = amountIn - fee;
        amountOut = (net * balanceOut) / (balanceIn + net);
    }
}
