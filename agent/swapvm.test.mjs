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
    FEE_WORTH_MENTIONING,
} from './swapvm.mjs';

// A program actually shipped to Sepolia, kept verbatim as a regression anchor. Frozen on purpose:
// the live position moves as mandates are renewed, and a fixture that chased it would test the
// current chain state rather than the decoder.
const LIVE_PROGRAM =
    '0x212000000000000000056bc75e2d6310000000000000000000001a5e27eef13e00002005006a9da768700300753050000208000000006a9d8b48';

// And the one shipped before it, when script/Demo.s.sol chained instructions by hand and left
// Deadline out. Kept because it is the real shape of the failure rather than a constructed one:
// five terms look right, nothing errors, and the grant is permanent.
const UNBOUNDED_PROGRAM =
    '0x2120000000000000000579a814e10a74000000000000000000001aaa51121b231412700300753050000208000000006a9d5ef4';

test('decodes a program exactly as it was shipped', () => {
    const r = explain(LIVE_PROGRAM);
    assert.equal(r.guarded, true);
    assert.deepEqual(
        r.instructions.map((i) => i.name),
        ['POLICY_ENVELOPE', 'DEADLINE', 'FEE_FLAT_IN', 'XYC_SWAP', 'SALT'],
    );
    assert.equal(r.mandate.maxAmountInFormatted, '100');
    assert.equal(r.mandate.minRateFormatted, '1.9');
    assert.equal(r.mandate.feePercent, 0.3);
    assert.equal(r.mandate.curve, 'constant product (x*y=k)');
    assert.equal(r.mandate.expiryISO, '2026-09-06T17:48:24.000Z');
});

test('the mandate that shipped without a deadline is reported as permanent', () => {
    const r = explain(UNBOUNDED_PROGRAM);
    // Everything else about it is well formed, which is precisely why the omission needed saying.
    assert.equal(r.guarded, true);
    assert.equal(r.mandate.maxAmountInFormatted, '101');
    assert.equal(r.mandate.expiry, null);
    assert.deepEqual(r.notes, ['No deadline: this mandate never expires and can only be ended by revoking it.']);
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

test('a mandate with no deadline is called out, not passed over in silence', () => {
    // The shape this test exists for: script/Demo.s.sol built its program instruction by
    // instruction and left out Deadline, so every mandate it granted was permanent. The bytes
    // decoded perfectly and the report said nothing, which is worse than an error — a caller
    // paying for an explanation saw a bounded-looking position that could never be timed out.
    const forever = policyEnvelope(100n * 10n ** 18n, 1_900_000_000_000_000_000n)
        + feeFlatIn(30_000).slice(2) + xycSwap().slice(2) + salt(1n).slice(2);
    const { mandate, notes } = explain(forever);

    assert.equal(mandate.expiry, null);
    assert.ok(
        notes.some((n) => /never expires/.test(n)),
        `a permanent mandate must be reported as one; got ${JSON.stringify(notes)}`,
    );
});

test('a live deadline draws neither the expired note nor the missing one', () => {
    const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const program = policyEnvelope(100n * 10n ** 18n, 1_900_000_000_000_000_000n)
        + deadline(future).slice(2) + feeFlatIn(30_000).slice(2) + xycSwap().slice(2) + salt(1n).slice(2);
    const { notes } = explain(program);
    assert.ok(!notes.some((n) => /never expires|already passed/.test(n)), JSON.stringify(notes));
});

// --- terms that are present but do not limit ---------------------------------
//
// Everything the report said until now answered "is this term missing". A term can also be there,
// decode cleanly, and leave the position open anyway — which is harder to notice precisely because
// the report looks complete.

const live = (over = {}) => {
    const { fee = 30_000, seconds = 3600 } = over;
    return policyEnvelope(100n * 10n ** 18n, 1_900_000_000_000_000_000n)
        + deadline(Math.floor(Date.now() / 1000) + seconds).slice(2)
        + feeFlatIn(fee).slice(2) + xycSwap().slice(2) + salt(1n).slice(2);
};

test('an ordinary fee draws no remark', () => {
    assert.deepEqual(explain(live()).notes, []);
});

test('a fee large enough to matter is remarked on, with the threshold stated', () => {
    const { notes } = explain(live({ fee: 800_000 })); // 8%
    const note = notes.find((n) => /maker fee/.test(n));
    assert.ok(note, JSON.stringify(notes));
    assert.match(note, /8%/);
    // The line has to say where it was drawn, so a reader can disagree with it rather than take it.
    assert.match(note, /above the 5%/);
});

test('the fee threshold is a boundary, not a range', () => {
    assert.deepEqual(explain(live({ fee: FEE_WORTH_MENTIONING })).notes, [], 'exactly at the line is ordinary');
    assert.equal(explain(live({ fee: FEE_WORTH_MENTIONING + 1 })).notes.length, 1);
});

test('a deadline far enough out to bound nothing is remarked on', () => {
    const { notes } = explain(live({ seconds: 400 * 86_400 }));
    const note = notes.find((n) => /deadline is/.test(n));
    assert.ok(note, JSON.stringify(notes));
    assert.match(note, /400 days/);
    // And it must not be confused with having no deadline at all: the two have different remedies.
    assert.ok(!notes.some((n) => /never expires/.test(n)));
});

test('a year and a day is remarked on; a month is not', () => {
    assert.deepEqual(explain(live({ seconds: 30 * 86_400 })).notes, []);
    assert.equal(explain(live({ seconds: 366 * 86_400 })).notes.length, 1);
});
