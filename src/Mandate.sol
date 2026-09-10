// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { PolicyEnvelope } from "./PolicyEnvelope.sol";
import { MandateName } from "./MandateName.sol";
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
    /// @dev The operator this position was granted to. It is part of `abi.encode(m)`, so it is
    ///   part of the strategy hash and therefore part of the position's identity: the same terms
    ///   granted to a different operator are a different position, and Aqua's `Shipped` event puts
    ///   the whole encoded mandate on chain, so which one is publicly readable.
    ///
    ///   It is deliberately not a gate on the taker, and it could not be one. A position only one
    ///   address may trade against is not liquidity, and the agent never appears on the swap path
    ///   at all — the maker ships, the taker swaps — so there is no call here whose sender it
    ///   could be checked against. What bounds the operator is the terms it was able to compile
    ///   into the position; what ends it is the expiry, or the maker docking the position.
    ///   `test_TheAgentNamesTheGrantAndGatesNobody` pins both halves of that.
    address agent;
    address tokenIn;
    address tokenOut;
    /// @dev Largest input the maker will settle in a single swap.
    uint128 maxAmountIn;
    /// @dev Floor price: minimum amountOut per 1e18 of amountIn. A ratio of token base units
    ///   scaled by 1e18, not a decimals-aware price — with a 6-decimal input and an 18-decimal
    ///   output, one-for-one is 1e30, not 1e18. The agent derives this from reserves it has just
    ///   read, so it is consistent by construction; a mandate written by hand is where the
    ///   distinction bites.
    uint128 minRateE18;
    /// @dev Unix timestamp after which the mandate no longer authorises anything.
    uint64 expiry;
    /// @dev Maker fee, in SwapVM's 1e7 basis. 0.003e7 is 0.3%.
    uint24 feeBps;
    /// @dev Distinguishes otherwise identical mandates. Aqua permanently burns a strategy hash on
    ///   `dock()`, so renewing the same terms requires a fresh salt.
    uint64 salt;
    /// @dev The kill switch, made binding.
    ///
    ///   An ENSv2 subname already expressed this agent's authority and the agent consulted it
    ///   before acting — but nothing on chain did, so revocation stopped the agent that asks and
    ///   nobody else. Naming a registry here puts the check into the settlement itself, where a
    ///   burned or lapsed name reverts the swap for every caller.
    ///
    ///   Zero means no check, and that is a real choice rather than a default: a mandate whose only
    ///   ends are its expiry and `Aqua.dock()` is a coherent grant, and one fewer external call on
    ///   the settlement path.
    address nameRegistry;
    /// @dev The address that must still hold the name. Ignored when `nameRegistry` is zero.
    address nameHolder;
    /// @dev The label to ask the registry about, e.g. "agent". Ignored when `nameRegistry` is zero.
    string nameLabel;
}

library MandateLib {
    /// @dev SwapVM's fee basis.
    uint256 internal constant BPS = 1e7;

    /// @dev `Deadline` carries five bytes, so this is the largest expiry a program can express.
    uint64 internal constant MAX_ENCODABLE_EXPIRY = type(uint40).max;

    error MandateExpiryUnencodable(uint64 expiry);
    error MandateFeeExceedsBasis(uint24 feeBps);

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
        // Refuse what cannot be expressed, rather than expressing something else.
        //
        // `Deadline` holds five bytes and `uint40(m.expiry)` would quietly keep the low ones,
        // leaving `BatasApp` checking one timestamp and the compiled program checking another.
        // That is not a wrong number, it is the two enforcement surfaces meaning different things
        // — the single failure every test in MandateAgreement exists to catch — and it would sit
        // in the one place those tests never looked, because the fuzz held `expiry` fixed.
        //
        // Same argument as PolicyEnvelope's own length check: a compiler that half-expresses its
        // terms is worse than one that declines.
        require(m.expiry <= MAX_ENCODABLE_EXPIRY, MandateExpiryUnencodable(m.expiry));
        // A fee at or past the basis takes the whole input, so the curve is handed nothing to
        // price and the trade becomes a transfer to the maker. `quoteExactIn` reverts on the
        // subtraction and the VM does something of its own; neither is an answer worth emitting.
        require(m.feeBps < BPS, MandateFeeExceedsBasis(m.feeBps));

        // The name check sits after `Deadline` so a lapsed mandate fails on arithmetic before
        // anything pays for three external calls, and before the curve so it fails before the
        // expensive part. It is inside `PolicyEnvelope` like everything else, though nothing about
        // it depends on the settled amounts — unlike a cap or a floor, there is no later
        // instruction that could undo the answer.
        bytes memory nameCheck = m.nameRegistry == address(0)
            ? bytes("")
            : MandateName.build(m.nameRegistry, m.nameHolder, m.nameLabel);

        return bytes.concat(
            PolicyEnvelope.build(m.maxAmountIn, m.minRateE18),
            Deadline.build(uint40(m.expiry)),
            nameCheck,
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
