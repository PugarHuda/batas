// Encoding and decoding of SwapVM programs.
//
// A program is a flat instruction stream: [opcode: 1 byte][args length: 1 byte][args: N bytes].
// Encoding it is how the agent proposes a mandate; decoding it is how anyone else can find out
// what a live position actually enforces, since the terms exist only as bytecode on chain.

import { concat, pad, toHex, formatUnits } from 'viem';

// From @1inch/swap-vm/src/libs/OpcodeList.sol. Slot 0x21 is ours, taken from the free `_Ix` range
// that OpcodeList reserves per family bank; it sits in the 0x20-0x3f conditions and guards bank.
export const OP = {
    STOP: 0x00,
    REVERT: 0x01,
    SALT: 0x02,
    JUMP: 0x03,
    EXTRUCTION: 0x04,
    DEADLINE: 0x20,
    POLICY_ENVELOPE: 0x21,
    ONLY_TAKER_BALANCE_NONZERO: 0x23,
    ONLY_TAKER_BALANCE_GTE: 0x24,
    ONLY_TAKER_SUPPLY_SHARE_GTE: 0x25,
    ONLY_TX_ORIGIN_BALANCE_NONZERO: 0x26,
    XYC_SWAP: 0x50,
    XYC_CONCENTRATE_SWAP: 0x51,
    PEGGED_SWAP: 0x58,
    FEE_FLAT_IN: 0x70,
    FEE_PROTOCOL: 0x80,
    DECAY: 0x9c,
};

const NAMES = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

export const BPS = 10_000_000n; // SwapVM fee base, 1e7
export const E18 = 10n ** 18n;

// --- encoding ---------------------------------------------------------------

export const instruction = (opcode, args = '0x') => {
    const body = args.slice(2);
    if (body.length % 2 !== 0) throw new Error('args must be whole bytes');
    const len = body.length / 2;
    if (len > 255) throw new Error(`args too long: ${len}`);
    return concat([toHex(opcode, { size: 1 }), toHex(len, { size: 1 }), args]);
};

export const policyEnvelope = (maxAmountIn, minRateE18) =>
    instruction(OP.POLICY_ENVELOPE, concat([pad(toHex(maxAmountIn), { size: 16 }), pad(toHex(minRateE18), { size: 16 })]));
export const deadline = (unixTs) => instruction(OP.DEADLINE, pad(toHex(unixTs), { size: 5 }));
export const feeFlatIn = (feeBps) => instruction(OP.FEE_FLAT_IN, pad(toHex(feeBps), { size: 3 }));
export const xycSwap = () => instruction(OP.XYC_SWAP);
export const salt = (value) => instruction(OP.SALT, pad(toHex(value), { size: 8 }));

/**
 * Compile a mandate into the program that enforces it.
 *
 * This mirrors `MandateLib.toProgram` in Solidity instruction for instruction, and
 * `encoder-parity.test.mjs` asserts the two produce identical bytes for a fixed set of mandates.
 * Two encoders for one format is exactly where a divergence hides quietly: a program is just
 * bytes, so nothing on chain would object to an agent shipping something the project's own
 * compiler would never emit.
 *
 * Order is deliberate and matches the Solidity side: PolicyEnvelope first so it wraps everything
 * after it, Deadline for the expiry term, then the fee ahead of the curve so the swap prices the
 * amount actually being exchanged, then Salt so identical terms can be shipped again.
 */
export const toProgram = ({ maxAmountIn, minRateE18, expiry, feeBps, salt: saltValue }) =>
    concat([
        policyEnvelope(maxAmountIn, minRateE18),
        deadline(expiry),
        feeFlatIn(feeBps),
        xycSwap(),
        salt(saltValue),
    ]);

// --- the decision ------------------------------------------------------------

/**
 * Turn observed reserves into mandate terms.
 *
 * Kept pure and here rather than inline in the agent so the numbers can be argued with. Two
 * choices are worth stating because neither is obvious:
 *
 * The floor sits one slippage budget under the spot the reserves imply, not under some external
 * price. A mandate is a promise about this position, and the position is the only thing that can
 * break it.
 *
 * The cap is a slice of the *input* reserve rather than a round number, because what actually
 * bounds damage is how far one trade can walk the price, and that is a ratio to the reserve.
 * A fixed cap means something different at every depth.
 */
export function decideMandate({ reserveA, reserveB, slippageBps = 200n, capBps = 1000n, feeBps = 30_000n }) {
    if (reserveA <= 0n || reserveB <= 0n) throw new Error('a position with an empty side has no spot price');
    if (slippageBps >= 10_000n) throw new Error('a slippage budget of 100% is not a floor');
    if (capBps > 10_000n) throw new Error('a cap above the whole reserve is not a cap');

    const spotE18 = (reserveB * E18) / reserveA;
    const minRateE18 = (spotE18 * (10_000n - slippageBps)) / 10_000n;

    // The cap is derived from the floor rather than chosen beside it.
    //
    // On a constant product curve the price a trade gets falls as the trade grows, so a floor and
    // a size cap are not independent: past a certain size no trade can clear the floor. Picking
    // both by hand produced a mandate whose stated maximum its own floor refused — a cap that
    // could never bind, which is worse than no cap because it reads like a limit.
    //
    // Solving amountOut/amountIn >= minRate for the constant product after a flat input fee gives
    //   net <= A * (slippage - fee) / (1 - slippage)
    // and the gross input is that net grossed back up by the fee.
    const S = 10_000_000n; // work in the fee's 1e7 basis so both rates share one scale
    const slip = slippageBps * 1000n; // basis points to 1e7
    const fee = feeBps;

    let maxAmountIn = 0n;
    if (slip > fee) {
        const net = (reserveA * (slip - fee)) / (S - slip);
        maxAmountIn = (net * S) / (S - fee);
    }

    // capBps is a ceiling the operator can impose on top, never a way to raise the derived one.
    const ceiling = (reserveA * capBps) / 10_000n;
    if (maxAmountIn > ceiling) maxAmountIn = ceiling;

    // The closed form is exact over the rationals. On chain every step rounds toward the maker, so
    // the trade it names sits exactly on the floor and lands a hair under it once rounded — the
    // cap is a boundary case by construction.
    //
    // Stepping down by wei does not help: shrinking the input shrinks the output in step, so both
    // sides of the inequality move together and the comparison never flips. The haircut has to be
    // relative. A part in a million is far below any size that matters and comfortably above the
    // rounding, and the loop verifies against the same arithmetic the contracts use rather than
    // trusting that claim.
    for (let i = 0; i < 32 && maxAmountIn > 0n; i++) {
        if (clearsFloor({ reserveA, reserveB, amountIn: maxAmountIn, minRateE18, feeBps })) break;
        // At dust sizes a proportional cut rounds to nothing, so the step is at least a wei and the
        // loop always makes progress toward zero.
        const cut = (maxAmountIn * 999_999n) / 1_000_000n;
        maxAmountIn = cut < maxAmountIn ? cut : maxAmountIn - 1n;
    }

    // A position too small for the arithmetic to price gets a cap of zero, which is the honest
    // answer: no size clears the floor at this depth. A mandate that permits nothing is safe; one
    // that names a maximum its own floor would refuse is not.
    if (!clearsFloor({ reserveA, reserveB, amountIn: maxAmountIn, minRateE18, feeBps })) maxAmountIn = 0n;

    return { spotE18, minRateE18, maxAmountIn };
}

/**
 * Would this trade clear the floor, priced exactly as the contracts price it?
 *
 * Mirrors FeeFlatIn wrapping XYCSwap, rounding the fee up and the output down, both toward the
 * maker, the way MandateLib.quoteExactIn does in Solidity.
 */
export function clearsFloor({ reserveA, reserveB, amountIn, minRateE18, feeBps = 30_000n }) {
    if (amountIn <= 0n) return false;
    const fee = (amountIn * feeBps + 9_999_999n) / 10_000_000n;
    const net = amountIn - fee;
    if (net <= 0n) return false;
    const amountOut = (net * reserveB) / (reserveA + net);
    return amountOut * E18 >= amountIn * minRateE18;
}

// --- decoding ---------------------------------------------------------------

const hexToBig = (hex) => (hex.length === 0 ? 0n : BigInt('0x' + hex));

/**
 * Walk an instruction stream. Throws on a truncated program rather than guessing, because a
 * length prefix that runs past the end means the bytes are not a valid program at all.
 */
export function decodeProgram(program) {
    const body = program.replace(/^0x/, '');
    if (body.length % 2 !== 0) throw new Error('program is not whole bytes');

    const out = [];
    let i = 0;
    while (i < body.length) {
        if (i + 4 > body.length) throw new Error(`truncated instruction header at byte ${i / 2}`);
        const opcode = parseInt(body.slice(i, i + 2), 16);
        const len = parseInt(body.slice(i + 2, i + 4), 16);
        const argsStart = i + 4;
        const argsEnd = argsStart + len * 2;
        if (argsEnd > body.length) {
            throw new Error(`instruction at byte ${i / 2} claims ${len} arg bytes but only ${(body.length - argsStart) / 2} remain`);
        }
        out.push({
            offset: i / 2,
            opcode,
            name: NAMES[opcode] ?? `UNKNOWN_0x${opcode.toString(16).padStart(2, '0')}`,
            args: body.slice(argsStart, argsEnd),
        });
        i = argsEnd;
    }
    return out;
}

/**
 * Pull the enforced terms out of a decoded stream. Anything the program does not carry comes back
 * null rather than as a default, because "no cap" and "a cap of zero" are very different claims.
 */
export function readMandate(instructions) {
    const terms = { maxAmountIn: null, minRateE18: null, expiry: null, feeBps: null, curve: null, salt: null };

    for (const ins of instructions) {
        switch (ins.opcode) {
            case OP.POLICY_ENVELOPE:
                if (ins.args.length !== 64) throw new Error('PolicyEnvelope must carry 32 arg bytes');
                terms.maxAmountIn = hexToBig(ins.args.slice(0, 32));
                terms.minRateE18 = hexToBig(ins.args.slice(32, 64));
                break;
            case OP.DEADLINE:
                terms.expiry = Number(hexToBig(ins.args));
                break;
            case OP.FEE_FLAT_IN:
                terms.feeBps = Number(hexToBig(ins.args));
                break;
            case OP.SALT:
                terms.salt = hexToBig(ins.args).toString();
                break;
            case OP.XYC_SWAP:
                terms.curve = 'constant product (x*y=k)';
                break;
            case OP.XYC_CONCENTRATE_SWAP:
                terms.curve = 'concentrated constant product';
                break;
            case OP.PEGGED_SWAP:
                terms.curve = 'pegged / stable curve';
                break;
            default:
                break;
        }
    }
    return terms;
}

/** Plain-language reading of what a position will and will not do. */
export function explain(program) {
    const instructions = decodeProgram(program);
    const t = readMandate(instructions);

    const guarded = instructions.length > 0 && instructions[0].opcode === OP.POLICY_ENVELOPE;
    const notes = [];

    if (!guarded) {
        notes.push(
            'No PolicyEnvelope in the outermost position. Any limits later in this program can be '
            + 'undone by instructions that run after them, so treat the position as unbounded.',
        );
    }
    if (t.expiry !== null && t.expiry * 1000 < Date.now()) {
        notes.push('The deadline has already passed; this position authorises nothing.');
    }
    if (t.maxAmountIn === null) notes.push('No size cap: a single trade may consume the whole reserve.');
    if (t.minRateE18 === null) notes.push('No floor price: the position will settle at any rate the curve produces.');

    return {
        guarded,
        instructions: instructions.map((i) => ({ offset: i.offset, name: i.name, args: `0x${i.args}` })),
        mandate: {
            maxAmountIn: t.maxAmountIn?.toString() ?? null,
            maxAmountInFormatted: t.maxAmountIn === null ? null : formatUnits(t.maxAmountIn, 18),
            minRateE18: t.minRateE18?.toString() ?? null,
            minRateFormatted: t.minRateE18 === null ? null : formatUnits(t.minRateE18, 18),
            expiry: t.expiry,
            expiryISO: t.expiry === null ? null : new Date(t.expiry * 1000).toISOString(),
            feeBps: t.feeBps,
            feePercent: t.feeBps === null ? null : (t.feeBps / Number(BPS)) * 100,
            curve: t.curve,
            salt: t.salt,
        },
        notes,
    };
}
