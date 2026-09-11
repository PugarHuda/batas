// What a counterparty is entitled to say about an agent.
//
//   node --test agent/reputation.test.mjs
//
// The write is live by necessity and is not tested here; the arithmetic behind it is, because the
// number that goes on chain is the whole content of the record and a wrong one is worse than none.

import test from 'node:test';
import assert from 'node:assert/strict';

import { feedbackFromTrade, readReputation } from './reputation.mjs';

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

test('an agent nobody has reviewed reads as zero rather than as a failed call', async () => {
    // `getSummary` reverts on an empty client list, so the commonest state of any agent — nobody
    // has said anything — would reach every caller as an exception. It is answered instead.
    const noClients = {
        readContract: async ({ functionName }) => {
            if (functionName === 'getClients') return [];
            throw new Error('getSummary should not be called with no clients');
        },
    };
    const r = await readReputation('10123', { client: noClients });
    assert.equal(r.count, 0);
    assert.deepEqual(r.clients, []);
    assert.equal(r.summaryValue, '0');
});

test('and one with clients reports what they said', async () => {
    const withClients = {
        readContract: async ({ functionName }) => (functionName === 'getClients'
            ? ['0x1437aF5722D5Dfe6BAEda25f3A7A39aeCA374614']
            : [1n, 143n, 0]),
    };
    const r = await readReputation('10123', { client: withClients });
    assert.equal(r.count, 1);
    assert.equal(r.summaryValue, '143');
    assert.equal(r.clients.length, 1);
});
