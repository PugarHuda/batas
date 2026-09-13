// The band on Sepolia, read from the chain and nothing else.
//
//   node --test agent/band-live.test.mjs
//
// The fork test proves the band's mechanics against a copy of the chain. This one asks the chain
// itself about the band that was actually shipped: that the router hashes its order to the strategy
// Aqua holds, that both sides decode, that Aqua still answers for it, and that each recorded swap
// moved exactly the tokens band.mjs prices it at — repriced here from the ship amounts forward, with
// the Decay spread the earlier swap left, and checked against the tokens' own Transfer logs.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import { AQUA, ROUTER, OWNER, TOKENS, BAND_MAKER, BAND_STRATEGY_HASH } from './deployment.mjs';
import { ROUTER_ABI, AQUA_ABI, strategyHash } from './band.mjs';
import { pub, readBand, readSwap, reprice, recordedSwaps } from './band-live.mjs';

const [A, B] = TOKENS;
const lower = (x) => x.toLowerCase();

let band;
let swaps;

before(async () => {
    band = await readBand();
    swaps = reprice(band, await Promise.all(recordedSwaps().map((h) => readSwap(h))));
}, { timeout: 120_000 });

test('the band was shipped by its own maker, not by the live position\'s owner', () => {
    assert.equal(lower(band.maker), lower(BAND_MAKER));
    assert.notEqual(lower(band.maker), lower(OWNER), 'a band shipped by OWNER would become "the live position" to every reader');
    assert.equal(lower(band.order.maker), lower(band.maker));
    assert.equal(lower(band.app), lower(ROUTER));
    assert.deepEqual(band.tokens.map(lower), [A, B].map(lower));
});

test('the strategy hash is what the deployed router computes for the order', async () => {
    const onRouter = await pub.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'hash', args: [band.order] });
    assert.equal(lower(onRouter), lower(BAND_STRATEGY_HASH));
    assert.equal(lower(strategyHash(band.order)), lower(BAND_STRATEGY_HASH));
});

test('both sides decode, each under its own envelope and direction', () => {
    const { guarded, mandate } = band.decoded;
    assert.equal(guarded, true);
    assert.deepEqual(mandate.sides.map((s) => s.direction), ['aToB', 'bToA']);
    for (const s of mandate.sides) {
        assert.ok(BigInt(s.maxAmountIn) > 0n, `${s.direction} has a cap`);
        assert.ok(BigInt(s.minRateE18) > 0n, `${s.direction} has a floor`);
        assert.equal(s.curve, 'concentrated constant product');
        assert.ok(s.expiry > 0);
    }
});

test('Aqua still answers for the band', async () => {
    const [rA, rB] = await pub.readContract({
        address: AQUA, abi: AQUA_ABI, functionName: 'safeBalances', args: [band.maker, ROUTER, BAND_STRATEGY_HASH, A, B],
    });
    assert.ok(rA > 0n && rB > 0n, 'a docked or drained band reads as zero or reverts');
});

test('a recorded swap went each way, and every one moved exactly the quoted tokens', () => {
    assert.ok(swaps.some((s) => s.aToB) && swaps.some((s) => !s.aToB), 'one swap in each direction is recorded');
    for (const s of swaps) {
        assert.equal(s.status, 'success', s.tx);
        assert.equal(lower(s.order.maker), lower(band.maker), `${s.tx} traded a different order`);
        const [tin, tout] = (s.aToB ? [A, B] : [B, A]).map(lower);
        const taker = lower(s.taker);
        const maker = lower(band.maker);
        assert.equal(s.quote.partial, false, `${s.tx} was priced as a partial fill`);
        assert.equal(-s.net[tin][taker], s.quote.amountIn, `${s.tx}: taker paid`);
        assert.equal(s.net[tin][maker], s.quote.amountIn, `${s.tx}: maker received`);
        assert.equal(-s.net[tout][maker], s.quote.amountOut, `${s.tx}: maker paid`);
        assert.equal(s.net[tout][taker], s.quote.amountOut, `${s.tx}: taker received`);
    }
});
