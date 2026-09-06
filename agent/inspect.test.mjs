// Tests for recovering a program from the strategy bytes Aqua stored.
//
// This function used to count ABI words by hand and got it wrong: `abi.encode(Order)` opens with
// an offset word because `Order` has a dynamic member, and the hand-rolled version skipped it. The
// symptom was not a clean failure but "Cannot convert 0x to a BigInt" from deep inside the
// decoder, which is the kind of error that sends you looking in the wrong place.

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, parseAbiParameters, concat } from 'viem';

import { programFromStrategy } from './inspect.mjs';
import { toProgram } from './swapvm.mjs';

const TOKEN_A = '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B';
const TOKEN_B = '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81';
const MAKER = '0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E';
const TRAITS = (1n << 254n) | (0x0028002800280028n << 160n);

const strategyFor = (program) =>
    encodeAbiParameters(parseAbiParameters('(address maker, uint256 traits, bytes data)'), [
        { maker: MAKER, traits: TRAITS, data: concat([TOKEN_A, TOKEN_B, program]) },
    ]);

test('recovers the exact program that was shipped', () => {
    const program = toProgram({
        maxAmountIn: 101n * 10n ** 18n,
        minRateE18: 1921437329233482770n,
        expiry: 1788706874n,
        feeBps: 30000,
        salt: 1788698362n,
    });
    assert.equal(programFromStrategy(strategyFor(program)).toLowerCase(), program.toLowerCase());
});

test('works for a program of any length', () => {
    for (const salt of [0n, 1n, 2n ** 63n]) {
        const program = toProgram({ maxAmountIn: 1n, minRateE18: 1n, expiry: 1n, feeBps: 0, salt });
        assert.equal(programFromStrategy(strategyFor(program)).toLowerCase(), program.toLowerCase());
    }
});

test('an empty program round-trips as empty rather than as garbage', () => {
    assert.equal(programFromStrategy(strategyFor('0x')), '0x');
});

test('order data too short to hold two addresses is rejected', () => {
    const truncated = encodeAbiParameters(
        parseAbiParameters('(address maker, uint256 traits, bytes data)'),
        [{ maker: MAKER, traits: TRAITS, data: '0xdeadbeef' }],
    );
    assert.throws(() => programFromStrategy(truncated), /shorter than its two token addresses/);
});

test('the recovered program still decodes to the terms it was built from', async () => {
    const { explain } = await import('./swapvm.mjs');
    const expiry = 1788706874n;
    const program = toProgram({
        maxAmountIn: 500n * 10n ** 18n,
        minRateE18: 2n * 10n ** 18n,
        expiry,
        feeBps: 30000,
        salt: 7n,
    });

    const recovered = programFromStrategy(strategyFor(program));
    const r = explain(recovered);
    assert.equal(r.guarded, true);
    assert.equal(r.mandate.maxAmountInFormatted, '500');
    assert.equal(r.mandate.minRateFormatted, '2');
    assert.equal(r.mandate.expiry, Number(expiry));
});
