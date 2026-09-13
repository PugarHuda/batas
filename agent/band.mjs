// A banded, two-sided Aqua position under one mandate.
//
// The live position is one constant-product pair with one PolicyEnvelope, and an envelope carries
// one direction, so it only ever sells A. This builds the position a market maker would actually
// run, out of instructions the deployed BatasRouter already dispatches — nothing here needs a new
// contract:
//
//   JumpIfTokenIn(B) → side 2
//   side 1, A in:  PolicyEnvelope(cap A, floor B/A, aToB) · Deadline · Decay · FeeFlatIn · XYCConcentrate · Jump(end)
//   side 2, B in:  PolicyEnvelope(cap B, floor A/B, bToA) · Deadline · Decay · FeeFlatIn · XYCConcentrate · Salt
//
// XYCConcentrate puts the whole reserve inside one price band, so the same tokens quote far deeper
// than x*y=k near spot and run out at the band's edges. Decay makes an immediate counter-trade
// worse, a spread that fades over its period, so a taker cannot round-trip the maker's own depth.
// Each side's envelope bounds what that side may settle, so a floor exists in both directions.
//
// The arithmetic below mirrors the Solidity instruction for instruction, rounding included, so the
// fork test can say "the balances moved exactly as priced" rather than "roughly".

import { concat, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';

import {
    policyEnvelope, deadline, decay, feeFlatIn, xycConcentrate, jumpIfTokenIn, jump, salt, E18, BPS,
} from './swapvm.mjs';

// --- integer math, as OpenZeppelin's Math does it ----------------------------

/** Floor square root, which is what `Math.sqrt` returns. */
export const sqrt = (n) => {
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
};
const ceilDiv = (a, d) => (a + d - 1n) / d;

/** `XYCConcentrateSwap` takes square roots of 1e18 prices, so sqrt(p) is itself scaled by 1e18. */
export const sqrtPriceE18 = (priceE18) => sqrt(priceE18 * E18);

/** `XYCConcentrateSwap.computeLiquidity`, the positive root of the band's invariant. */
export function concentratedLiquidity(balanceA, balanceB, sqrtMin, sqrtMax) {
    const delta = sqrtMax - sqrtMin;
    const beta = (balanceA * sqrtMin) / E18 + (balanceB * E18) / sqrtMax;
    const fourAC = (4n * delta * (balanceA * balanceB)) / sqrtMax;
    return ((beta + sqrt(beta * beta + fourAC)) * sqrtMax) / (2n * delta);
}

/**
 * How much of each token a band at this spot actually holds, from what the maker has available.
 *
 * `computeLiquidityFromAmounts`, for a spot strictly inside the band. Shipping arbitrary amounts
 * would still work, but the curve would then read a different spot out of them than the one the
 * floors were struck against.
 */
export function bandDeposit({ availableA, availableB, spotE18, priceMinE18, priceMaxE18 }) {
    const sMin = sqrtPriceE18(priceMinE18);
    const sMax = sqrtPriceE18(priceMaxE18);
    const sSpot = sqrtPriceE18(spotE18);
    if (!(sMin < sSpot && sSpot < sMax)) throw new Error('spot must sit strictly inside the band');
    const fromA = (availableA * (sSpot * sMax)) / ((sMax - sSpot) * E18);
    const fromB = (availableB * E18) / (sSpot - sMin);
    const liquidity = fromA < fromB ? fromA : fromB;
    return {
        amountA: (liquidity * ((sMax - sSpot) * E18)) / (sSpot * sMax),
        amountB: (liquidity * (sSpot - sMin)) / E18,
    };
}

/** What a `Decay` offset recorded `elapsed` seconds ago still weighs: linear to zero over `period`. */
export const decayed = (offset, elapsed, period) =>
    (elapsed >= period ? 0n : (offset * BigInt(period - elapsed)) / BigInt(period));

/**
 * One exactIn swap through a side, priced as the router prices it.
 *
 * Decay first shifts the balances against the taker by whatever the last trades left behind, the
 * fee comes off the input, the concentrated curve prices the rest, and a fill that would drain the
 * band is cut back to what the band holds and the input recomputed, exactly as the instruction does.
 */
export function quoteExactIn({ balanceIn, balanceOut, amountIn, aToB, sqrtMin, sqrtMax, feeBps, offsetIn = 0n, offsetOut = 0n }) {
    const bIn = balanceIn + offsetIn;
    const bOut = balanceOut - offsetOut;
    const fee = ceilDiv(amountIn * BigInt(feeBps), BPS);
    const net = amountIn - fee;

    const liquidity = concentratedLiquidity(aToB ? bIn : bOut, aToB ? bOut : bIn, sqrtMin, sqrtMax);
    const vIn = bIn + (aToB ? ceilDiv(liquidity * E18, sqrtMax) : ceilDiv(liquidity * sqrtMin, E18));
    const vOut = bOut + (aToB ? (liquidity * sqrtMin) / E18 : (liquidity * E18) / sqrtMax);

    const amountOut = (net * vOut) / (vIn + net);
    if (amountOut <= bOut) return { amountIn, amountOut, partial: false };

    // Partial fill: the band is empty on the out side before the input is used up.
    const refilled = ceilDiv(bOut * vIn, vOut - bOut);
    const gross = refilled === net ? amountIn : refilled + ceilDiv(refilled * BigInt(feeBps), BPS - BigInt(feeBps));
    return { amountIn: gross, amountOut: bOut, partial: true };
}

// --- the program --------------------------------------------------------------

const bytes = (hex) => (hex.length - 2) / 2;

/**
 * Compile a band into the program that enforces it.
 *
 * `tokenA` must be Aqua's token0, because the concentrated curve prices B per A only in that order
 * and each envelope's direction bit is `tokenIn < tokenOut`. Both envelopes are required: a band
 * with one side unguarded is exactly the position this exists to replace.
 */
export function toBandProgram({ tokenA, tokenB, priceMinE18, priceMaxE18, aToB, bToA, expiry, feeBps, decayPeriod, salt: saltValue }) {
    if (!(BigInt(tokenA) < BigInt(tokenB))) throw new Error('tokenA must sort below tokenB, as Aqua stores the pair');
    if (!aToB || !bToA) throw new Error('a band needs terms for both directions');
    const curve = xycConcentrate(sqrtPriceE18(priceMinE18), sqrtPriceE18(priceMaxE18));
    const side = (terms, direction) => [
        policyEnvelope(terms.maxAmountIn, terms.minRateE18, direction),
        deadline(expiry),
        // Decay outside the fee, so the offsets it records are the gross amounts that moved.
        decay(decayPeriod),
        feeFlatIn(feeBps),
        curve,
    ];
    const sideA = side(aToB, true);
    const sideB = [...side(bToA, false), salt(saltValue)];

    // Offsets are fixed-width, so they can be laid out before the bytes exist.
    const size = (parts) => parts.reduce((n, p) => n + bytes(p), 0);
    const sideBAt = bytes(jumpIfTokenIn(tokenB, 0)) + size(sideA) + bytes(jump(0));
    const end = sideBAt + size(sideB);
    return concat([jumpIfTokenIn(tokenB, sideBAt), ...sideA, jump(end), ...sideB]);
}

// --- order, ship, swap ---------------------------------------------------------

// The same MakerTraits batas-agent.mjs ships the live position with: the Aqua flag, and four
// order-data offsets of 40 because `data` starts with the two token addresses.
const TRAITS = (1n << 254n) | (0x0028002800280028n << 160n);

export const bandOrder = (maker, tokenA, tokenB, program) => ({ maker, traits: TRAITS, data: concat([tokenA, tokenB, program]) });

/** In Aqua mode the shipped strategy is the ABI-encoded order, and its keccak is the strategy hash. */
export const encodeOrder = (order) =>
    encodeAbiParameters(parseAbiParameters('(address maker, uint256 traits, bytes data)'), [order]);
export const strategyHash = (order) => keccak256(encodeOrder(order));

/**
 * exactIn, taker pays first through the router's transferFrom-and-Aqua-push, no threshold, no hooks.
 * The same packing counterparty.mjs uses, with the aToB bit (0x80) chosen per trade.
 */
export const takerData = (aToB) => `0x${'00'.repeat(20)}${aToB ? '00e1' : '0061'}`;

const ORDER = {
    name: 'order', type: 'tuple',
    components: [{ name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' }],
};

export const ROUTER_ABI = [
    { name: 'hash', type: 'function', stateMutability: 'view', inputs: [ORDER], outputs: [{ type: 'bytes32' }] },
    {
        name: 'swap', type: 'function', stateMutability: 'payable',
        inputs: [ORDER, { name: 'amount', type: 'uint256' }, { name: 'takerData', type: 'bytes' }],
        outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
    },
    // The refusals worth naming, so a reverted simulation says which term refused it.
    { type: 'error', name: 'MandateAmountInExceeded', inputs: [{ type: 'uint256' }, { type: 'uint256' }] },
    { type: 'error', name: 'MandateRateTooLow', inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] },
    { type: 'error', name: 'MandateDirectionMismatch', inputs: [] },
    { type: 'error', name: 'DeadlineReached', inputs: [{ type: 'uint256' }] },
];

export const AQUA_ABI = [
    {
        name: 'ship', type: 'function', stateMutability: 'nonpayable',
        inputs: [
            { name: 'app', type: 'address' }, { name: 'strategy', type: 'bytes' },
            { name: 'tokens', type: 'address[]' }, { name: 'amounts', type: 'uint256[]' },
        ],
        outputs: [{ type: 'bytes32' }],
    },
    {
        name: 'safeBalances', type: 'function', stateMutability: 'view',
        inputs: [
            { name: 'maker', type: 'address' }, { name: 'app', type: 'address' },
            { name: 'strategyHash', type: 'bytes32' }, { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
        ],
        outputs: [{ type: 'uint256' }, { type: 'uint256' }],
    },
];

export const ERC20_ABI = [
    { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
    { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

/**
 * Ship a band to Aqua against the router, refusing if the router hashes the order differently.
 *
 * The hash check is the same one batas-agent.mjs makes before a live ship: if the local encoding
 * were wrong in any byte, the position would land under a hash nobody could find.
 */
export async function shipBand({ pub, wallet, aqua, router, order, tokens, amounts }) {
    const local = strategyHash(order);
    const chain = await pub.readContract({ address: router, abi: ROUTER_ABI, functionName: 'hash', args: [order] });
    if (local.toLowerCase() !== chain.toLowerCase()) throw new Error(`router hashes the band as ${chain}, locally ${local}; not shipping`);
    const hash = await wallet.writeContract({
        address: aqua, abi: AQUA_ABI, functionName: 'ship', args: [router, encodeOrder(order), tokens, amounts],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`ship reverted: ${hash}`);
    return { strategyHash: chain, tx: hash, gasUsed: receipt.gasUsed };
}
