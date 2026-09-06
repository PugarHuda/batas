// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { Opcode, OpcodeOps } from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import { Opcodes } from "@1inch/swap-vm/src/opcodes/Opcodes.sol";

import { PolicyEnvelope } from "./PolicyEnvelope.sol";

/// @notice SwapVM's instruction set plus PolicyEnvelope.
/// @dev Extends `Opcodes` rather than `OpcodesDebug`: the debug layer overrides `_runOpcode`
///   without re-declaring it `virtual`, so it is terminal and cannot be extended further.
///   `OpcodeList.sol` reserves `_Ix` slots per family bank for exactly this; `_21` sits in the
///   0x20-0x3f "conditions and access guards" bank, beside `Deadline` and the taker gates.
contract AmanatOpcodes is Opcodes {
    using OpcodeOps for Opcode;

    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode == PolicyEnvelope.opcode.asU8()) PolicyEnvelope.exec(ctx, args);
        else super._runOpcode(ctx, opcode, args);
    }
}

/// @notice A SwapVM router wired to the extended instruction set.
/// @dev The 1inch track permits redeploying a modified SwapVM; nothing in the vendor tree is edited.
contract AmanatRouter is Simulator, SwapVM, AmanatOpcodes {
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
    { }

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        _runOpcode(ctx, opcode, args);
    }
}
