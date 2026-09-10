// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { Opcode, OpcodeOps } from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";

import { PolicyEnvelope } from "./PolicyEnvelope.sol";
import { MandateName } from "./MandateName.sol";

/// @notice SwapVM's Aqua instruction set plus PolicyEnvelope.
/// @dev Extends `AquaOpcodes`, the set built for Aqua-backed strategies, rather than the full
///   `Opcodes`. Two reasons, one of them hard:
///
///    - The full set carries 24 instructions an Aqua strategy never reaches for, including every
///      balance instruction, because in Aqua mode balances are sourced from Aqua rather than
///      written into the bytecode. Carrying them pushes the router to 28,618 bytes, past the
///      EIP-170 limit of 24,576, and it cannot be deployed at all.
///    - This is an Aqua application, so the Aqua-backed variant is the honest base.
///
///   Not `OpcodesDebug` either: that layer overrides `_runOpcode` without re-declaring it
///   `virtual`, so it is terminal. `OpcodeList.sol` reserves `_Ix` slots per family bank for
///   third parties; `_21` and `_22` sit in the 0x20-0x3f "conditions and access guards" bank,
///   beside `Deadline` and the taker gates, which is the right bank for both of them: one bounds
///   what a settlement may do, the other bounds who may still cause one.
contract BatasOpcodes is AquaOpcodes {
    using OpcodeOps for Opcode;

    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode == PolicyEnvelope.opcode.asU8()) PolicyEnvelope.exec(ctx, args);
        else if (opcode == MandateName.opcode.asU8()) MandateName.exec(ctx, args);
        else super._runOpcode(ctx, opcode, args);
    }
}

/// @notice A SwapVM router wired to the extended instruction set.
/// @dev The 1inch track permits redeploying a modified SwapVM; nothing in the vendor tree is edited.
contract BatasRouter is Simulator, SwapVM, BatasOpcodes {
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
    { }

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        _runOpcode(ctx, opcode, args);
    }
}
