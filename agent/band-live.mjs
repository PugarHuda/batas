// The banded, two-sided position, live on Sepolia rather than on a fork.
//
//   node agent/band-live.mjs --status    read it back: hash, sides, reserves, recorded swaps
//   node agent/band-live.mjs --ship      build it around the live pool's spot and ship it
//   node agent/band-live.mjs --trade     one swap each way inside the band, then two refusals
//
// It is shipped by its own maker, BATAS_BAND_MAKER_KEY, and never by OWNER. Every reader of "the
// live position" filters Aqua's Shipped log by OWNER and the router, so a second maker on the same
// router and the same tokens sits beside the live position without any of those readers seeing it,
// and nothing here can change what they report.
//
// The tokens are real and there are few of them. TokenMock.mint is owner-only, so the band maker
// holds what the counterparty honestly had to send it — 1 A and 7.8 B — and the band is sized to
// that: about 1 A and 1.96 B of depth, caps half of each side's depth, as the fork test scales them.

import {
    createPublicClient, createWalletClient, http, formatUnits, formatEther, decodeFunctionData, decodeEventLog, parseAbiItem,
    decodeAbiParameters, parseAbiParameters, BaseError, ContractFunctionRevertedError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import * as D from './deployment.mjs';
import { explain, decodeProgram, OP, E18 } from './swapvm.mjs';
import { latestProgramOnChain, programFromStrategy } from './position.mjs';
import {
    toBandProgram, bandDeposit, bandOrder, shipBand, quoteExactIn, decayed, takerData, strategyHash,
    ROUTER_ABI, AQUA_ABI, ERC20_ABI,
} from './band.mjs';

const { AQUA, ROUTER, OWNER, TOKENS, SEPOLIA_RPC } = D;
const [A, B] = TOKENS;
const MAX = 2n ** 256n - 1n;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export const pub = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC, { timeout: 60_000 }) });

const fmt = (x) => formatUnits(x, 18);
const rate = (out, inn) => (out * E18) / inn;

// The taker's inventory and gas, sent by the band maker. B only: the taker's first trade buys the A
// its second trade sells, so no A has to leave the band maker's wallet for it to trade both ways.
const TAKER_B = 5n * E18 / 10n;
const TAKER_ETH = 12n * 10n ** 14n;
const TRADE_B_IN = 2n * E18 / 10n;
const TRADE_A_IN = 5n * E18 / 100n;

/**
 * The band's terms around a spot, in the fork test's proportions.
 *
 * Liquidity between 90% and 110% of spot; each floor 2% worse than spot in its own direction, so
 * both sit inside the band where they can bind before the curve runs dry. Caps are half the depth on
 * each side, which is what makes a trade under the cap and under the floor exist at all.
 */
export function bandTerms(spotE18) {
    return {
        priceMinE18: (spotE18 * 90n) / 100n,
        priceMaxE18: (spotE18 * 110n) / 100n,
        aToB: { maxAmountIn: 5n * E18 / 10n, minRateE18: (spotE18 * 98n) / 100n },
        bToA: { maxAmountIn: 1n * E18, minRateE18: ((E18 * E18) / spotE18) * 98n / 100n },
        feeBps: 30_000,
        decayPeriod: 600,
    };
}

/** Everything a stranger needs, rebuilt from the ship transaction alone: maker, order, amounts, curve. */
export async function readBand(shipTx = process.env.BATAS_BAND_SHIP_TX || D.BAND_SHIP_TX, client = pub) {
    if (!shipTx) throw new Error('no band recorded: set BATAS_BAND_SHIP_TX or run --ship');
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash: shipTx }), client.getTransactionReceipt({ hash: shipTx })]);
    if (receipt.status !== 'success') throw new Error(`ship ${shipTx} reverted`);
    const { functionName, args: [app, strategy, tokens, amounts] } = decodeFunctionData({ abi: AQUA_ABI, data: tx.input });
    if (functionName !== 'ship' || tx.to.toLowerCase() !== AQUA.toLowerCase()) throw new Error(`${shipTx} is not a ship to Aqua`);
    const [order] = decodeAbiParameters(parseAbiParameters('(address maker, uint256 traits, bytes data)'), strategy);
    const program = programFromStrategy(strategy);
    const decoded = explain(program);
    const curve = decodeProgram(program).find((i) => i.opcode === OP.XYC_CONCENTRATE_SWAP);
    return {
        shipTx, maker: tx.from, app, tokens, amounts, order, program, decoded,
        strategyHash: strategyHash(order),
        sqrtMin: BigInt(`0x${curve.args.slice(0, 64)}`),
        sqrtMax: BigInt(`0x${curve.args.slice(64, 128)}`),
        feeBps: decoded.mandate.sides[0].feeBps,
        decayPeriod: decoded.mandate.sides[0].decayPeriodSeconds,
        shipBlock: receipt.blockNumber,
    };
}

/** Net token movement per address in one receipt, from the tokens' own Transfer logs. */
export function flows(receipt) {
    const net = {};
    for (const log of receipt.logs) {
        if (!TOKENS.some((t) => t.toLowerCase() === log.address.toLowerCase())) continue;
        let ev;
        try {
            ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
        } catch {
            continue;
        }
        const t = (net[log.address.toLowerCase()] ??= {});
        const from = ev.args.from.toLowerCase();
        const to = ev.args.to.toLowerCase();
        t[from] = (t[from] ?? 0n) - ev.args.value;
        t[to] = (t[to] ?? 0n) + ev.args.value;
    }
    return net;
}

/** One settled swap as the chain recorded it: who, which way, how much in, and what actually moved. */
export async function readSwap(hash, client = pub) {
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    const { args: [order, amountIn, data] } = decodeFunctionData({ abi: ROUTER_ABI, data: tx.input });
    const { timestamp } = await client.getBlock({ blockNumber: receipt.blockNumber });
    return {
        tx: hash, status: receipt.status, taker: tx.from, order, amountIn,
        // The low flag byte of takerData; 0x80 is the aToB bit counterparty.mjs and band.mjs pack.
        aToB: (parseInt(data.slice(-2), 16) & 0x80) !== 0,
        timestamp: Number(timestamp), blockNumber: receipt.blockNumber, net: flows(receipt),
    };
}

/**
 * Price every recorded swap again from the ship amounts forward, as the router priced it.
 *
 * Decay is what makes this more than a quote: a swap that follows an opposite one inside the period
 * pays the spread the first one left, weighed by the seconds between their blocks.
 */
// ponytail: mirrors Decay for a swap following one opposite swap, as the fork test proves it. A band
// traded by someone else between recorded swaps, or twice one way inside a period, throws or
// misprices; record those swaps too, or extend the offset bookkeeping, if that ever happens.
export function reprice(band, swaps) {
    let [rA, rB] = band.amounts;
    const done = [];
    for (const s of swaps) {
        const prev = done[done.length - 1];
        const before = done[done.length - 2];
        let offsetIn = 0n;
        let offsetOut = 0n;
        if (prev && s.timestamp - prev.timestamp < band.decayPeriod) {
            if (prev.aToB === s.aToB || (before && s.timestamp - before.timestamp < band.decayPeriod)) {
                throw new Error(`${s.tx}: decay from more than one opposite swap is not mirrored here`);
            }
            offsetIn = decayed(prev.quote.amountOut, s.timestamp - prev.timestamp, band.decayPeriod);
            offsetOut = decayed(prev.quote.amountIn, s.timestamp - prev.timestamp, band.decayPeriod);
        }
        const quote = quoteExactIn({
            balanceIn: s.aToB ? rA : rB, balanceOut: s.aToB ? rB : rA, amountIn: s.amountIn, aToB: s.aToB,
            sqrtMin: band.sqrtMin, sqrtMax: band.sqrtMax, feeBps: band.feeBps, offsetIn, offsetOut,
        });
        if (s.aToB) { rA += quote.amountIn; rB -= quote.amountOut; } else { rB += quote.amountIn; rA -= quote.amountOut; }
        done.push({ ...s, quote });
    }
    return done;
}

const reserves = (band, client = pub) => client.readContract({
    address: AQUA, abi: AQUA_ABI, functionName: 'safeBalances', args: [band.maker, ROUTER, band.strategyHash, A, B],
});
const balanceOf = (token, who) => pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [who] });
// The environment first, as deployment.mjs's own defaults work, so a band on a fork can be read the same way.
export const recordedSwaps = () => (process.env.BATAS_BAND_SWAP_TXS || D.BAND_SWAP_TXS || '').split(',').filter(Boolean);

/** Why the router refuses a trade, by error name, from an eth_call. Null if it would settle. */
export async function refusal(order, aToB, amountIn, account) {
    try {
        await pub.simulateContract({ account, address: ROUTER, abi: ROUTER_ABI, functionName: 'swap', args: [order, amountIn, takerData(aToB)] });
    } catch (e) {
        const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
        if (reverted) return reverted.data?.errorName ?? reverted.shortMessage;
        throw e;
    }
    return null;
}

function key(name) {
    const k = process.env[name];
    if (!k) throw new Error(`${name} is not set`);
    return privateKeyToAccount(k);
}

async function send(wallet, request) {
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
    if (receipt.status !== 'success') throw new Error(`${request.functionName} reverted: ${hash}`);
    console.log(`  tx        ${request.functionName.padEnd(9)} ${hash}`);
    return hash;
}

async function ship() {
    const maker = key('BATAS_BAND_MAKER_KEY');
    if (maker.address.toLowerCase() === OWNER.toLowerCase()) throw new Error('the band maker must not be OWNER');
    const wallet = createWalletClient({ account: maker, chain: sepolia, transport: http(SEPOLIA_RPC, { timeout: 60_000 }) });

    // The spot is the live position's, read from Aqua, so the band quotes around the same price
    // the mandate on the live position is floored against.
    const live = await latestProgramOnChain();
    if (!live || live.docked) throw new Error('no live position to take a spot from');
    const [liveA, liveB] = await pub.readContract({
        address: AQUA, abi: AQUA_ABI, functionName: 'safeBalances', args: [OWNER, ROUTER, live.strategyHash, A, B],
    });
    const spotE18 = (liveB * E18) / liveA;
    const terms = bandTerms(spotE18);

    const [heldA, heldB] = await Promise.all([balanceOf(A, maker.address), balanceOf(B, maker.address)]);
    const { amountA, amountB } = bandDeposit({
        availableA: heldA, availableB: heldB - TAKER_B, spotE18, priceMinE18: terms.priceMinE18, priceMaxE18: terms.priceMaxE18,
    });
    const { timestamp } = await pub.getBlock();
    const program = toBandProgram({
        tokenA: A, tokenB: B, ...terms, expiry: Number(timestamp) + 30 * 86400, salt: BigInt(timestamp),
    });
    const order = bandOrder(maker.address, A, B, program);

    console.log(`  maker     ${maker.address}   holds ${fmt(heldA)} A, ${fmt(heldB)} B`);
    console.log(`  spot      ${fmt(spotE18)} B per A, from the live position ${live.strategyHash}`);
    console.log(`  band      ${fmt(terms.priceMinE18)} – ${fmt(terms.priceMaxE18)} B per A`);
    console.log(`  deposit   ${fmt(amountA)} A / ${fmt(amountB)} B`);

    // Aqua pulls from the maker's wallet at every settlement, so the allowance outlives this ship.
    for (const token of [A, B]) {
        await send(wallet, { address: token, abi: ERC20_ABI, functionName: 'approve', args: [AQUA, MAX] });
    }
    const shipped = await shipBand({ pub, wallet, aqua: AQUA, router: ROUTER, order, tokens: [A, B], amounts: [amountA, amountB] });
    console.log(`  tx        ship      ${shipped.tx}`);
    console.log(`  hash      ${shipped.strategyHash}`);
    console.log(`\nappend to agent/deployment.mjs:\n  BAND_MAKER ${maker.address}\n  BAND_SHIP_TX ${shipped.tx}\n  BAND_STRATEGY_HASH ${shipped.strategyHash}`);
}

async function status() {
    const band = await readBand();
    const onRouter = await pub.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'hash', args: [band.order] });
    const [rA, rB] = await reserves(band);
    console.log(`  maker     ${band.maker}`);
    console.log(`  ship      ${band.shipTx}  block ${band.shipBlock}`);
    console.log(`  hash      ${band.strategyHash}  router ${onRouter.toLowerCase() === band.strategyHash.toLowerCase() ? 'agrees' : `says ${onRouter}`}`);
    console.log(`  shipped   ${fmt(band.amounts[0])} A / ${fmt(band.amounts[1])} B`);
    console.log(`  reserves  ${fmt(rA)} A / ${fmt(rB)} B  (Aqua safeBalances now)`);
    const m = band.decoded.mandate;
    console.log(`  guarded   ${band.decoded.guarded}   range ${m.sides[0].priceRange.min} – ${m.sides[0].priceRange.max} B per A   expires ${m.expiryISO}`);
    for (const s of m.sides) {
        const aToB = s.direction === 'aToB';
        console.log(`  ${s.direction.padEnd(9)} cap ${s.maxAmountInFormatted} ${aToB ? 'A' : 'B'}, floor ${s.minRateFormatted} ${aToB ? 'B per A' : 'A per B'}, fee ${s.feePercent}%, decay ${s.decayPeriodSeconds}s`);
    }
    const swaps = reprice(band, await Promise.all(recordedSwaps().map((h) => readSwap(h))));
    for (const s of swaps) {
        const [tin, tout] = s.aToB ? [A, B] : [B, A];
        const paid = -(s.net[tin.toLowerCase()]?.[s.taker.toLowerCase()] ?? 0n);
        const got = s.net[tout.toLowerCase()]?.[s.taker.toLowerCase()] ?? 0n;
        const exact = paid === s.quote.amountIn && got === s.quote.amountOut;
        console.log(`  swap      ${s.tx}  ${s.aToB ? 'A→B' : 'B→A'}  ${fmt(paid)} in, ${fmt(got)} out  ${exact ? 'exactly as priced' : `priced ${fmt(s.quote.amountIn)} / ${fmt(s.quote.amountOut)}`}`);
    }
}

async function trade() {
    const band = await readBand();
    const maker = key('BATAS_BAND_MAKER_KEY');
    const taker = key('BATAS_BAND_TAKER_KEY');
    const transport = http(SEPOLIA_RPC, { timeout: 60_000 });
    const makerWallet = createWalletClient({ account: maker, chain: sepolia, transport });
    const takerWallet = createWalletClient({ account: taker, chain: sepolia, transport });
    console.log(`  taker     ${taker.address}`);

    // A second key rather than the maker trading with itself: a self-trade nets to nothing in every
    // wallet, and "the taker received exactly the quoted amount" would then be unobservable.
    if (await pub.getBalance({ address: taker.address }) < TAKER_ETH / 2n) {
        const hash = await makerWallet.sendTransaction({ to: taker.address, value: TAKER_ETH });
        await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
        console.log(`  tx        gas       ${hash}  ${formatEther(TAKER_ETH)} ETH`);
    }
    if (await balanceOf(B, taker.address) < TRADE_B_IN) {
        await send(makerWallet, { address: B, abi: ERC20_ABI, functionName: 'transfer', args: [taker.address, TAKER_B] });
    }
    for (const token of [A, B]) {
        const allowance = await pub.readContract({
            address: token, abi: [{ name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }],
            functionName: 'allowance', args: [taker.address, ROUTER],
        });
        if (allowance < MAX / 2n) await send(takerWallet, { address: token, abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, MAX] });
    }

    const hashes = [];
    for (const [aToB, amountIn] of [[false, TRADE_B_IN], [true, TRADE_A_IN]]) {
        hashes.push(await send(takerWallet, { address: ROUTER, abi: ROUTER_ABI, functionName: 'swap', args: [band.order, amountIn, takerData(aToB)] }));
    }

    // Refusals, by eth_call against the band as it now stands. Quoted with no decay offsets: every
    // offset standing works against the taker, so this is the best rate on offer, and a best case
    // under the floor is a refusal the floor makes rather than the spread.
    const [rA, rB] = await reserves(band);
    const m = band.decoded.mandate.sides;
    const best = (aToB, amountIn) => quoteExactIn({
        balanceIn: aToB ? rA : rB, balanceOut: aToB ? rB : rA, amountIn, aToB, sqrtMin: band.sqrtMin, sqrtMax: band.sqrtMax, feeBps: band.feeBps,
    });
    const capA = BigInt(m[0].maxAmountIn);
    const capB = BigInt(m[1].maxAmountIn);
    const cases = [
        { what: 'sell A over the cap', aToB: true, amountIn: capA + 1n, expect: 'MandateAmountInExceeded' },
        { what: 'sell A at 96% of the cap', aToB: true, amountIn: (capA * 96n) / 100n, expect: 'MandateRateTooLow', floor: BigInt(m[0].minRateE18) },
        { what: 'sell B over the cap', aToB: false, amountIn: capB + 1n, expect: 'MandateAmountInExceeded' },
        { what: 'sell B at 90% of the cap', aToB: false, amountIn: (capB * 90n) / 100n, expect: 'MandateRateTooLow', floor: BigInt(m[1].minRateE18) },
    ];
    for (const c of cases) {
        const q = best(c.aToB, c.amountIn);
        if (c.floor && !(rate(q.amountOut, q.amountIn) < c.floor)) throw new Error(`${c.what}: best rate clears the floor, not an under-floor case`);
        const got = await refusal(band.order, c.aToB, c.amountIn, taker.address);
        console.log(`  eth_call  ${c.what.padEnd(26)} ${fmt(c.amountIn)} → ${got ?? 'would settle'}  (best rate ${fmt(rate(q.amountOut, q.amountIn))})`);
        if (got !== c.expect) throw new Error(`${c.what}: expected ${c.expect}, got ${got}`);
    }
    console.log(`\nappend to BAND_SWAP_TXS in agent/deployment.mjs:\n  ${hashes.join(',')}`);
}

if (import.meta.filename === process.argv[1]) {
    const run = process.argv.includes('--ship') ? ship : process.argv.includes('--trade') ? trade : status;
    run().catch((e) => {
        console.error(e.shortMessage ?? e.message);
        process.exit(1);
    });
}
