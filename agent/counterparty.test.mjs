// What the counterparty refuses, and why.
//
//   node --test agent/counterparty.test.mjs
//
// The three fetches are not tested here and should not be: they are the service's own surfaces and
// `qa/service.spec.mjs` already holds them. What is worth pinning is the judgement made from the
// answers, because it is the only part anyone would argue with — and because logic reachable only
// by making three live calls against two chains is logic nobody runs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { doubtsAbout, POLICY } from './counterparty.mjs';

/** A position this counterparty is happy with, which every case below spoils in one way. */
const sound = () => ({
    decoded: {
        guarded: true,
        mandate: {
            minRateE18: '1921437329233482770',
            maxAmountInFormatted: '17.573127545903015167',
            expiryISO: '2026-10-10T14:20:56.000Z',
            killSwitch: { registry: '0x9458', holder: '0x39d2', label: 'agent' },
        },
    },
    publication: { published: true, publishedAt: '2026-09-10T15:21:07.442Z' },
    authority: { valid: true, reason: 'held and unexpired' },
});

test('a sound position raises nothing', () => {
    assert.deepEqual(doubtsAbout(sound()), []);
});

test('a guard that is not outermost is a doubt, because later instructions could undo it', () => {
    const p = sound();
    p.decoded.guarded = false;
    assert.match(doubtsAbout(p).join(' '), /not outermost/);
});

test('each missing term is named on its own, not lumped into one complaint', () => {
    // A counterparty told "the terms are bad" learns nothing it can act on. Which term, and what
    // the absence permits, is the whole content of the answer.
    for (const [field, pattern] of [
        ['minRateE18', /no floor price/],
        ['maxAmountInFormatted', /no size cap/],
        ['expiryISO', /no deadline/],
        ['killSwitch', /no on-chain kill switch/],
    ]) {
        const p = sound();
        delete p.decoded.mandate[field];
        const doubts = doubtsAbout(p);
        assert.equal(doubts.length, 1, `removing ${field} should raise exactly one doubt: ${JSON.stringify(doubts)}`);
        assert.match(doubts[0], pattern);
    }
});

test('an unpublished program is a doubt even when every term is sound', () => {
    // This is the one a decoder alone cannot reach. The bytes can be perfect and still be something
    // handed over a minute ago, which is a different thing from a grant that has been standing.
    const p = sound();
    p.publication = { published: false, reason: 'no record' };
    assert.match(doubtsAbout(p).join(' '), /no publication record/);
});

test('an unfinished lookup is a different doubt from an absent record', () => {
    // The two look alike and mean opposite things. "We walked the whole topic and these bytes are
    // not on it" is a finding about the mandate. "We stopped after ten pages" is a finding about
    // us, and a counterparty that treats the second as the first is acting on evidence nobody
    // gathered.
    const absent = sound();
    absent.publication = { published: false, searched: 'complete', reason: 'these bytes have not been published to this topic' };
    assert.match(doubtsAbout(absent).join(' '), /no publication record/);

    const unknown = sound();
    unknown.publication = { published: null, searched: 'incomplete', reason: 'stopped after 10 pages of this topic with more to read' };
    const [doubt] = doubtsAbout(unknown);
    assert.match(doubt, /unanswered/);
    assert.match(doubt, /stopped after 10 pages/, 'the reason has to travel, or the caller cannot judge it');
    assert.doesNotMatch(doubt, /no publication record/);
});

test('a revoked name is a doubt, and the reason travels with it', () => {
    const p = sound();
    p.authority = { valid: false, revoked: true, reason: 'mandate name "agent" was revoked at 2026-09-11T02:55:10.000Z' };
    const [doubt] = doubtsAbout(p);
    assert.match(doubt, /authority is gone/);
    assert.match(doubt, /revoked at/, 'the counterparty should repeat why, not just that');
});

test('a counterparty may set its own bar, and the defaults are not the only ones', () => {
    // The policy belongs to the counterparty, not to this project. One that does not insist on a
    // kill switch is making a different bet, and should get a different answer rather than an
    // argument.
    const p = sound();
    delete p.decoded.mandate.killSwitch;
    assert.equal(doubtsAbout(p).length, 1);
    assert.deepEqual(doubtsAbout(p, { ...POLICY, requireKillSwitch: false }), []);
});

test('an answer missing altogether is refused rather than read as consent', () => {
    // A service that returned nothing, or a fetch that failed and was swallowed somewhere upstream,
    // must not arrive here looking like a clean bill of health. Every doubt fires.
    const doubts = doubtsAbout({});
    assert.ok(doubts.length >= 6, `an empty answer must not read as a sound position: ${JSON.stringify(doubts)}`);
});
