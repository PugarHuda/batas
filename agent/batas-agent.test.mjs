// Tests for the agent's pure helpers: which settlements feed the floor, and when a live position
// has stopped honouring its own terms. Nothing here touches a network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ownSettlement, refusesOwnCap } from './batas-agent.mjs';
import { decideMandate, E18 } from './swapvm.mjs';
import { TOKENS } from './deployment.mjs';

const [A, B] = TOKENS;
const E = (n) => BigInt(n) * E18;
const MAKER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

test('only this maker, this direction, this pair feeds the volatility budget', () => {
    const base = { maker: MAKER, tokenIn: A, tokenOut: B, amountIn: E(1), amountOut: E(2) };
    assert.equal(ownSettlement(base, MAKER), 2n * E18);
    assert.equal(ownSettlement(base, MAKER.toUpperCase()), 2n * E18, 'address case is not identity');

    assert.equal(ownSettlement({ ...base, maker: OTHER }, MAKER), null, 'somebody else\'s trade');
    assert.equal(ownSettlement({ ...base, tokenIn: B, tokenOut: A }, MAKER), null, 'the other direction, in the other unit');
    // The contamination the review found: same maker, same tokenIn, a different pair.
    assert.equal(ownSettlement({ ...base, tokenOut: OTHER }, MAKER), null, 'an A/C position is not this market');
    assert.equal(ownSettlement({ ...base, amountIn: 0n }, MAKER), null, 'nothing in, no rate');
});

test('refusesOwnCap says no while a sliver of the cap still clears the floor', () => {
    const reserveA = E(1000);
    const reserveB = E(2000);
    const { maxAmountIn, minRateE18 } = decideMandate({ reserveA, reserveB, slippageBps: 100n });
    const live = { reserveA, reserveB, maxAmountIn, minRateE18, feeBps: 30_000 };
    assert.equal(refusesOwnCap(live), false);
    // Spot under the floor: every trade is refused, including one percent of the cap.
    assert.equal(refusesOwnCap({ ...live, reserveB: (reserveB * 97n) / 100n }), true);
    // Terms the strategy did not carry are not a verdict.
    assert.equal(refusesOwnCap({ ...live, maxAmountIn: null }), false);
    assert.equal(refusesOwnCap({ ...live, minRateE18: null }), false);
    assert.equal(refusesOwnCap(), false);
});
