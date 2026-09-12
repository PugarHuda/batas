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

import { doubtsAbout, shouldPay, minRateFromEnv, POLICY } from './counterparty.mjs';

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

// --- what the counterparty now checks for itself ------------------------------

test('a server that agrees with the chain adds nothing', () => {
    const p = sound();
    p.local = structuredClone(p.decoded);
    p.local.mandate.killSwitch.registry = p.local.mandate.killSwitch.registry.toUpperCase();
    assert.deepEqual(doubtsAbout(p), [], 'checksum casing is not a disagreement');
});

test('a server that describes different bytes than the chain carries is a doubt', () => {
    // The maker's server decoding the maker's position is the party under review grading its own
    // paper. The chain's bytes are the terms; the server's answer is a claim about them.
    for (const spoil of [
        (d) => { d.mandate.minRateE18 = '1'; },
        (d) => { d.mandate.maxAmountInFormatted = '1000'; },
        (d) => { d.mandate.expiryISO = '2030-01-01T00:00:00.000Z'; },
        (d) => { d.mandate.killSwitch = null; },
        (d) => { d.guarded = false; },
    ]) {
        const p = sound();
        p.local = structuredClone(p.decoded);
        spoil(p.decoded);
        assert.match(doubtsAbout(p).join(' '), /bytes the chain does not carry/);
    }
});

test('the chain is the source of the terms, and the server only a witness', () => {
    // A server claiming a kill switch the bytes lack must not be believed about the kill switch.
    const p = sound();
    p.local = structuredClone(p.decoded);
    delete p.local.mandate.killSwitch;
    const doubts = doubtsAbout(p);
    assert.match(doubts.join(' '), /no on-chain kill switch/);
    assert.match(doubts.join(' '), /bytes the chain does not carry/);
});

test('a floor more than 10% under the position\'s own spot is a doubt', () => {
    const floor = 1921437329233482770n; // what sound() carries
    const tight = sound();
    tight.spotE18 = (floor * 100n) / 95n; // floor is 5% under spot
    assert.deepEqual(doubtsAbout(tight), []);

    const loose = sound();
    loose.spotE18 = (floor * 100n) / 85n; // floor is 15% under spot
    assert.match(doubtsAbout(loose).join(' '), /more than 10% under the position's own spot/);
});

test('a quote under the counterparty\'s own minimum is a doubt, and no quote is not a pass', () => {
    const minRateE18 = 2n * 10n ** 18n;
    const fine = sound();
    Object.assign(fine, { minRateE18, quoteE18: minRateE18 + 1n });
    assert.deepEqual(doubtsAbout(fine), []);

    const low = sound();
    Object.assign(low, { minRateE18, quoteE18: minRateE18 - 1n });
    assert.match(doubtsAbout(low).join(' '), /under this counterparty's minimum/);

    const refused = sound();
    Object.assign(refused, { minRateE18, quoteE18: null });
    assert.match(doubtsAbout(refused).join(' '), /gave no quote/);

    // Without a minimum of its own, the counterparty has no opinion to hold the quote against.
    const silent = sound();
    Object.assign(silent, { quoteE18: null });
    assert.deepEqual(doubtsAbout(silent), []);
});

test('the minimum rate reads a decimal as B per A and a bare integer as already scaled', () => {
    assert.equal(minRateFromEnv('1.95'), 1950000000000000000n);
    assert.equal(minRateFromEnv('1950000000000000000'), 1950000000000000000n);
    assert.equal(minRateFromEnv(undefined), null);
    assert.equal(minRateFromEnv(''), null);
});

test('paying is a separate decision from declining, and only follows a clean bill', () => {
    assert.equal(shouldPay(['anything']).pay, false, 'a doubt is a free refusal; buying an answer after it is spending on a closed question');
    assert.equal(shouldPay(['anything'], { paranoid: true }).pay, false, 'even --paranoid does not buy an answer to a position already declined');
    assert.equal(shouldPay([], { ageSeconds: 86400 }).pay, false, 'a grant that has been standing needs no identity check');
    assert.equal(shouldPay([], { ageSeconds: null }).pay, false, 'no publication age at all is not "fresh"');
    assert.equal(shouldPay([], { ageSeconds: 60 }).pay, true, 'terms written a minute ago are worth a tenth of a cent');
    assert.equal(shouldPay([], { ageSeconds: 86400, paranoid: true }).pay, true);
    assert.equal(shouldPay([], { ageSeconds: 60 }, { ...POLICY, freshPublicationSeconds: 30 }).pay, false, 'the bar is the counterparty\'s to set');
});
