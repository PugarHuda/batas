// Tests for the SwapVM encoder and decoder.
//
//   node --test agent/
//
// The decoder is what the paid service sells, so a wrong answer here is worse than a crash: it
// tells a caller a position is bounded when it is not. These tests care most about that case.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    OP, decodeProgram, readMandate, explain,
    policyEnvelope, deadline, feeFlatIn, xycSwap, salt, instruction,
} from './swapvm.mjs';

// The program the agent actually shipped to Sepolia, kept verbatim as a regression anchor.
const LIVE_PROGRAM =
    '0x2120000000000000000579a814e10a74000000000000000000001aaa51121b231412700300753050000208000000006a9d5ef4';

test('decodes the program that is live on chain', () => {
    const r = explain(LIVE_PROGRAM);
    assert.equal(r.guarded, true);
    assert.deepEqual(r.instructions.map((i) => i.name), ['POLICY_ENVELOPE', 'FEE_FLAT_IN', 'XYC_SWAP', 'SALT']);
    assert.equal(r.mandate.maxAmountInFormatted, '101');
    assert.equal(r.mandate.minRateFormatted, '1.92143732923348277');
    assert.equal(r.mandate.feePercent, 0.3);
    assert.equal(r.mandate.curve, 'constant product (x*y=k)');
    assert.deepEqual(r.notes, []);
});

test('round-trips every term it encodes', () => {
    const expiry = 1893456000; // 2030-01-01
    const program = policyEnvelope(500n * 10n ** 18n, 1750000000000000000n)
        + deadline(expiry).slice(2)
        + feeFlatIn(30000).slice(2)
        + xycSwap().slice(2)
        + salt(42n).slice(2);

    const t = readMandate(decodeProgram(program));
    assert.equal(t.maxAmountIn, 500n * 10n ** 18n);
    assert.equal(t.minRateE18, 1750000000000000000n);
    assert.equal(t.expiry, expiry);
    assert.equal(t.feeBps, 30000);
    assert.equal(t.salt, '42');
    assert.equal(t.curve, 'constant product (x*y=k)');
});

test('an empty program decodes to nothing rather than throwing', () => {
    assert.deepEqual(decodeProgram('0x'), []);
});

test('a truncated instruction is rejected, not guessed at', () => {
    // PolicyEnvelope claims 32 arg bytes but only four follow.
    assert.throws(() => decodeProgram('0x212000000000'), /claims 32 arg bytes but only 4 remain/);
});

test('a dangling header is rejected', () => {
    assert.throws(() => decodeProgram('0x21'), /truncated instruction header/);
});

test('odd-length input is rejected', () => {
    assert.throws(() => decodeProgram('0x212'), /not whole bytes/);
});

test('an unknown opcode is surfaced by number instead of being dropped', () => {
    const program = '0x' + 'aa00' + xycSwap().slice(2);
    const ins = decodeProgram(program);
    assert.equal(ins[0].name, 'UNKNOWN_0xaa');
    assert.equal(ins.length, 2);
});

test('PolicyEnvelope anywhere but first is reported as unguarded', () => {
    // The limits are present and correct, and still worthless: FeeFlatIn wraps what follows it,
    // so the envelope no longer contains the rest of the program.
    const program = feeFlatIn(30000) + policyEnvelope(1n, 1n).slice(2) + xycSwap().slice(2);
    const r = explain(program);
    assert.equal(r.guarded, false);
    assert.equal(r.mandate.maxAmountIn, '1', 'the limit is still read');
    assert.match(r.notes.join(' '), /outermost position/);
});

test('a program with no envelope at all is called out on both limits', () => {
    const r = explain(xycSwap());
    assert.equal(r.guarded, false);
    assert.equal(r.mandate.maxAmountIn, null);
    assert.equal(r.mandate.minRateE18, null);
    assert.match(r.notes.join(' '), /No size cap/);
    assert.match(r.notes.join(' '), /No floor price/);
});

test('an expired deadline is called out', () => {
    const program = policyEnvelope(1n, 1n) + deadline(1000000000).slice(2) + xycSwap().slice(2);
    const r = explain(program);
    assert.match(r.notes.join(' '), /already passed/);
});

test('a live deadline is not called out', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const program = policyEnvelope(1n, 1n) + deadline(future).slice(2) + xycSwap().slice(2);
    const r = explain(program);
    assert.equal(r.notes.length, 0);
    assert.equal(r.mandate.expiry, future);
});

test('PolicyEnvelope args are exactly 32 bytes', () => {
    const built = policyEnvelope(1n, 1n);
    // 1 opcode + 1 length + 32 args
    assert.equal((built.length - 2) / 2, 34);
    assert.equal(built.slice(2, 4), '21');
    assert.equal(built.slice(4, 6), '20');
});

test('a malformed PolicyEnvelope is refused rather than half-read', () => {
    const bad = instruction(OP.POLICY_ENVELOPE, '0x0011'); // 2 arg bytes, not 32
    assert.throws(() => readMandate(decodeProgram(bad)), /must carry 32 arg bytes/);
});

test('curves are named individually', () => {
    assert.equal(readMandate(decodeProgram(instruction(OP.PEGGED_SWAP))).curve, 'pegged / stable curve');
    assert.equal(
        readMandate(decodeProgram(instruction(OP.XYC_CONCENTRATE_SWAP))).curve,
        'concentrated constant product',
    );
});

test('arguments longer than a byte length prefix allows are refused at encode time', () => {
    assert.throws(() => instruction(OP.SALT, '0x' + '00'.repeat(256)), /args too long/);
});
