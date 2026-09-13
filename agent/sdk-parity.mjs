// Reading SwapVM programs through 1inch's official SDK, @1inch/swap-vm-sdk.
//
// swapvm.mjs is Batas's own encoder and decoder, and everything a stranger is told about a live
// position goes through it. This file gives it something independent to be checked against: the
// SDK's own ProgramBuilder, opcode objects and argument coders, placed at the slots the router's
// Solidity actually uses. sdk-parity.test.mjs holds the comparisons and the findings.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// Loaded through require on purpose. The package's ESM build (dist/index.mjs, 0.4.4) imports
// `@1inch/byte-utils/dist/constants` with no file extension, which Node's ESM resolver refuses with
// ERR_MODULE_NOT_FOUND. The CommonJS build resolves the same import and ships the same code.
const require = createRequire(import.meta.url);
export const sdk = require('@1inch/swap-vm-sdk');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * Opcode slots by Solidity enum name, parsed from the OpcodeList.sol the router compiles against.
 *
 * Parsed rather than copied: swapvm.mjs's OP table is already a hand copy of this file, and
 * checking one hand copy against a second would only prove the two copies agree.
 */
function solidityOpcodeSlots() {
    const slots = {};
    for (const [, hex, name] of read('../node_modules/@1inch/swap-vm/src/libs/OpcodeList.sol').matchAll(/\/\* ([0-9a-f]{2}) \*\/ (\w+)/g)) {
        slots[name] = parseInt(hex, 16);
    }
    // Batas's two instructions name the free `_Ix` enum member they claim; follow that name to
    // its slot the same way, so a move in either .sol file shows up here.
    for (const [name, file] of [['PolicyEnvelope', '../src/PolicyEnvelope.sol'], ['MandateName', '../src/MandateName.sol']]) {
        const claimed = read(file).match(/Opcode constant opcode = Opcode\.(\w+);/)?.[1];
        if (!claimed || slots[claimed] === undefined) throw new Error(`${file} does not name an OpcodeList slot`);
        slots[name] = slots[claimed];
    }
    return slots;
}

export const SLOT = solidityOpcodeSlots();

/**
 * An instruction the SDK has no definition for, carried as its raw argument bytes.
 *
 * This is the SDK's own extension point (its README, "Creating your own instructions"): any object
 * satisfying its IOpcode interface can sit in an instruction set. It interprets nothing, so a
 * comparison that uses one says the SDK framed the stream the same way, not that it understood
 * those arguments, and the test labels it that way.
 */
export function opaque(name) {
    const coder = {
        encode: (args) => new sdk.HexString(args.raw),
        decode: (data) => ({ raw: data.toString(), toJSON: () => ({ raw: data.toString() }) }),
    };
    const op = {
        id: Symbol(name),
        argsCoder: () => coder,
        createIx: (args) => ({ opcode: op, args, toJSON: () => ({ opcode: name, args: args.toJSON() }) }),
    };
    return op;
}

/**
 * A 256-slot instruction set with the given opcodes at the given slots.
 *
 * Unassigned slots hold the SDK's EMPTY_OPCODE, the same filler its own `aquaInstructions` uses, so
 * this set behaves exactly as the SDK's would for a byte it has nothing registered at.
 */
export function bankedSet(entries) {
    const set = Array(256).fill(sdk.instructions.EMPTY_OPCODE);
    for (const [op, slot] of entries) set[slot] = op;
    return set;
}

/**
 * Decode a program with the SDK's ProgramBuilder and report it in decodeProgram's shape.
 *
 * Offsets come from re-encoding each decoded instruction with the SDK's own coder rather than from
 * the header bytes. That is deliberate: a coder that reads fewer bytes than the header declares, or
 * pads differently, re-encodes to a different length, every later offset moves, and the comparison
 * against decodeProgram fails where it should.
 */
export function officialDecode(program, set) {
    const builder = new sdk.ProgramBuilder(set).decode(new sdk.SwapVmProgram(program));
    let offset = 0;
    return builder.getInstructions().map((ins) => {
        const args = ins.opcode.argsCoder().encode(ins.args).toString().replace(/^0x/, '');
        const row = { offset, opcode: set.indexOf(ins.opcode), id: ins.opcode.id.description, args, decoded: ins.args };
        offset += 2 + args.length / 2;
        return row;
    });
}
