// The morning report: is the live position still inside its mandate, and how much room is left.
//
// Everything the other free routes answer is a fact about the terms. This one is about the terms
// against the market the position is actually in — how far spot has drifted since the floor was
// struck, what one cap-sized trade could take, whether the name that gates it still holds — joined
// into a single status with a reason for every alert. `deriveHealth` is pure so the arithmetic can
// be pinned by test; `healthAnswer` only gathers.

import { createPublicClient, http, formatUnits, decodeFunctionData, getAddress } from 'viem';
import { sepolia } from 'viem/chains';

import { explain, BPS, E18 } from './swapvm.mjs';
import { liveProgram } from './free.mjs';
import { mandateNameStatus } from './ens.mjs';
import { lookupMandate, lookupRevocations, lookupNameGrants } from './hcs.mjs';
import { readReputation } from './reputation.mjs';
import {
    AQUA, ROUTER, OWNER, TOKENS, ENS_REGISTRY, MANDATE_NAME, HCS_TOPIC, AGENT_ID, SEPOLIA_RPC,
} from './deployment.mjs';

const [TOKEN_A, TOKEN_B] = TOKENS;
const SEVERITY = { ok: 0, info: 1, warn: 2, critical: 3 };
const iso = (unix) => (unix == null ? null : new Date(Number(unix) * 1000).toISOString());
const fmt = (wei) => (wei == null ? null : formatUnits(wei, 18));
/** Basis points of `num` over `den`, to two decimals, as a plain number. */
const bps = (num, den) => (den === 0n ? null : Number((num * 1_000_000n) / den) / 100);

function isqrt(n) {
    if (n < 2n) return n;
    let x = n, y = (n >> 1n) + 1n;
    while (y < x) { x = y; y = (x + n / x) >> 1n; }
    return x;
}

// --- the arithmetic ----------------------------------------------------------

/**
 * `terms` are BigInt/number as `readMandate` gives them; `reservesNow` is null when Aqua says the
 * strategy is docked; `trades` are this position's Swapped logs since the ship; the rest are the
 * other free answers, any of which may be null when its upstream did not answer.
 */
export function deriveHealth({ terms, reservesNow, reservesAtShip, trades = [], authority, ledger, reputation, now }) {
    const alerts = [];
    const alert = (code, severity, since, message) => alerts.push({ code, severity, since: iso(since), message });
    const floor = terms.minRateE18;
    const cap = terms.maxAmountIn;
    const fee = BigInt(terms.feeBps ?? 0);
    const lastTradeAt = trades.length ? trades[trades.length - 1].at : null;
    const changedAt = lastTradeAt ?? reservesAtShip?.at ?? null;

    const tradeRows = trades.map((t) => {
        const rate = t.amountIn > 0n ? (t.amountOut * E18) / t.amountIn : 0n;
        return {
            block: Number(t.block), tx: t.tx, at: iso(t.at), taker: t.taker,
            amountIn: fmt(t.amountIn), amountOut: fmt(t.amountOut), rate: fmt(rate),
            bpsAboveFloor: floor ? bps(rate - floor, floor) : null,
            perTradeCapUtilisationPct: cap ? Number((t.amountIn * 10_000n) / cap) / 100 : null,
            selfTrade: !!t.taker && !!t.maker && t.taker.toLowerCase() === t.maker.toLowerCase(),
        };
    });

    let headroom = null;
    if (reservesNow && floor && reservesAtShip) {
        const { a, b } = reservesNow;
        const spotNow = (b * E18) / a;
        const spotAtGrant = (reservesAtShip.b * E18) / reservesAtShip.a;
        const marginal = (spotNow * (BPS - fee)) / BPS;
        // The net input after which the marginal rate spot·(1−fee) sits on the floor, solved from
        // the constant product: (A+x)² = A·B·(1−fee)/floor. Reported gross, as the taker pays it.
        const root = isqrt((a * b * (BPS - fee) * E18) / (BPS * floor));
        const absorbNet = root > a ? root - a : 0n;
        const absorbable = (absorbNet * BPS) / (BPS - fee);
        // One trade at the cap, priced as the contracts price it (fee up, output down).
        const capFee = cap ? (cap * fee + BPS - 1n) / BPS : 0n;
        const capNet = cap ? cap - capFee : 0n;
        const worstOut = (capNet * b) / (a + capNet);

        headroom = {
            spotNow: fmt(spotNow),
            spotAtGrant: fmt(spotAtGrant),
            driftSinceGrantBps: bps(spotNow - spotAtGrant, spotAtGrant),
            spotVsFloorBps: bps(spotNow - floor, floor),
            marginalBps: bps(marginal - floor, floor),
            absorbableBeforeFloorA: fmt(absorbable),
            worstCaseOutflowB: fmt(worstOut),
            worstCaseOutflowPctB: Number((worstOut * 10_000n) / b) / 100,
            floorAgeHours: reservesAtShip.at == null ? null : Math.round(((now - reservesAtShip.at) / 3600) * 10) / 10,
        };

        if (headroom.marginalBps < 0) {
            alert('FLOOR_INVERTED', 'critical', changedAt, `spot after fee is ${headroom.marginalBps}bps under the floor; no trade clears the mandate`);
        } else if (headroom.marginalBps < 30) {
            alert('FLOOR_HEADROOM_LOW', 'warn', changedAt, `only ${headroom.marginalBps}bps between spot after fee and the floor`);
        }
        if (reservesAtShip.b > 0n) {
            const pct = Number((b * 10_000n) / reservesAtShip.b) / 100;
            if (pct < 95) alert('RESERVES_DOWN', 'warn', changedAt, `B reserve is ${pct}% of what was shipped`);
            else if (pct < 99) alert('RESERVES_DOWN', 'info', changedAt, `B reserve is ${pct}% of what was shipped`);
        }
    }

    tradeRows.forEach((t, i) => {
        if (t.bpsAboveFloor !== null && t.bpsAboveFloor < 20) {
            alert('TRADE_AT_FLOOR', 'info', trades[i].at, `trade ${t.tx} settled ${t.bpsAboveFloor}bps above the floor`);
        }
        if (t.selfTrade) alert('SELF_TRADE', 'info', trades[i].at, `trade ${t.tx} was taken by the maker`);
    });

    if (terms.expiry != null && terms.expiry - now < 86_400) {
        const left = terms.expiry - now;
        alert('EXPIRY_SOON', 'warn', terms.expiry - 86_400,
            left <= 0 ? `mandate expired at ${iso(terms.expiry)}` : `mandate expires in ${Math.round(left / 360) / 10}h`);
    }

    if (authority && !authority.error) {
        if (!authority.valid) {
            alert('NAME_INVALID', 'critical', authority.expiry || null, authority.reason);
        } else if (terms.expiry != null && authority.expiry < terms.expiry) {
            alert('NAME_SHORTER_THAN_MANDATE', 'warn', reservesAtShip?.at ?? null,
                `name ends ${iso(authority.expiry)}, mandate ${iso(terms.expiry)}`);
        }
    }

    if (ledger) {
        const pub = ledger.publication;
        if (pub && !pub.error && pub.published !== true) {
            alert('NOT_PUBLISHED', 'warn', reservesAtShip?.at ?? null, pub.reason ?? 'these bytes have no publication record on the topic');
        }
        // The ledger's last word on the label against the chain's. Records about a name come in
        // two kinds, and the newest one is the ledger's position: a revocation while the chain says
        // held, or a grant while the chain says revoked, is a re-grant or a revocation that happened
        // on chain without anyone telling the ledger. The mandate's own publication counts as a
        // floor for the revocation case — a withdrawal older than the mandate is about an earlier one.
        const newest = (rows) => rows[rows.length - 1];
        const at = (r) => (r?.consensusTimestamp ? Number(r.consensusTimestamp) : -Infinity);
        const since = (when) => (when ? Math.floor(Date.parse(when) / 1000) : null);
        const rev = newest(ledger.revocations?.revocations ?? []);
        const grant = newest(ledger.nameGrants?.nameGrants ?? []);
        if (rev && at(rev) > at(grant) && at(rev) > at(pub) && authority?.valid) {
            alert('LEDGER_DISAGREES', 'warn', since(rev.revokedAt),
                `last HCS record for "${rev.label}" is a revocation (#${rev.sequenceNumber}) but the chain says the name is held`);
        } else if (grant && at(grant) > at(rev) && authority?.revoked) {
            alert('LEDGER_DISAGREES', 'warn', since(grant.grantedAt),
                `last HCS record for "${grant.label}" is a grant (#${grant.sequenceNumber}) but the chain says the name is revoked`);
        }
    }

    if (reputation && !reputation.error && (reputation.breachedCount > 0 || BigInt(reputation.summaryValue ?? 0) < 0n)) {
        alert('FLOOR_BREACH_REPORTED', 'critical', null,
            `${reputation.breachedCount ?? '?'} feedback record(s) report a settlement under the floor`);
    }

    const worst = alerts.reduce((w, a) => (SEVERITY[a.severity] > SEVERITY[w] ? a.severity : w), 'ok');
    const status = reservesNow ? worst : 'docked';
    return { status, headroom, alerts, trades: tradeRows };
}

// --- the gathering -----------------------------------------------------------

const SHIP_ABI = [{
    name: 'ship', type: 'function', stateMutability: 'nonpayable',
    inputs: [
        { name: 'app', type: 'address' }, { name: 'strategy', type: 'bytes' },
        { name: 'tokens', type: 'address[]' }, { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [{ type: 'bytes32' }],
}];
const SAFE_BALANCES_ABI = [{
    name: 'safeBalances', type: 'function', stateMutability: 'view',
    inputs: [
        { name: 'maker', type: 'address' }, { name: 'app', type: 'address' },
        { name: 'strategyHash', type: 'bytes32' }, { name: 'token0', type: 'address' },
        { name: 'token1', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
}];
const SHIPPED = {
    type: 'event', name: 'Shipped',
    inputs: [
        { name: 'maker', type: 'address' }, { name: 'app', type: 'address' },
        { name: 'strategyHash', type: 'bytes32' }, { name: 'strategy', type: 'bytes' },
    ],
};
const SWAPPED = {
    type: 'event', name: 'Swapped',
    inputs: [
        { name: 'orderHash', type: 'bytes32' }, { name: 'maker', type: 'address' },
        { name: 'taker', type: 'address' }, { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' },
        { name: 'amountOut', type: 'uint256' },
    ],
};

// Neither event indexes anything, and public nodes refuse ranges past ~30,000 blocks.
const WINDOW = 9_000n;
const LOOKBACK = 60_000n;

async function scan(pub, { address, event, fromBlock, toBlock, keep }) {
    const out = [];
    for (let to = toBlock; to >= fromBlock; ) {
        const from = to - WINDOW > fromBlock ? to - WINDOW : fromBlock;
        const batch = await pub.getLogs({ address, event, fromBlock: from, toBlock: to });
        out.push(...batch.filter(keep));
        if (from === fromBlock) break;
        to = from - 1n;
    }
    return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : (x.blockNumber < y.blockNumber ? -1 : 1)));
}

const settled = (p) => p.then((value) => value, (e) => ({ error: String(e.shortMessage ?? e.message ?? e) }));

async function gather() {
    const pub = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
    const live = await liveProgram();
    if (!live) return { status: 'none', reason: 'no mandate has been shipped to the live router yet', headroom: null, alerts: [] };
    const { program, strategyHash } = live;
    const decoded = explain(program);
    const m = decoded.mandate;
    const terms = {
        maxAmountIn: m.maxAmountIn == null ? null : BigInt(m.maxAmountIn),
        minRateE18: m.minRateE18 == null ? null : BigInt(m.minRateE18),
        feeBps: m.feeBps, expiry: m.expiry,
    };

    const head = await pub.getBlockNumber();
    const wanted = strategyHash.toLowerCase();
    const [ship] = await scan(pub, {
        address: AQUA, event: SHIPPED, toBlock: head, fromBlock: head > LOOKBACK ? head - LOOKBACK : 0n,
        keep: (l) => l.args.strategyHash?.toLowerCase() === wanted,
    });
    if (!ship) throw new Error(`Shipped log for ${strategyHash} not in the last ${LOOKBACK} blocks`);

    const [tx, block, swaps, balances] = await Promise.all([
        pub.getTransaction({ hash: ship.transactionHash }),
        pub.getBlock({ blockNumber: ship.blockNumber }),
        scan(pub, {
            address: ROUTER, event: SWAPPED, fromBlock: ship.blockNumber, toBlock: head,
            keep: (l) => l.args.orderHash?.toLowerCase() === wanted,
        }),
        // A docked strategy reverts here rather than answering zero; that revert is the answer.
        pub.readContract({ address: AQUA, abi: SAFE_BALANCES_ABI, functionName: 'safeBalances', args: [OWNER, ROUTER, strategyHash, TOKEN_A, TOKEN_B] })
            .then(([a, b]) => ({ a, b }), () => null),
    ]);

    const { args: [, , tokens, amounts] } = decodeFunctionData({ abi: SHIP_ABI, data: tx.input });
    const shippedAmount = (token) => amounts[tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase())] ?? 0n;
    const reservesAtShip = {
        a: shippedAmount(TOKEN_A), b: shippedAmount(TOKEN_B),
        at: Number(block.timestamp), block: Number(ship.blockNumber), tx: ship.transactionHash,
    };

    // ponytail: one getBlock per trade block; a position with hundreds of fills wants a batch RPC.
    const stamps = new Map();
    for (const l of swaps) {
        if (!stamps.has(l.blockNumber)) stamps.set(l.blockNumber, pub.getBlock({ blockNumber: l.blockNumber }).then((b) => Number(b.timestamp), () => null));
    }
    const trades = await Promise.all(swaps.map(async (l) => ({
        block: l.blockNumber, tx: l.transactionHash, at: await stamps.get(l.blockNumber),
        taker: l.args.taker, maker: l.args.maker, amountIn: l.args.amountIn, amountOut: l.args.amountOut,
    })));

    const [authority, publication, revocations, nameGrants, reputation, breached] = await Promise.all([
        settled(mandateNameStatus(pub, getAddress(ENS_REGISTRY), MANDATE_NAME, getAddress(OWNER), { grantedUntil: terms.expiry ?? undefined })),
        settled(lookupMandate(HCS_TOPIC, program)),
        settled(lookupRevocations(HCS_TOPIC, MANDATE_NAME)),
        settled(lookupNameGrants(HCS_TOPIC, MANDATE_NAME)),
        settled(readReputation(AGENT_ID)),
        settled(readReputation(AGENT_ID, { tag2: 'floor-breached' })),
    ]);
    const rep = reputation.error ? reputation : { ...reputation, breachedCount: breached.error ? null : breached.feedbackCount };

    const now = Math.floor(Date.now() / 1000);
    const health = deriveHealth({
        terms, reservesNow: balances, reservesAtShip, trades, authority,
        ledger: { publication, revocations, nameGrants }, reputation: rep, now,
    });

    return {
        asOf: iso(now),
        status: health.status,
        headroom: health.headroom,
        alerts: health.alerts,
        position: {
            strategyHash, program, maker: OWNER, router: ROUTER, tokenA: TOKEN_A, tokenB: TOKEN_B,
            shippedAt: iso(reservesAtShip.at), shipBlock: reservesAtShip.block, shipTx: reservesAtShip.tx,
            reservesAtShip: { a: fmt(reservesAtShip.a), b: fmt(reservesAtShip.b) },
            reservesNow: balances ? { a: fmt(balances.a), b: fmt(balances.b) } : null,
            docked: balances === null,
        },
        terms: m,
        notes: decoded.notes,
        trades: health.trades,
        authority: { label: MANDATE_NAME, registry: ENS_REGISTRY, ...authority },
        ledger: { publication, revocations, nameGrants },
        reputation: rep,
        spend: null, // ponytail: Blockscout gas + mirror-node fee totals not wired yet
    };
}

/** Memoised the way `liveProgram` is, for the same reason: one page load, one scan. */
const TTL_MS = 60_000;
let cached = { at: 0, value: undefined, error: undefined };

export async function healthAnswer() {
    if (Date.now() - cached.at < TTL_MS) {
        if (cached.error) throw cached.error;
        if (cached.value !== undefined) return cached.value;
    }
    try {
        const value = await gather();
        cached = { at: Date.now(), value };
        return value;
    } catch (error) {
        cached = { at: Date.now(), error };
        throw error;
    }
}

export function forgetHealth() {
    cached = { at: 0 };
}
