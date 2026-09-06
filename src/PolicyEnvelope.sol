// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import { MemoryPtr, MemoryPtrLib } from "@1inch/swap-vm/src/libs/MemoryPtr.sol";
import { InstructionBuilder } from "@1inch/swap-vm/src/libs/InstructionBuilder.sol";
import { InstructionArgs } from "@1inch/swap-vm/src/libs/InstructionArgs.sol";

/// @notice A SwapVM instruction that holds an entire strategy program to the maker's mandate.
/// @dev Encoding: [uint128 maxAmountIn][uint128 minRateE18]
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

    Opcode constant opcode = Opcode._21;

    uint256 private constant _E18 = 1e18;

    function sizeOf(uint128, uint128) internal pure returns (uint256) {
        return InstructionBuilder.sizeOf() + 32;
    }

    /// @param maxAmountIn Largest input the maker will settle in one swap
    /// @param minRateE18 Floor price: minimum amountOut per 1e18 of amountIn
    function build(uint128 maxAmountIn, uint128 minRateE18) internal pure returns (bytes memory) {
        return build(MemoryPtrLib.alloc(sizeOf(maxAmountIn, minRateE18)), maxAmountIn, minRateE18).resolve();
    }

    /// @dev Streaming form, so a whole program can be laid out in one allocation.
    function build(MemoryPtr ptrStart, uint128 maxAmountIn, uint128 minRateE18)
        internal
        pure
        returns (MemoryPtr ptr)
    {
        ptr = ptrStart.pushHeader(opcode);
        ptr = ptr.push(uint256(maxAmountIn), 16);
        ptr = ptr.push(uint256(minRateE18), 16);
        ptrStart.patchLength(ptr);
    }

    function parse(bytes calldata args) internal pure returns (uint128 maxAmountIn, uint128 minRateE18) {
        maxAmountIn = args.at(0).asU128();
        minRateE18 = args.at(16).asU128();
    }

    function exec(Context memory ctx, bytes calldata args) internal {
        (uint128 maxAmountIn, uint128 minRateE18) = parse(args);

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
