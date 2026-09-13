// Tests for recovering a program from the strategy bytes Aqua stored.
//
// This function used to count ABI words by hand and got it wrong: `abi.encode(Order)` opens with
// an offset word because `Order` has a dynamic member, and the hand-rolled version skipped it. The
// symptom was not a clean failure but "Cannot convert 0x to a BigInt" from deep inside the
// decoder, which is the kind of error that sends you looking in the wrong place.

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, parseAbiParameters, concat } from 'viem';

import { programFromStrategy, latestProgramOnChain } from './inspect.mjs';
import { toProgram, explain } from './swapvm.mjs';

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
        tokenIn: '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B',
        tokenOut: '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81',
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
        const program = toProgram({
        tokenIn: '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B',
        tokenOut: '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81', maxAmountIn: 1n, minRateE18: 1n, expiry: 1n, feeBps: 0, salt });
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
        tokenIn: '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B',
        tokenOut: '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81',
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

// --- reading the live position ------------------------------------------------
//
// `latestProgramOnChain` had no test at all, and three things depend on it: the walkthrough, the
// MCP tools when called without a program, and inspect.mjs itself. It walks Aqua's log backwards
// in windows and filters client-side, because `Shipped` indexes nothing — so "found the wrong
// position" and "found nothing" are both quiet failures that would surface as a confusing answer
// somewhere else entirely.

test('finds the newest mandate this owner shipped to the router', async () => {
    const found = await latestProgramOnChain();
    assert.ok(found, 'a mandate is live on the router; if this fails, run script/Demo.s.sol');
    assert.match(found.strategyHash, /^0x[0-9a-f]{64}$/i);

    const program = programFromStrategy(found.strategy);
    const answer = explain(program);
    assert.equal(answer.guarded, true, 'the live position must be guarded by PolicyEnvelope');
    assert.ok(answer.mandate.expiry !== null, 'and carry a deadline');
});

test('the strategy it returns hashes to the mandate hash it returns', async () => {
    // Aqua's strategy hash is keccak of the strategy bytes. If these two ever disagreed, the
    // walkthrough would be describing one position and pointing at another.
    const { keccak256 } = await import('viem');
    const found = await latestProgramOnChain();
    assert.equal(keccak256(found.strategy).toLowerCase(), found.strategyHash.toLowerCase());
});

test('a scan that gave up raises, rather than reporting that nothing was shipped', async () => {
    // The distinction the whole file turns on, in its last unguarded place. `Shipped` indexes
    // nothing, so this walks logs by hand with a bounded window — and hitting that bound used to
    // return the same null as having searched the entire chain. Every caller then said "no mandate
    // has been shipped yet", which is a claim about the maker assembled out of a decision we took
    // about how long to look.
    const { latestProgramOnChain } = await import('./inspect.mjs');
    const nothingAnywhere = {
        getBlockNumber: async () => 5_000_000n,
        getLogs: async () => [],
    };
    await assert.rejects(
        () => latestProgramOnChain({ client: nothingAnywhere }),
        (e) => {
            assert.equal(e.scanExhausted, true);
            assert.equal(e.windowBlocks, 60000);
            assert.match(e.message, /where the scan stopped, not where the chain does/);
            return true;
        },
    );
});

test('and a chain short enough to search entirely answers null, which is a finding', async () => {
    const { latestProgramOnChain } = await import('./inspect.mjs');
    const shortChain = {
        getBlockNumber: async () => 500n,
        getLogs: async () => [],
    };
    assert.equal(await latestProgramOnChain({ client: shortChain }), null);
});

test('a docked position is reported as docked, not as the live one', async () => {
    // Docking leaves no event behind it. The newest `Shipped` log names a position the maker may
    // already have emptied, and until this was checked every free answer described its terms as
    // if they were still on offer. Aqua's `safeBalances` refuses to answer for a docked strategy,
    // and that refusal is the only record — so a revert is the finding.
    const { encodeAbiParameters, parseAbiParameters, BaseError } = await import('viem');
    const { ROUTER } = await import('./deployment.mjs');
    const strategy = encodeAbiParameters(parseAbiParameters('(address maker, uint256 traits, bytes data)'), [
        { maker: MAKER, traits: TRAITS, data: '0x' + '00'.repeat(40) + '2121' },
    ]);
    const log = { args: { maker: MAKER, app: ROUTER, strategyHash: '0x' + 'ab'.repeat(32), strategy } };
    class Reverted extends BaseError { name = 'ContractFunctionRevertedError'; }
    const docked = {
        getBlockNumber: async () => 100n,
        getLogs: async () => [log],
        readContract: async () => { throw new BaseError('call reverted', { cause: new Reverted('SafeBalancesForTokenNotInActiveStrategy') }); },
    };
    const found = await latestProgramOnChain({ client: docked });
    assert.equal(found.docked, true);
    assert.equal(found.strategyHash, log.args.strategyHash, 'the position is still named, so a caller can see which one was docked');

    // And an RPC that simply failed is not a dock.
    const broken = { ...docked, readContract: async () => { throw new Error('ECONNRESET'); } };
    await assert.rejects(() => latestProgramOnChain({ client: broken }), /ECONNRESET/);

    const live = { ...docked, readContract: async () => [1n, 1n] };
    assert.equal((await latestProgramOnChain({ client: live })).docked, false);
});

// --- the payment, read back from the ledger ----------------------------------

// A real x402 settlement already on Hedera testnet: the facilitator (0.0.7162784) submitted it and
// paid the fee, 0.001 HBAR left the agent (0.0.10388401) and reached the service (0.0.10388560).
const SETTLED = '0.0.7162784@1789256281.151698196';

test('a settlement is confirmed from the mirror node, not from the paid service', async () => {
    const { confirmSettlement } = await import('./inspect.mjs');
    const ok = await confirmSettlement(SETTLED, { payer: '0.0.10388401', payTo: '0.0.10388560', maxAmount: 1000000 });
    assert.equal(ok.confirmed, true, ok.reason);
    assert.equal(ok.transaction, '0.0.7162784-1789256281-151698196', 'the SDK form is turned into the mirror form');
    assert.equal(ok.result, 'SUCCESS');
    assert.equal(ok.paid, 100000);
    assert.equal(ok.received, 100000);
    assert.equal(ok.consensusTimestamp, '1789256288.732913848');

    const overCap = await confirmSettlement(SETTLED, { payer: '0.0.10388401', maxAmount: 99999 });
    assert.equal(overCap.confirmed, false);
    assert.match(overCap.reason, /above the 99999 cap/);

    // The transaction is real and successful, but it is not a payment from this account.
    const notMine = await confirmSettlement(SETTLED, { payer: '0.0.10388402' });
    assert.equal(notMine.confirmed, false);
    assert.match(notMine.reason, /no HBAR left/);

    const wrongPayee = await confirmSettlement(SETTLED, { payer: '0.0.10388401', payTo: '0.0.7162784' });
    assert.equal(wrongPayee.confirmed, false);
    assert.match(wrongPayee.reason, /no HBAR reached/);
});

test('an id the mirror node has never seen is "could not check", and a malformed one is refused', async () => {
    const { confirmSettlement } = await import('./inspect.mjs');
    const unseen = await confirmSettlement('0.0.10388401@1000000000.000000001', { payer: '0.0.10388401', attempts: 2, delayMs: 10 });
    assert.equal(unseen.confirmed, null, 'absent from the mirror is not proof the payment failed');
    assert.match(unseen.reason, /has not seen/);

    const garbage = await confirmSettlement('not-a-tx', { payer: '0.0.10388401' });
    assert.equal(garbage.confirmed, false);
    assert.match(garbage.reason, /not a Hedera transaction id/);
});
