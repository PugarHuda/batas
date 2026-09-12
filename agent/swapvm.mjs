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
    MANDATE_NAME: 0x22,
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

// Where this report starts remarking on terms that are present but permissive. Not protocol
// limits — SwapVM will run whatever is encoded — but the point at which a reader deciding whether
// to trade is better served by being told than by being left to do the arithmetic.
export const FEE_WORTH_MENTIONING = 500_000; // 5% of the 1e7 base

// How many instructions a report will list.
//
// A mandate is five. The decoder itself is fast — 60,000 instructions walk in 13ms — but listing
// them turns a 234KB request into a 2.7MB answer, an 11.8x amplification on a route someone pays a
// tenth of a cent to call. The terms below are still read from the whole program, so nothing is
// decided on a partial view; only the listing is bounded, and a truncated one says so.
export const MAX_LISTED_INSTRUCTIONS = 256;
export const LONG_TERM_MS = 365 * 24 * 60 * 60 * 1000;
/** Past this, a floor struck once at grant time has had time to stop describing the market. */
export const FLOOR_GOES_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** `Deadline` carries five bytes; the same ceiling MandateLib.toProgram refuses past. */
export const MAX_ENCODABLE_EXPIRY = 2 ** 40 - 1;
export const E18 = 10n ** 18n;

// --- encoding ---------------------------------------------------------------

export const instruction = (opcode, args = '0x') => {
    const body = args.slice(2);
    if (body.length % 2 !== 0) throw new Error('args must be whole bytes');
    const len = body.length / 2;
    if (len > 255) throw new Error(`args too long: ${len}`);
    return concat([toHex(opcode, { size: 1 }), toHex(len, { size: 1 }), args]);
};

/**
 * Cap, floor, and the direction the terms are denominated in.
 *
 * `direction` is `tokenIn < tokenOut` for the mandate's own tokens, packed the way `LimitSwap`
 * packs its bool: top bit of one byte. It is required, not defaulted — the envelope shipped without
 * it once, and a default of `true` would let a caller who forgot the tokens compile the same hole
 * back in with no error to notice.
 */
export const policyEnvelope = (maxAmountIn, minRateE18, direction) => {
    if (typeof direction !== 'boolean') throw new Error('policyEnvelope needs a direction: tokenIn < tokenOut');
    return instruction(OP.POLICY_ENVELOPE, concat([
        pad(toHex(maxAmountIn), { size: 16 }),
        pad(toHex(minRateE18), { size: 16 }),
        direction ? '0x80' : '0x00',
    ]));
};
export const deadline = (unixTs) => instruction(OP.DEADLINE, pad(toHex(unixTs), { size: 5 }));
export const feeFlatIn = (feeBps) => instruction(OP.FEE_FLAT_IN, pad(toHex(feeBps), { size: 3 }));
export const xycSwap = () => instruction(OP.XYC_SWAP);
export const salt = (value) => instruction(OP.SALT, pad(toHex(value), { size: 8 }));
/**
 * The kill switch, as bytes: [registry][holder][label length][label].
 *
 * Mirrors `MandateName.build` in Solidity. One byte carries the length, so a label past 255 cannot
 * be expressed and is refused rather than truncated — a program carrying half a label asks about a
 * different name, and a different name is a different grant.
 */
export const mandateName = (registry, holder, label) => {
    const bytes = new TextEncoder().encode(label);
    if (bytes.length > 255) throw new Error(`label is ${bytes.length} bytes; one length byte holds 255`);
    return instruction(OP.MANDATE_NAME, concat([
        pad(registry, { size: 20 }),
        pad(holder, { size: 20 }),
        toHex(bytes.length, { size: 1 }),
        `0x${Buffer.from(bytes).toString('hex')}`,
    ]));
};

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
export const toProgram = ({ maxAmountIn, minRateE18, expiry, feeBps, salt: saltValue, tokenIn, tokenOut, nameRegistry, nameHolder, nameLabel }) => {
    if (!tokenIn || !tokenOut) throw new Error('toProgram needs tokenIn and tokenOut; the direction is a term of the mandate');
    const direction = BigInt(tokenIn) < BigInt(tokenOut);
    // The same two refusals MandateLib.toProgram makes, for the same reason: a term the program
    // cannot carry must not be quietly turned into a different one. Without these, viem would
    // still refuse the oversized expiry — but as a padding error about byte widths, which sends a
    // reader looking at the encoder rather than at the mandate they wrote.
    if (BigInt(expiry) > BigInt(MAX_ENCODABLE_EXPIRY)) {
        throw new Error(`expiry ${expiry} is past ${MAX_ENCODABLE_EXPIRY}, the largest Deadline can carry`);
    }
    if (BigInt(feeBps) >= BPS) {
        throw new Error(`fee ${feeBps} takes the whole input; it must be under the ${BPS} basis`);
    }
    return concat([
        policyEnvelope(maxAmountIn, minRateE18, direction),
        deadline(expiry),
        // Same position as MandateLib puts it: after the deadline, so a lapsed mandate fails on
        // arithmetic before anything pays for three external calls, and before the curve.
        ...(nameRegistry && BigInt(nameRegistry) !== 0n
            ? [mandateName(nameRegistry, nameHolder, nameLabel ?? '')]
            : []),
        feeFlatIn(feeBps),
        xycSwap(),
        salt(saltValue),
    ]);
};

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
/**
 * How far this position's price has actually moved, in basis points.
 *
 * The floor was 2% because somebody typed 2%. That number decides what the mandate refuses, and a
 * constant nothing derives it from is the weakest part of an otherwise measured design — a floor
 * too tight refuses every real trade, and one too loose protects nothing.
 *
 * Be precise about what this measures, because the obvious reading is wrong. It is **not** market
 * volatility, and these rates are not mid-prices: each one is what a settled trade actually got,
 * which already includes the slippage that trade's own size caused. What it measures is the
 * realised gap between consecutive settlements at this position — how far the price has moved
 * between one trade and the next, in practice, including the moving done by the trades themselves.
 *
 * That happens to be the right quantity for this job. The floor has to survive the price walking
 * as it has actually walked here; a budget derived from anything smoother would be a floor that
 * binds in theory and breaks on the first ordinary day.
 *
 * The largest gap rather than an average, because a budget set to the typical move is a budget
 * that fails on the atypical one. With a handful of samples there is no percentile worth taking.
 */
export function volatilityBudget(rates, { minBps = 100n, maxBps = 1000n } = {}) {
    const clean = (rates ?? []).map((r) => BigInt(r)).filter((r) => r > 0n);
    if (clean.length < 2) {
        return { bps: minBps, samples: clean.length, reason: 'not enough settled trades to measure; using the floor' };
    }

    let worst = 0n;
    for (let i = 1; i < clean.length; i++) {
        const prev = clean[i - 1];
        const now = clean[i];
        const gap = now > prev ? now - prev : prev - now;
        const bps = (gap * 10_000n) / prev;
        if (bps > worst) worst = bps;
    }

    if (worst < minBps) {
        return { bps: minBps, samples: clean.length, observedBps: worst, reason: `moved ${worst}bps at most; holding the ${minBps}bps floor` };
    }
    if (worst > maxBps) {
        return { bps: maxBps, samples: clean.length, observedBps: worst, reason: `moved ${worst}bps, past the ${maxBps}bps ceiling` };
    }
    return { bps: worst, samples: clean.length, observedBps: worst, reason: `widest gap between settled trades was ${worst}bps` };
}

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
    const terms = { maxAmountIn: null, minRateE18: null, expiry: null, feeBps: null, curve: null, salt: null, name: null, direction: null };

    for (const ins of instructions) {
        switch (ins.opcode) {
            case OP.POLICY_ENVELOPE:
                // 33 bytes: cap, floor, and one byte of direction. A 32-byte envelope is the shape
                // this instruction shipped in before the direction was a term, and the router now
                // refuses it as truncated; so does this.
                if (ins.args.length !== 66) throw new Error('PolicyEnvelope must carry 33 arg bytes');
                terms.maxAmountIn = hexToBig(ins.args.slice(0, 32));
                terms.minRateE18 = hexToBig(ins.args.slice(32, 64));
                terms.direction = (parseInt(ins.args.slice(64, 66), 16) & 0x80) !== 0 ? 'aToB' : 'bToA';
                break;
            case OP.DEADLINE:
                terms.expiry = Number(hexToBig(ins.args));
                break;
            case OP.FEE_FLAT_IN:
                terms.feeBps = Number(hexToBig(ins.args));
                break;
            case OP.MANDATE_NAME: {
                // Refused rather than half-read, exactly as the instruction itself does. A short
                // one on chain reads its registry out of the next instruction's bytes; a short one
                // here would report a registry nobody named.
                const raw = ins.args;
                if (raw.length < 82) throw new Error('MandateName must carry at least 41 arg bytes');
                const len = parseInt(raw.slice(80, 82), 16);
                if (raw.length < 82 + len * 2) throw new Error('MandateName label runs past its arguments');
                terms.name = {
                    registry: `0x${raw.slice(0, 40)}`,
                    holder: `0x${raw.slice(40, 80)}`,
                    label: Buffer.from(raw.slice(82, 82 + len * 2), 'hex').toString('utf8'),
                };
                break;
            }
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
    if (t.expiry === null) {
        // The omission that reads as an absence rather than a fault: a program with no Deadline
        // decodes cleanly, prints no expiry, and grants authority that never ends. Both encoders
        // build one now, but a caller is being paid to be told what these bytes actually say, and
        // the most open-ended grant in the set must not be the one that goes unremarked.
        notes.push('No deadline: this mandate never expires and can only be ended by revoking it.');
    } else if ((t.expiry + 1) * 1000 <= Date.now()) {
        // Past the expiry second, not at it. SwapVM's Deadline is `block.timestamp <= deadline`
        // and BatasApp now matches it, so the whole of that second is still inside the grant and
        // a report that called it dead would be describing a different rule than the chain runs.
        notes.push('The deadline has already passed; this position authorises nothing.');
    }
    if (instructions.length > MAX_LISTED_INSTRUCTIONS) {
        notes.push(
            `This program has ${instructions.length} instructions; the first ${MAX_LISTED_INSTRUCTIONS} are `
            + 'listed. The terms below were read from all of them. A mandate is five instructions, so '
            + 'a stream this long is doing something other than granting one.',
        );
    }
    if (t.maxAmountIn === null) notes.push('No size cap: a single trade may consume the whole reserve.');
    if (t.minRateE18 === null) notes.push('No floor price: the position will settle at any rate the curve produces.');

    // Limits that are present but do not limit.
    //
    // Everything above answers "is this term missing". A term can also be there, decode cleanly,
    // and still leave the position open — and that is the harder thing to notice, because the
    // report looks complete. Both thresholds below are stated in the note rather than applied
    // silently, so a reader can disagree with where the line was drawn.
    if (t.feeBps !== null && t.feeBps > FEE_WORTH_MENTIONING) {
        const pct = (t.feeBps / Number(BPS)) * 100;
        notes.push(
            `The maker fee is ${pct}%, above the ${(FEE_WORTH_MENTIONING / Number(BPS)) * 100}% this `
            + 'report treats as ordinary. The fee is taken off the input before the curve prices it, '
            + 'so it reduces what the floor is measured against.',
        );
    }
    // The limit that is present, binds every trade, and still leaves the position open.
    //
    // minRateE18 is a number struck once, against the spot the reserves implied at grant time. It
    // bounds how far trading can walk *this position's* price — that is what the repeated-trading
    // test proves — and it says nothing about the price of the tokens anywhere else. The two are
    // the same thing on the day the mandate is written and drift apart afterwards, so the longer
    // the term, the less the floor is protecting. A caller deciding whether to trust a position
    // has to be told which of the two it was sold.
    if (t.minRateE18 !== null && t.expiry !== null && t.expiry * 1000 > Date.now() + FLOOR_GOES_STALE_MS) {
        const days = Math.round((t.expiry * 1000 - Date.now()) / 86_400_000);
        notes.push(
            `The floor is a fixed rate chosen when this mandate was granted, not a reading of any `
            + `market, and the mandate has ${days} days left — past the `
            + `${FLOOR_GOES_STALE_MS / 86_400_000} days this report treats as short. It bounds how far `
            + `trading can walk this position's own price. If the market moves under it, trades that `
            + `empty the position at a rate the maker would no longer accept still satisfy the mandate.`,
        );
    }
    if (t.expiry !== null && t.expiry * 1000 > Date.now() + LONG_TERM_MS) {
        const days = Math.round((t.expiry * 1000 - Date.now()) / 86_400_000);
        notes.push(
            `The deadline is ${days} days away. It is a real expiry, but at that distance it bounds `
            + 'little in practice; revoking the grant is the control that still means something.',
        );
    }

    return {
        guarded,
        instructionCount: instructions.length,
        instructions: instructions
            .slice(0, MAX_LISTED_INSTRUCTIONS)
            .map((i) => ({ offset: i.offset, name: i.name, args: `0x${i.args}` })),
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
            // Which way the terms are denominated. The other direction is refused outright; a
            // report that showed a cap without saying which token it is a cap on would be showing
            // half a number.
            direction: t.direction,
            // Reported as a fact rather than remarked on.
            //
            // The notes above are for terms that are present and do not limit, and a reader could
            // argue a mandate with no on-chain kill switch belongs there. It does not: naming no
            // registry is a documented choice, not an oversight — such a grant still ends at its
            // expiry and the maker can still dock the position — and a note that fires on every
            // mandate teaches a reader to skip the notes.
            killSwitch: t.name,
        },
        notes,
    };
}
