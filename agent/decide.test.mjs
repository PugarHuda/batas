// Tests for the numbers the agent picks.
//
// This is the only part of the system where the agent exercises judgement rather than following a
// rule, so it is the part where a quiet mistake would look like a decision. The properties below
// are the ones that make a mandate mean anything: a floor under the price the position can
// actually reach, and a cap expressed against the depth it is bounding.

import test from 'node:test';
import assert from 'node:assert/strict';

import { decideMandate, clearsFloor, E18 } from './swapvm.mjs';

const E = (n) => BigInt(n) * E18;

test('spot is the ratio the reserves imply', () => {
    const { spotE18 } = decideMandate({ reserveA: E(1000), reserveB: E(2000) });
    assert.equal(spotE18, 2n * E18);
});

test('the floor sits one slippage budget under spot', () => {
    const { spotE18, minRateE18 } = decideMandate({
        reserveA: E(1000), reserveB: E(2000), slippageBps: 200n,
    });
    assert.equal(minRateE18, (spotE18 * 9800n) / 10_000n);
    assert.ok(minRateE18 < spotE18, 'a floor at or above spot refuses every trade');
});

test('a zero slippage budget puts the floor exactly at spot', () => {
    const { spotE18, minRateE18 } = decideMandate({
        reserveA: E(1000), reserveB: E(2000), slippageBps: 0n,
    });
    assert.equal(minRateE18, spotE18);
});

test('the cap scales with depth, because price impact does', () => {
    const shallow = decideMandate({ reserveA: E(100), reserveB: E(200) });
    const deep = decideMandate({ reserveA: E(10_000), reserveB: E(20_000) });

    // Same spot, same slippage budget, hundredfold difference in absolute cap. What bounds damage
    // is how far one trade walks the price, which is a ratio to depth rather than a number.
    assert.equal(shallow.spotE18, deep.spotE18);
    // Within a hair: integer division leaves a few wei of remainder at each depth.
    const diff = deep.maxAmountIn - shallow.maxAmountIn * 100n;
    assert.ok(diff >= 0n && diff < 1000n, `expected a hundredfold cap, off by ${diff}`);
});

test('capBps can only lower the derived cap, never raise it', () => {
    const derived = decideMandate({ reserveA: E(1000), reserveB: E(2000), capBps: 10_000n });
    const clamped = decideMandate({ reserveA: E(1000), reserveB: E(2000), capBps: 10n });

    assert.ok(clamped.maxAmountIn < derived.maxAmountIn, 'a tighter ceiling must bind');
    assert.equal(clamped.maxAmountIn, E(1), '0.1% of a 1000 reserve');
});

test('a slippage budget no wider than the fee permits nothing', () => {
    // If the fee already eats the whole budget, no trade can clear the floor, and saying so is
    // more honest than publishing a cap that cannot be reached.
    const { maxAmountIn } = decideMandate({
        reserveA: E(1000), reserveB: E(2000), slippageBps: 3n, feeBps: 30_000n,
    });
    assert.equal(maxAmountIn, 0n);
});

test('the floor tracks the position rather than a fixed number', () => {
    const cheap = decideMandate({ reserveA: E(1000), reserveB: E(1000) });
    const dear = decideMandate({ reserveA: E(1000), reserveB: E(4000) });
    assert.ok(dear.minRateE18 > cheap.minRateE18, 'a richer position deserves a higher floor');
});

test('an empty side has no spot price and is refused', () => {
    assert.throws(() => decideMandate({ reserveA: 0n, reserveB: E(1) }), /empty side/);
    assert.throws(() => decideMandate({ reserveA: E(1), reserveB: 0n }), /empty side/);
});

test('a slippage budget of everything is not a floor', () => {
    assert.throws(
        () => decideMandate({ reserveA: E(1000), reserveB: E(2000), slippageBps: 10_000n }),
        /not a floor/,
    );
});

test('a cap larger than the reserve is refused', () => {
    assert.throws(
        () => decideMandate({ reserveA: E(1000), reserveB: E(2000), capBps: 10_001n }),
        /not a cap/,
    );
});

test('a ceiling of the whole reserve leaves the derived cap in charge', () => {
    // The slippage budget is the real constraint; capBps only ever tightens it further.
    const { maxAmountIn } = decideMandate({ reserveA: E(1000), reserveB: E(2000), capBps: 10_000n });
    assert.ok(maxAmountIn > 0n && maxAmountIn < E(1000), 'the floor binds long before the reserve does');
});

test('a trade at the cap still clears the floor at these defaults', () => {
    // 10% of the reserve against a 2% slippage budget: the constant product after a 0.3% fee has
    // to stay above the floor, or the defaults would produce mandates that refuse their own
    // maximum trade.
    const reserveA = E(1000);
    const reserveB = E(2000);
    const { maxAmountIn, minRateE18 } = decideMandate({ reserveA, reserveB });

    assert.ok(
        clearsFloor({ reserveA, reserveB, amountIn: maxAmountIn, minRateE18 }),
        'the default cap and floor must not contradict each other',
    );

    // And one wei past the cap must not clear it, or the cap is leaving room on the table.
    assert.ok(
        !clearsFloor({ reserveA, reserveB, amountIn: maxAmountIn + E(1), minRateE18 }),
        'a trade well past the cap must fail the floor',
    );
});

test('rounding never lands the floor above spot', () => {
    // Awkward reserves, where integer division has somewhere to go wrong.
    for (const [a, b] of [[3n, 7n], [1n, 1n], [999_999n, 1_000_001n], [E(1) + 1n, E(3) - 1n]]) {
        const { spotE18, minRateE18 } = decideMandate({ reserveA: a, reserveB: b });
        assert.ok(minRateE18 <= spotE18, `floor above spot for reserves ${a}/${b}`);
    }
});

test('a position too small to price gets a cap of nothing, not a cap that lies', () => {
    // Under a millionth of a token per side, integer arithmetic cannot express a trade that clears
    // its own floor. Zero is the honest answer; a number that the floor would refuse is not.
    const { maxAmountIn, minRateE18 } = decideMandate({ reserveA: 999_999n, reserveB: 1_000_001n });
    assert.equal(maxAmountIn, 0n);
    assert.ok(minRateE18 > 0n, 'the floor is still well defined');
});

test('whatever cap comes back always clears its own floor', () => {
    const sizes = [1n, 1000n, 999_999n, E(1), E(1000), E(1_000_000)];
    for (const a of sizes) {
        for (const mul of [1n, 2n, 7n]) {
            const reserveA = a;
            const reserveB = a * mul;
            const { maxAmountIn, minRateE18 } = decideMandate({ reserveA, reserveB });
            if (maxAmountIn === 0n) continue;
            assert.ok(
                clearsFloor({ reserveA, reserveB, amountIn: maxAmountIn, minRateE18 }),
                `cap ${maxAmountIn} fails its floor at reserves ${reserveA}/${reserveB}`,
            );
        }
    }
});

// --- when to renew, which is the only thing the watch acts on ------------------

test('a mandate with time left is left alone', async () => {
    const { renewalDecision } = await import('./batas-agent.mjs');
    const now = 1_789_000_000;
    const d = renewalDecision({ expiry: now + 10 * 3600, now, renewBeforeSeconds: 3600 });
    assert.equal(d.act, false);
    assert.match(d.reason, /10h left/);
});

test('a mandate inside the renewal window is renewed, and says by how much', async () => {
    const { renewalDecision } = await import('./batas-agent.mjs');
    const now = 1_789_000_000;
    const d = renewalDecision({ expiry: now + 600, now, renewBeforeSeconds: 3600 });
    assert.equal(d.act, true);
    assert.match(d.reason, /600s left/);
});

test('the window is a boundary, not a range', async () => {
    const { renewalDecision } = await import('./batas-agent.mjs');
    const now = 1_789_000_000;
    assert.equal(renewalDecision({ expiry: now + 3600, now, renewBeforeSeconds: 3600 }).act, true);
    assert.equal(renewalDecision({ expiry: now + 3601, now, renewBeforeSeconds: 3600 }).act, false);
});

test('an expired mandate is renewed and reported as expired, not as nearly expired', async () => {
    const { renewalDecision } = await import('./batas-agent.mjs');
    const now = 1_789_000_000;
    const d = renewalDecision({ expiry: now - 120, now, renewBeforeSeconds: 3600 });
    assert.equal(d.act, true);
    assert.match(d.reason, /expired 120s ago/);
});

test('a live mandate with no deadline at all is replaced with one that has', async () => {
    // The shape the project has already been bitten by: a program that decodes cleanly, grants
    // authority, and never ends. A watch that read "no expiry" as "not due yet" would keep it
    // alive forever, which is the opposite of what the field is for.
    const { renewalDecision } = await import('./batas-agent.mjs');
    for (const expiry of [null, undefined]) {
        const d = renewalDecision({ expiry, now: 1_789_000_000 });
        assert.equal(d.act, true, `expiry ${expiry} must be acted on`);
        assert.match(d.reason, /carries no deadline/);
    }
});
