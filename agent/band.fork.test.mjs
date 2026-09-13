// A banded, two-sided position, proven against the real contracts on a fork of Sepolia.
//
//   node --test agent/band.fork.test.mjs
//
// Nothing here is mocked. Anvil forks Sepolia, so Aqua, the deployed BatasRouter and both demo
// tokens are the live bytecode and the live state. The one liberty is impersonating the maker
// instead of signing for it, and that exists only on the fork: no transaction reaches Sepolia.
//
// What it proves, in order: the band ships to the real Aqua under the hash the real router
// computes; a trade each way settles, and every balance involved moves by exactly the amount the
// JS mirror of the instructions priced; the counter-trade pays the Decay spread; and trades past a
// cap, under a floor, or big enough to drain the band are refused by the envelope on their side.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

import {
    createPublicClient, createTestClient, createWalletClient, http, formatUnits, BaseError, ContractFunctionRevertedError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { AQUA, ROUTER, OWNER, TOKENS, SEPOLIA_RPC } from './deployment.mjs';
import { explain } from './swapvm.mjs';
import {
    toBandProgram, bandDeposit, bandOrder, shipBand, quoteExactIn, sqrtPriceE18, decayed, takerData,
    ROUTER_ABI, AQUA_ABI, ERC20_ABI,
} from './band.mjs';

const [A, B] = TOKENS;
const E18 = 10n ** 18n;
const MAX = 2n ** 256n - 1n;

// Anvil's first dev key. Public by design, and funded only on the fork.
const TAKER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

// The band. Liquidity sits between 1.8 and 2.2 B per A around a spot of 2.0. Selling A is floored
// at 1.96 B per A and capped at 500 A a trade; selling B is floored at 0.49 A per B (B no dearer
// than 2.04 A) and capped at 1000 B. The floors sit inside the band on purpose: at the band's own
// edge the curve runs out of tokens before a floor there could bind.
const TERMS = {
    priceMinE18: 18n * E18 / 10n,
    priceMaxE18: 22n * E18 / 10n,
    spotE18: 2n * E18,
    aToB: { maxAmountIn: 500n * E18, minRateE18: 196n * E18 / 100n },
    bToA: { maxAmountIn: 1000n * E18, minRateE18: 49n * E18 / 100n },
    feeBps: 30_000,
    decayPeriod: 600,
};
const SQRT_MIN = sqrtPriceE18(TERMS.priceMinE18);
const SQRT_MAX = sqrtPriceE18(TERMS.priceMaxE18);

const fmt = (x) => formatUnits(x, 18);
const rate = (out, inn) => (out * E18) / inn;

const freePort = () => new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
    });
});

let anvil;
let anvilLog = '';
let pub;
let testClient;
let maker;
let taker;
let order;
let strategyHash;

before(async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    anvil = spawn('anvil', ['--fork-url', SEPOLIA_RPC, '--port', String(port), '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Kept for the failure message only: an anvil that cannot reach the RPC says why on stderr.
    anvil.stdout.on('data', (d) => { anvilLog = (anvilLog + d).slice(-2000); });
    anvil.stderr.on('data', (d) => { anvilLog = (anvilLog + d).slice(-2000); });

    const transport = http(url, { timeout: 60_000 });
    pub = createPublicClient({ chain: sepolia, transport });
    testClient = createTestClient({ chain: sepolia, mode: 'anvil', transport });
    for (let i = 0; ; i++) {
        try {
            await pub.getBlockNumber();
            break;
        } catch {
            if (i > 120 || anvil.exitCode !== null) throw new Error(`anvil did not come up on ${url}:\n${anvilLog}`);
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    await testClient.impersonateAccount({ address: OWNER });
    await testClient.setBalance({ address: OWNER, value: 10n * E18 });
    await testClient.setBalance({ address: TAKER.address, value: 10n * E18 });
    maker = createWalletClient({ account: OWNER, chain: sepolia, transport });
    taker = createWalletClient({ account: TAKER, chain: sepolia, transport });

    // The taker brings its own side of each trade, sent to it by the maker, as counterparty.mjs
    // requires on Sepolia. Aqua pulls from the maker's wallet at settlement, so Aqua needs the
    // allowance; the router pulls the taker's input, so the router needs the taker's.
    await send(maker, A, ERC20_ABI, 'transfer', [TAKER.address, 3000n * E18]);
    await send(maker, B, ERC20_ABI, 'transfer', [TAKER.address, 3000n * E18]);
    await send(maker, A, ERC20_ABI, 'approve', [AQUA, MAX]);
    await send(maker, B, ERC20_ABI, 'approve', [AQUA, MAX]);
    await send(taker, A, ERC20_ABI, 'approve', [ROUTER, MAX]);
    await send(taker, B, ERC20_ABI, 'approve', [ROUTER, MAX]);
}, { timeout: 180_000 });

after(() => {
    anvil?.kill();
});

async function send(wallet, address, abi, functionName, args, extra = {}) {
    const hash = await wallet.writeContract({ address, abi, functionName, args, ...extra });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success', `${functionName} reverted`);
    return receipt;
}

const balanceOf = (token, who) => pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [who] });
const reserves = () => pub.readContract({
    address: AQUA, abi: AQUA_ABI, functionName: 'safeBalances', args: [OWNER, ROUTER, strategyHash, A, B],
});

/** Every balance a settlement touches, so a trade can be checked against its price in all of them. */
async function snapshot() {
    const [rA, rB] = await reserves();
    return {
        rA, rB,
        takerA: await balanceOf(A, TAKER.address), takerB: await balanceOf(B, TAKER.address),
        makerA: await balanceOf(A, OWNER), makerB: await balanceOf(B, OWNER),
    };
}

/** Why the router refused a trade, by error name, from a simulation against the fork. */
async function refusal(aToB, amountIn) {
    try {
        await pub.simulateContract({
            account: TAKER, address: ROUTER, abi: ROUTER_ABI, functionName: 'swap', args: [order, amountIn, takerData(aToB)],
        });
    } catch (e) {
        const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
        if (reverted) return reverted.data?.errorName ?? reverted.shortMessage;
        throw e;
    }
    return null;
}

test('the band ships to the real Aqua under the hash the deployed router computes', async () => {
    const { timestamp } = await pub.getBlock();
    const { amountA, amountB } = bandDeposit({
        availableA: 1000n * E18, availableB: 2000n * E18,
        spotE18: TERMS.spotE18, priceMinE18: TERMS.priceMinE18, priceMaxE18: TERMS.priceMaxE18,
    });
    const program = toBandProgram({
        tokenA: A, tokenB: B, ...TERMS,
        expiry: Number(timestamp) + 3600, salt: BigInt(timestamp),
    });
    order = bandOrder(OWNER, A, B, program);

    const decoded = explain(program);
    assert.equal(decoded.guarded, true);
    assert.deepEqual(decoded.mandate.sides.map((s) => s.direction), ['aToB', 'bToA']);

    const shipped = await shipBand({ pub, wallet: maker, aqua: AQUA, router: ROUTER, order, tokens: [A, B], amounts: [amountA, amountB] });
    strategyHash = shipped.strategyHash;
    assert.deepEqual(await reserves(), [amountA, amountB]);

    console.log(`band      ${fmt(TERMS.priceMinE18)} – ${fmt(TERMS.priceMaxE18)} B per A, spot ${fmt(TERMS.spotE18)}`);
    console.log(`sell A    cap ${fmt(TERMS.aToB.maxAmountIn)} A, floor ${fmt(TERMS.aToB.minRateE18)} B/A`);
    console.log(`sell B    cap ${fmt(TERMS.bToA.maxAmountIn)} B, floor ${fmt(TERMS.bToA.minRateE18)} A/B`);
    console.log(`fee       ${TERMS.feeBps / 1e5}%   decay ${TERMS.decayPeriod}s   program ${(program.length - 2) / 2} bytes`);
    console.log(`shipped   ${fmt(amountA)} A / ${fmt(amountB)} B   hash ${strategyHash}   gas ${shipped.gasUsed}`);
});

let first;
let firstAt;

test('selling A inside the band settles, and every balance moves exactly as priced', async () => {
    const before = await snapshot();
    const amountIn = 20n * E18;
    const q = quoteExactIn({ balanceIn: before.rA, balanceOut: before.rB, amountIn, aToB: true, sqrtMin: SQRT_MIN, sqrtMax: SQRT_MAX, feeBps: TERMS.feeBps });
    assert.equal(q.partial, false);
    assert.ok(rate(q.amountOut, q.amountIn) >= TERMS.aToB.minRateE18, 'the chosen trade must clear its own floor');

    firstAt = Number((await pub.getBlock()).timestamp) + 12;
    await testClient.setNextBlockTimestamp({ timestamp: BigInt(firstAt) });
    await send(taker, ROUTER, ROUTER_ABI, 'swap', [order, amountIn, takerData(true)], { gas: 1_000_000n });
    const now = await snapshot();

    assert.equal(before.takerA - now.takerA, q.amountIn, 'taker paid');
    assert.equal(now.takerB - before.takerB, q.amountOut, 'taker received');
    assert.equal(now.makerA - before.makerA, q.amountIn, 'maker wallet received A');
    assert.equal(before.makerB - now.makerB, q.amountOut, 'maker wallet paid B');
    assert.equal(now.rA - before.rA, q.amountIn, 'Aqua reserve A');
    assert.equal(before.rB - now.rB, q.amountOut, 'Aqua reserve B');
    first = q;
    console.log(`A → B     ${fmt(q.amountIn)} A in, ${fmt(q.amountOut)} B out, rate ${fmt(rate(q.amountOut, q.amountIn))}`);
});

test('selling B back a minute later settles too, and pays the decay spread', async () => {
    const before = await snapshot();
    const amountIn = 40n * E18;
    const elapsed = 60;
    // What swap one left behind, weighed by how much of the period has passed: its B out now pads
    // the B side, its A in now thins the A side, both against this taker.
    const offsets = {
        offsetIn: decayed(first.amountOut, elapsed, TERMS.decayPeriod),
        offsetOut: decayed(first.amountIn, elapsed, TERMS.decayPeriod),
    };
    const base = { balanceIn: before.rB, balanceOut: before.rA, amountIn, aToB: false, sqrtMin: SQRT_MIN, sqrtMax: SQRT_MAX, feeBps: TERMS.feeBps };
    const q = quoteExactIn({ ...base, ...offsets });
    const withoutSpread = quoteExactIn(base);
    assert.ok(q.amountOut < withoutSpread.amountOut, 'the counter-trade must cost more than it would with no decay');
    assert.ok(rate(q.amountOut, q.amountIn) >= TERMS.bToA.minRateE18, 'the chosen trade must clear its own floor');

    await testClient.setNextBlockTimestamp({ timestamp: BigInt(firstAt + elapsed) });
    await send(taker, ROUTER, ROUTER_ABI, 'swap', [order, amountIn, takerData(false)], { gas: 1_000_000n });
    const now = await snapshot();

    assert.equal(before.takerB - now.takerB, q.amountIn, 'taker paid');
    assert.equal(now.takerA - before.takerA, q.amountOut, 'taker received');
    assert.equal(now.makerB - before.makerB, q.amountIn, 'maker wallet received B');
    assert.equal(before.makerA - now.makerA, q.amountOut, 'maker wallet paid A');
    assert.equal(now.rB - before.rB, q.amountIn, 'Aqua reserve B');
    assert.equal(before.rA - now.rA, q.amountOut, 'Aqua reserve A');
    console.log(`B → A     ${fmt(q.amountIn)} B in, ${fmt(q.amountOut)} A out, rate ${fmt(rate(q.amountOut, q.amountIn))}`);
    console.log(`          decay spread cost the counter-trade ${fmt(withoutSpread.amountOut - q.amountOut)} A`);
});

test('each side refuses past its cap, under its floor, and a trade that would drain the band', async () => {
    const { rA, rB } = await snapshot();
    // Quoted with no decay offsets. Every offset standing now works against the taker, so this is
    // the best rate these trades could get, and a best case under the floor is a certain refusal.
    const best = (aToB, amountIn) => quoteExactIn({
        balanceIn: aToB ? rA : rB, balanceOut: aToB ? rB : rA, amountIn, aToB, sqrtMin: SQRT_MIN, sqrtMax: SQRT_MAX, feeBps: TERMS.feeBps,
    });

    const cases = [
        { what: 'sell 480 A, under the 1.96 floor', aToB: true, amountIn: 480n * E18, expect: 'MandateRateTooLow' },
        { what: 'sell 501 A, over the 500 A cap', aToB: true, amountIn: 501n * E18, expect: 'MandateAmountInExceeded' },
        { what: 'sell 900 B, under the 0.49 floor', aToB: false, amountIn: 900n * E18, expect: 'MandateRateTooLow' },
        { what: 'sell 1001 B, over the 1000 B cap', aToB: false, amountIn: 1001n * E18, expect: 'MandateAmountInExceeded' },
        { what: 'sell 2500 A, past the band edge', aToB: true, amountIn: 2500n * E18, expect: 'MandateAmountInExceeded' },
    ];
    for (const c of cases) {
        const q = best(c.aToB, c.amountIn);
        const floor = c.aToB ? TERMS.aToB.minRateE18 : TERMS.bToA.minRateE18;
        if (c.expect === 'MandateRateTooLow') assert.ok(rate(q.amountOut, q.amountIn) < floor, `${c.what}: best rate must be under the floor`);
        if (c.what.includes('band edge')) assert.equal(q.partial, true, 'the curve must run out of B before the input is used');
        const got = await refusal(c.aToB, c.amountIn);
        assert.equal(got, c.expect, c.what);
        console.log(`refused   ${c.what.padEnd(34)} ${got}  (best rate ${fmt(rate(q.amountOut, q.amountIn))}${q.partial ? ', band drained' : ''})`);
    }
});

test('a trade inside every limit is still refused once the deadline passes', async () => {
    const { timestamp } = await pub.getBlock();
    await testClient.setNextBlockTimestamp({ timestamp: timestamp + 3601n });
    await testClient.mine({ blocks: 1 });
    assert.equal(await refusal(true, 1n * E18), 'DeadlineReached');
    console.log('refused   sell 1 A after the deadline          DeadlineReached');
});
