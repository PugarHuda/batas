// What a counterparty is entitled to say about an agent.
//
//   node --test agent/reputation.test.mjs
//
// The write is live by necessity and is not tested here; the arithmetic behind it is, because the
// number that goes on chain is the whole content of the record and a wrong one is worse than none.

import test from 'node:test';
import assert from 'node:assert/strict';

import { feedbackFromTrade, readReputation, tallyFeedback, MANDATE_TAG } from './reputation.mjs';

const AGENT_ID = '10123';

const e18 = 10n ** 18n;

test('the score is how far above its own floor the trade settled', () => {
    // Not a rating. A star count about an autonomous market maker means nothing and can be checked
    // by nobody; this is arithmetic on two numbers both parties hold, redoable from the transaction.
    const f = feedbackFromTrade({ settledRateE18: 1_948_987_088_535_167_759n, floorRateE18: 1_921_437_329_233_482_770n });
    assert.equal(f.bps, 143n);
    assert.equal(f.tag1, 'batas.mandate');
    assert.equal(f.tag2, 'floor-honoured');
    assert.equal(f.valueDecimals, 0, 'basis points are integers; decimals would be inventing precision');
});

test('a trade settled exactly on the floor scores zero, not badly', () => {
    // Zero is the honest reading: the mandate was honoured and nothing was given away beyond it.
    // Scoring it as a complaint would punish a position for enforcing exactly what it advertised.
    const f = feedbackFromTrade({ settledRateE18: 2n * e18, floorRateE18: 2n * e18 });
    assert.equal(f.bps, 0n);
    assert.equal(f.tag2, 'floor-honoured');
});

test('a breach is representable, and tagged as the accusation it is', () => {
    // The contracts refuse this, so a negative record is not a complaint about service — it is a
    // claim that the enforcement failed. It has to be sayable, or the registry could only ever
    // carry good news.
    const f = feedbackFromTrade({ settledRateE18: 19n * e18 / 10n, floorRateE18: 2n * e18 });
    assert.equal(f.bps, -500n);
    assert.equal(f.tag2, 'floor-breached');
});

test('a position with no floor cannot be scored against one', () => {
    // Rather than dividing by zero and writing a number nobody can interpret.
    assert.throws(() => feedbackFromTrade({ settledRateE18: e18, floorRateE18: 0n }), /no floor/);
    assert.throws(() => feedbackFromTrade({ settledRateE18: 0n, floorRateE18: e18 }), /settled at zero/);
});

// The tally is the part of the read that decides what counts, so it is tested on entries shaped
// exactly as `readReputation` builds them from `readAllFeedback`. These are records, not a stand-in
// for the registry: the registry cases below read the real one.
const entry = (over) => ({
    client: '0x1437aF5722D5Dfe6BAEda25f3A7A39aeCA374614', index: 1, value: '143', valueDecimals: 0,
    tag1: MANDATE_TAG, tag2: 'floor-honoured', revoked: false, self: false, ...over,
});

test('a revoked claim is not counted, and is not hidden either', () => {
    // The spec takes revoked feedback out of every summary. A breach report that its author withdrew
    // raising a health alert would be the page repeating an accusation nobody still makes.
    const t = tallyFeedback([entry({ tag2: 'floor-breached', revoked: true }), entry({})], { tag2: 'floor-breached' });
    assert.equal(t.counted.length, 0);
    assert.equal(t.revokedCount, 1);
    assert.deepEqual(t.clients, [], 'a client whose only matching entry is revoked is not asked about');
});

test("an identity's own holder does not get to raise its average", () => {
    // The registry refuses owner feedback when it is given, but not feedback left before the
    // identity changed hands, nor feedback from the agent's payment wallet.
    const holder = '0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E';
    const t = tallyFeedback([entry({ client: holder, self: true, value: '9999' }), entry({})], { tag1: MANDATE_TAG });
    assert.equal(t.counted.length, 1);
    assert.equal(t.selfFeedbackCount, 1);
    assert.deepEqual(t.clients, ['0x1437aF5722D5Dfe6BAEda25f3A7A39aeCA374614']);
});

test('a star record is not a basis-point record', () => {
    const t = tallyFeedback([entry({}), entry({ index: 2, tag1: 'starred', value: '100' })], { tag1: MANDATE_TAG });
    assert.deepEqual(t.counted.map((f) => f.tag1), [MANDATE_TAG]);
    assert.equal(tallyFeedback([entry({}), entry({ tag1: 'starred' })]).counted.length, 2, 'no tag asks for everything');
});

test('the live average is basis points, not basis points mixed with stars', async () => {
    // The defect this read was rebuilt for: on agent #10123 the untagged registry average of three
    // bps records and one 100/100 star came out at 106, and every surface printed it as "bps above
    // the floor", while the bps records alone average 108.
    const r = await readReputation(AGENT_ID);
    assert.equal(r.tag1, MANDATE_TAG);
    const mine = r.feedback.filter((f) => f.tag1 === MANDATE_TAG && !f.revoked && !f.self);
    assert.ok(mine.length > 0, 'the live agent has counterparty feedback');
    assert.equal(r.feedbackCount, mine.length, 'the registry counted exactly the entries the tally kept');
    if (mine.every((f) => f.valueDecimals === 0)) {
        // Integer bps throughout, so the registry's average is checkable here; Solidity truncates
        // toward zero, and so does BigInt division.
        const mean = mine.reduce((s, f) => s + BigInt(f.value), 0n) / BigInt(mine.length);
        assert.equal(r.summaryValue, mean.toString());
        assert.equal(r.summary, mean.toString());
    }

    const mixed = await readReputation(AGENT_ID, { tag1: '' });
    assert.equal(mixed.feedbackCount, mixed.feedback.filter((f) => !f.revoked && !f.self).length);
    if (r.feedback.some((f) => f.tag1 !== MANDATE_TAG && !f.revoked)) {
        assert.ok(mixed.feedbackCount > r.feedbackCount, 'other tags exist on chain and are left out of the bps average');
    }
});

test('one client leaving several reviews is not several clients', async () => {
    // The mislabel that prompted the split: `getSummary` counts entries and the client list counts
    // addresses, and the first version reported the first as the second.
    const r = await readReputation(AGENT_ID);
    assert.equal(r.clientCount, new Set(r.clients).size);
    assert.ok(r.feedbackCount >= r.clientCount);
    assert.equal(r.selfFeedbackCount, 0, 'the registry refused the agent its own say, and nothing since changed that');
});

test('an agent nobody has reviewed reads as zero rather than as a failed call', async () => {
    // `getSummary` reverts on an empty client list, so the commonest state of any agent — nobody
    // has said anything — would reach every caller as an exception. It is answered instead.
    const r = await readReputation((2n ** 200n).toString());
    assert.equal(r.feedbackCount, 0);
    assert.equal(r.clientCount, 0);
    assert.deepEqual(r.clients, []);
    assert.equal(r.summaryValue, '0');
    assert.deepEqual(r.feedback, []);
});

test('a reputation read refuses an id it cannot trust', async () => {
    // `BigInt('abc')` used to throw a SyntaxError out of the free route, which read as the registry
    // failing rather than as the caller's input being wrong.
    await assert.rejects(() => readReputation('abc'), /non-negative integer/);
    await assert.rejects(() => readReputation('-1'), /non-negative integer/);
});
