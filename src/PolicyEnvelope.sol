// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import { MemoryPtr, MemoryPtrLib } from "@1inch/swap-vm/src/libs/MemoryPtr.sol";
import { InstructionBuilder } from "@1inch/swap-vm/src/libs/InstructionBuilder.sol";
import { InstructionArgs } from "@1inch/swap-vm/src/libs/InstructionArgs.sol";

/// @notice A SwapVM instruction that holds an entire strategy program to the maker's mandate.
/// @dev Encoding: [uint128 maxAmountIn][uint128 minRateE18][bool direction]
///
/// The direction byte is the one this instruction shipped without, and three independent readers
/// found the hole the same afternoon. A mandate says "sell A for B, at most 100 A, never under
/// 1.9 B per A" — but SwapVM lets the taker choose the direction (`isAToB`), and a guard that reads
/// only `amountIn`/`amountOut` applies the cap and the floor to whichever token arrived. On the
/// demo pair the reverse trade happened to be refused, because 1/2.0 is under 1.9 by luck of the
/// numbers; on an ETH/USDC pair the same envelope let 24.9 ETH out against a "10 ETH" cap, the
/// floor reduced to a comparison between wei and USDC units that any price satisfies. `BatasApp`
/// has no reverse path at all, so this was also the two surfaces meaning different things.
///
/// The check is the vendor's own, from `LimitSwap`: one packed bool, compared to
/// `ctx.query.tokenIn < ctx.query.tokenOut`, before the program runs.
///
/// This is a *wrapping* instruction, built the same way SwapVM's own fee instructions are: it
/// delegates the rest of the program to `runLoop()` and inspects the settled registers when that
/// returns. Two properties follow, and neither is available to a plain sequential guard:
///
///  1. Placement stops mattering. In exactOut mode `amountIn` is only final once the swap curve
///     has run, so a sequential guard has to sit after the curve — a rule a program author can
///     silently get wrong.
///  2. Nothing can undo the check. Every later instruction executes *inside* the wrapper, so a
///     fee or rebalance appended after the curve cannot push the amounts back out of bounds
///     once the guard has already passed.
///
/// Placed first, it is the outermost frame of the program, and no instruction can escape it.
library PolicyEnvelope {
    using InstructionArgs for bytes;
    using InstructionArgs for bytes32;
    using MemoryPtrLib for MemoryPtr;
    using InstructionBuilder for MemoryPtr;
    using ContextLib for Context;

    error MandateAmountInExceeded(uint256 amountIn, uint256 maxAmountIn);
    error MandateRateTooLow(uint256 amountOut, uint256 amountIn, uint256 minRateE18);
    error MandateArgsTruncated(uint256 length);
    error MandateDirectionMismatch();

    Opcode constant opcode = Opcode._21;

    uint256 private constant _E18 = 1e18;

    /// @dev Cap, floor, and one byte carrying the direction the terms are denominated in.
    uint256 internal constant ARGS = 33;

    function sizeOf(uint128, uint128, bool) internal pure returns (uint256) {
        return InstructionBuilder.sizeOf() + ARGS;
    }

    /// @param maxAmountIn Largest input the maker will settle in one swap
    /// @param minRateE18 Floor price: minimum amountOut per 1e18 of amountIn
    /// @param direction `tokenIn < tokenOut` for the mandate's own tokens, as `LimitSwap` encodes it
    function build(uint128 maxAmountIn, uint128 minRateE18, bool direction) internal pure returns (bytes memory) {
        return build(MemoryPtrLib.alloc(sizeOf(maxAmountIn, minRateE18, direction)), maxAmountIn, minRateE18, direction)
            .resolve();
    }

    /// @dev Streaming form, so a whole program can be laid out in one allocation.
    function build(MemoryPtr ptrStart, uint128 maxAmountIn, uint128 minRateE18, bool direction)
        internal
        pure
        returns (MemoryPtr ptr)
    {
        ptr = ptrStart.pushHeader(opcode);
        ptr = ptr.push(uint256(maxAmountIn), 16);
        ptr = ptr.push(uint256(minRateE18), 16);
        ptr = ptr.push(InstructionBuilder.encodeBool(direction, 0));
        ptrStart.patchLength(ptr);
    }

    /// @dev The length check is not ceremony. `InstructionArgs.at` is a raw `calldataload` and
    ///   1inch documents it as such — "the library does not implement out-of-bounds read
    ///   validations" — so an envelope built with fewer than 32 bytes of args reads its limits out
    ///   of whatever follows in calldata: the next instruction's bytes, or past the end of the
    ///   program entirely. Every other instruction can afford that, because a misparsed fee or
    ///   curve produces a wrong price and someone notices. This one produces a *guard that passes*,
    ///   which is the failure nobody sees.
    ///
    ///   It also settles a disagreement between the two surfaces: the decoder in agent/swapvm.mjs
    ///   already refuses a short PolicyEnvelope rather than half-reading it, so without this the
    ///   report and the chain would describe different programs.
    function parse(bytes calldata args)
        internal
        pure
        returns (uint128 maxAmountIn, uint128 minRateE18, bool direction)
    {
        require(args.length >= ARGS, MandateArgsTruncated(args.length));
        maxAmountIn = args.at(0).asU128();
        minRateE18 = args.at(16).asU128();
        direction = args.at(32).asBool(0);
    }

    function exec(Context memory ctx, bytes calldata args) internal {
        (uint128 maxAmountIn, uint128 minRateE18, bool direction) = parse(args);

        // Before the program runs, not after: a trade in the wrong direction is not a trade whose
        // amounts need judging, it is a trade the mandate never spoke about.
        require(direction == (ctx.query.tokenIn < ctx.query.tokenOut), MandateDirectionMismatch());

        ctx.runLoop();

        uint256 amountIn = ctx.swap.amountIn;
        uint256 amountOut = ctx.swap.amountOut;

        require(amountIn <= maxAmountIn, MandateAmountInExceeded(amountIn, maxAmountIn));

        // Cross-multiplied so no division is needed: amountOut / amountIn >= minRateE18 / 1e18.
        // ponytail: amountOut * 1e18 only overflows past ~1.1e59 tokens, far beyond any real supply.
        if (amountIn != 0) {
            require(amountOut * _E18 >= amountIn * minRateE18, MandateRateTooLow(amountOut, amountIn, minRateE18));
        }
    }
}
