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
    FEE_WORTH_MENTIONING, MAX_ENCODABLE_EXPIRY, BPS, toProgram,
} from './swapvm.mjs';

// A program actually shipped to Sepolia, kept verbatim as a regression anchor. Frozen on purpose:
// the live position moves as mandates are renewed, and a fixture that chased it would test the
// current chain state rather than the decoder.
const LIVE_PROGRAM =
    '0x212100000000000000006367be30fcbd45ea00000000000000001aeff914e72b45e8802005006acd0476222e945800bd6cdd60521b64a12d7b3f12fc90916a6b39d2bae5eaeda9283535ddc98f1991c81ed5cd7e056167656e74700300753050000208000000006aa58586';

// And the one shipped before it, when script/Demo.s.sol chained instructions by hand and left
// Deadline out. Kept because it is the real shape of the failure rather than a constructed one:
// five terms look right, nothing errors, and the grant is permanent.
// The shape script/Demo.s.sol once shipped: every instruction but Deadline. Rebuilt with the
// encoder rather than kept as the historical bytes, because those carried the 32-byte envelope the
// router now refuses as truncated — the omission being pinned is the deadline, not the direction.
const UNBOUNDED_PROGRAM = policyEnvelope(101n * 10n ** 18n, 1_920_000_000_000_000_000n, true)
    + feeFlatIn(30_000).slice(2) + xycSwap().slice(2) + salt(7n).slice(2);

test('decodes a program exactly as it was shipped', () => {
    const r = explain(LIVE_PROGRAM);
    assert.equal(r.guarded, true);
    assert.deepEqual(
        r.instructions.map((i) => i.name),
        ['POLICY_ENVELOPE', 'DEADLINE', 'MANDATE_NAME', 'FEE_FLAT_IN', 'XYC_SWAP', 'SALT'],
    );
    assert.equal(r.mandate.maxAmountInFormatted, '7.162902849964033514');
    assert.equal(r.mandate.minRateFormatted, '1.941043832593008104');
    assert.equal(r.mandate.feePercent, 0.3);
    assert.equal(r.mandate.curve, 'constant product (x*y=k)');
    assert.equal(r.mandate.expiryISO, '2026-10-12T16:01:58.000Z');
    assert.equal(r.mandate.direction, 'aToB');
    assert.equal(r.mandate.killSwitch.label, 'agent');
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
    const program = policyEnvelope(500n * 10n ** 18n, 1750000000000000000n, true)
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
    const program = feeFlatIn(30000) + policyEnvelope(1n, 1n, true).slice(2) + xycSwap().slice(2);
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
    const program = policyEnvelope(1n, 1n, true) + deadline(1000000000).slice(2) + xycSwap().slice(2);
    const r = explain(program);
    assert.match(r.notes.join(' '), /already passed/);
});

test('a live deadline is not called out', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const program = policyEnvelope(1n, 1n, true) + deadline(future).slice(2) + xycSwap().slice(2);
    const r = explain(program);
    assert.equal(r.notes.length, 0);
    assert.equal(r.mandate.expiry, future);
});

test('PolicyEnvelope args are exactly 33 bytes', () => {
    const built = policyEnvelope(1n, 1n, true);
    // 1 opcode + 1 length + 32 args + 1 direction byte
    assert.equal((built.length - 2) / 2, 35);
    assert.equal(built.slice(2, 4), '21');
    assert.equal(built.slice(4, 6), '21');
    assert.equal(built.slice(-2), '80', 'direction packs into the top bit, as LimitSwap packs its bool');
    assert.equal(policyEnvelope(1n, 1n, false).slice(-2), '00');
});

test('a malformed PolicyEnvelope is refused rather than half-read', () => {
    const bad = instruction(OP.POLICY_ENVELOPE, '0x0011'); // 2 arg bytes, not 33
    assert.throws(() => readMandate(decodeProgram(bad)), /must carry 33 arg bytes/);
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
    const forever = policyEnvelope(100n * 10n ** 18n, 1_900_000_000_000_000_000n, true)
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
    const program = policyEnvelope(100n * 10n ** 18n, 1_900_000_000_000_000_000n, true)
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
    return policyEnvelope(100n * 10n ** 18n, 1_900_000_000_000_000_000n, true)
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

test('a year and a day draws the deadline remark; a month draws only the floor one', () => {
    // This used to assert a month was unremarkable. It is not: the floor is struck once at grant
    // time and does not follow the market, so a month is long enough for the two to part company.
    // The deadline remark is a different claim — that the expiry itself has stopped bounding
    // anything — and still belongs to terms measured in years.
    const month = explain(live({ seconds: 30 * 86_400 })).notes;
    assert.equal(month.length, 1, JSON.stringify(month));
    assert.match(month[0], /floor is a fixed rate/);

    const year = explain(live({ seconds: 366 * 86_400 })).notes;
    assert.equal(year.length, 2, JSON.stringify(year));
    assert.ok(year.some((n) => /deadline is/.test(n)));
});

test('a floor with time to go stale is remarked on, with the threshold stated', () => {
    const { notes } = explain(live({ seconds: 40 * 86_400 }));
    const note = notes.find((n) => /floor is a fixed rate/.test(n));
    assert.ok(note, JSON.stringify(notes));
    assert.match(note, /40 days/);
    // Where the line was drawn has to be in the note, so a reader can disagree with it.
    assert.match(note, /past the 7 days/);
});

test('the staleness threshold is a boundary, not a range', () => {
    assert.deepEqual(explain(live({ seconds: 7 * 86_400 })).notes, [], 'exactly a week is short');
    assert.equal(explain(live({ seconds: 7 * 86_400 + 60 })).notes.length, 1);
});

test('a term short enough for its floor to still mean something draws nothing', () => {
    assert.deepEqual(explain(live({ seconds: 2 * 3600 })).notes, [], 'the default two-hour grant');
});

test('a mandate carrying a kill switch reports who may end it, and where', () => {
    const registry = '0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B';
    const holder = '0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E';
    const program = toProgram({
        tokenIn: '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B',
        tokenOut: '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81',
        maxAmountIn: 100n * 10n ** 18n,
        minRateE18: 1_900_000_000_000_000_000n,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        feeBps: 30_000,
        salt: 1n,
        nameRegistry: registry,
        nameHolder: holder,
        nameLabel: 'agent',
    });

    const { mandate, instructions } = explain(program);
    assert.equal(instructions[2].name, 'MANDATE_NAME', 'it sits after the deadline, before the fee');
    assert.deepEqual(mandate.killSwitch, { registry, holder, label: 'agent' });

    // And a mandate without one says so plainly rather than by omission.
    assert.equal(explain(live()).mandate.killSwitch, null);
});

test('a truncated kill switch is refused rather than half-read', () => {
    // Same rule as the instruction on chain, and for the same reason: a short one reads its
    // registry out of whatever bytes follow it, and a guard pointed at the wrong registry is a
    // guard that passes.
    const short = instruction(OP.MANDATE_NAME, '0x' + 'ab'.repeat(40));
    assert.throws(() => explain(short + feeFlatIn(30_000).slice(2)), /at least 41 arg bytes/);

    const lying = instruction(OP.MANDATE_NAME, '0x' + 'ab'.repeat(40) + 'c8');
    assert.throws(() => explain(lying + feeFlatIn(30_000).slice(2)), /runs past its arguments/);
});

test('every mandate the encoder can build, the decoder reads back unchanged', () => {
    // Parity with Solidity is checked case by case against a fixed dump, which proves the two
    // encoders agree and says nothing about whether the *decoder* agrees with either. This closes
    // the loop on arbitrary terms: compile, walk the bytes back, and the numbers must survive.
    //
    // Seeded, so a failure is a bug report rather than an anecdote. Change the seed and you are
    // running a different test; print it and you can run the same one again.
    let seed = 0x9e3779b9;
    const rand = () => {
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >> 17;
        seed ^= seed << 5; seed >>>= 0;
        return seed / 0x100000000;
    };
    const pick = (max) => BigInt(Math.floor(rand() * Number(max)));

    for (let i = 0; i < 500; i++) {
        const terms = {
            tokenIn: '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B',
            tokenOut: '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81',
            maxAmountIn: pick(10n ** 24n),
            minRateE18: pick(10n ** 22n),
            expiry: Math.floor(rand() * MAX_ENCODABLE_EXPIRY),
            feeBps: Math.floor(rand() * (Number(BPS) - 1)),
            salt: pick(2n ** 60n),
        };
        const back = readMandate(decodeProgram(toProgram(terms)));
        const shown = JSON.stringify({ ...terms, maxAmountIn: String(terms.maxAmountIn), minRateE18: String(terms.minRateE18), salt: String(terms.salt) });
        assert.equal(back.maxAmountIn, terms.maxAmountIn, `cap survived? ${shown}`);
        assert.equal(back.minRateE18, terms.minRateE18, `floor survived? ${shown}`);
        assert.equal(back.expiry, terms.expiry, `expiry survived? ${shown}`);
        assert.equal(back.feeBps, terms.feeBps, `fee survived? ${shown}`);
        assert.equal(back.salt, terms.salt.toString(), `salt survived? ${shown}`);
        assert.equal(back.curve, 'constant product (x*y=k)', `curve survived? ${shown}`);
        assert.equal(back.direction, 'aToB', `direction survived? ${shown}`);
        assert.equal(back.direction, 'aToB', `direction survived? ${shown}`);
    }
});

test('the encoder refuses terms the program cannot carry', () => {
    // The same two refusals MandateLib.toProgram makes. A mandate is compiled on both sides of the
    // fence and the two must decline the same inputs, or the agent can ship what the contracts
    // would never emit.
    const terms = {
        tokenIn: '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B',
        tokenOut: '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81',
        maxAmountIn: 100n * 10n ** 18n,
        minRateE18: 1_900_000_000_000_000_000n,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        feeBps: 30_000,
        salt: 1n,
    };
    assert.ok(toProgram(terms).startsWith('0x'), 'ordinary terms must still compile');

    assert.throws(
        () => toProgram({ ...terms, expiry: MAX_ENCODABLE_EXPIRY + 1 }),
        /largest Deadline can carry/,
    );
    assert.ok(toProgram({ ...terms, expiry: MAX_ENCODABLE_EXPIRY }), 'the largest one it can carry compiles');

    assert.throws(() => toProgram({ ...terms, feeBps: Number(BPS) }), /takes the whole input/);
    assert.ok(toProgram({ ...terms, feeBps: Number(BPS) - 1 }), 'a fee just under the basis compiles');
});

test('the direction is a term, read back and refused when missing', () => {
    // The envelope shipped without it once, and three readers found the hole the same afternoon.
    const aToB = policyEnvelope(1n, 1n, true) + xycSwap().slice(2);
    const bToA = policyEnvelope(1n, 1n, false) + xycSwap().slice(2);
    assert.equal(explain(aToB).mandate.direction, 'aToB');
    assert.equal(explain(bToA).mandate.direction, 'bToA');

    // An encoder that is not told the direction must not guess it.
    assert.throws(() => policyEnvelope(1n, 1n), /needs a direction/);
    assert.throws(
        () => toProgram({ maxAmountIn: 1n, minRateE18: 1n, expiry: 1_800_000_000, feeBps: 0, salt: 1n }),
        /needs tokenIn and tokenOut/,
    );

    // And the 32-byte shape it used to ship in is refused, exactly as the router refuses it.
    const legacy = instruction(OP.POLICY_ENVELOPE, '0x' + '00'.repeat(32)) + xycSwap().slice(2);
    assert.throws(() => explain(legacy), /33 arg bytes/);
});
