// Proving the kill switch on the chain, not in a test.
//
//   node agent/killswitch.mjs            quote the live position, and say whether the name gates it
//   node agent/killswitch.mjs --prove    revoke the name, quote again, re-grant, quote again
//
// The claim is narrow and worth being exact about. An ENSv2 subname expressed this agent's
// authority from the first day, and the agent consulted it before acting — but nothing on chain
// did, so revoking the name stopped the agent that asks and stopped nobody else. `MandateName` put
// the question into the settlement itself. This script is the difference, demonstrated: the same
// `quote` call, before and after the owner takes the name back, made by a caller that has never
// heard of ENS and would happily trade.
//
// `--prove` sends two transactions on Sepolia and leaves the name exactly as it found it. The
// quotes cost nothing; they are `eth_call`.

import 'dotenv/config';
import { createPublicClient, http, decodeAbiParameters, parseAbiParameters, getAddress, ContractFunctionRevertedError } from 'viem';
import { sepolia } from 'viem/chains';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { latestProgramOnChain } from './inspect.mjs';
import { decodeProgram, readMandate } from './swapvm.mjs';
import { ROUTER, MANDATE_NAME, SEPOLIA_RPC } from './deployment.mjs';

const QUOTE_ABI = [{
    name: 'quote',
    type: 'function',
    stateMutability: 'view',
    inputs: [
        { name: 'order', type: 'tuple', components: [
            { name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' },
        ] },
        { name: 'amount', type: 'uint256' },
        { name: 'takerData', type: 'bytes' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
}];

/**
 * The refusals this position can produce, by selector, so a revert reads as a reason.
 *
 * Exported and checked against the compiled artifacts rather than trusted. A table of four-byte
 * strings typed by hand is exactly the thing that goes stale silently: rename an error in Solidity
 * and this keeps printing the old name for a selector nothing produces any more, or prints a bare
 * hex string for the one it does.
 */
export const ERRORS = {
    '0xca98bdd0': 'MandateNameNotHeld — the name is not held by the address the mandate names',
    '0x88ccbe8f': 'MandateNameLapsed — the name has run out',
    '0x916a879b': 'MandateNameArgsTruncated',
    '0xb9f1dc1d': 'MandateAmountInExceeded — over the size cap',
    '0x5dbf695b': 'MandateRateTooLow — under the floor',
    '0xbec85dff': 'MandateDirectionMismatch — the taker asked for the direction the mandate does not permit',
    '0x70b57d90': 'DeadlineReached — the mandate has expired',
};

const client = createPublicClient({
    chain: sepolia,
    transport: http(SEPOLIA_RPC),
});

/** The live order, whole — not just its program, because quoting needs the traits and the data. */
async function liveOrder() {
    const shipped = await latestProgramOnChain();
    if (!shipped) throw new Error('no position shipped to the live router yet');
    const [order] = decodeAbiParameters(
        parseAbiParameters('(address maker, uint256 traits, bytes data)'),
        shipped.strategy,
    );
    return { order, strategyHash: shipped.strategyHash };
}

/**
 * Quote a small trade, and report which of the two answers came back.
 *
 * A revert is the result being looked for, so it is caught rather than thrown: the interesting
 * output of this script is *which* refusal, and a stack trace is not that.
 *
 * Only a revert. An RPC that timed out, refused the connection or rate-limited us never asked the
 * router anything, and it used to come back as `{ ok: false }` like a refusal — so a network blip
 * during `--prove` read as the name gating the settlement. That is thrown, because "we could not
 * ask" is not an answer about the position. `client` is here for the caller who has its own.
 */
export async function tryQuote(order, amountIn, { client: pub = client } = {}) {
    try {
        const [, amountOut] = await pub.readContract({
            address: getAddress(ROUTER), abi: QUOTE_ABI, functionName: 'quote',
            args: [order, amountIn, TAKER_DATA],
        });
        return { ok: true, amountOut };
    } catch (e) {
        const reverted = typeof e.walk === 'function' ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
        if (!reverted) throw e;

        // viem's short message stops at "reverted with the following signature:", which is the one
        // part of a refusal that carries no information. The selector says *which* limit refused,
        // so it is read from the revert bytes viem keeps on `raw` rather than scraped out of
        // English that changes between versions. The message is the fallback, not the source, and
        // it reads only after "signature:": the first eight hex digits in the message are the
        // router's own address, and a revert with no data was being named after it.
        const selector = reverted.raw
            ? String(reverted.raw).slice(0, 10).toLowerCase()
            : String(e.message ?? e).match(/signature:\s*(0x[0-9a-f]{8})/i)?.[1]?.toLowerCase();
        if (!selector || selector === '0x') {
            // No selector at all is not one of the mandate's refusals: those all carry one. A bare
            // revert is what an external call bubbles up when the callee answered in a shape the
            // caller could not decode — the registry, most likely.
            return { ok: false, why: 'reverted with no data — the registry answered in a shape the instruction could not decode (interface mismatch?)' };
        }
        return { ok: false, why: ERRORS[selector] ?? selector };
    }
}

// The plainest possible taker data: "what would this position give me for one token in".
//
// `TakerTraitsLib.build` lays this out as ten uint16 slice indexes, then a uint16 of flags, then
// the slices themselves. Every slice is empty here — no threshold, recipient equal to the taker,
// no deadline, no hooks, no callbacks — so all ten indexes are zero and the whole thing is twenty
// zero bytes followed by the flag word.
//
// 0x00e1 is exactIn (0x0001) | firstTransferFromTaker (0x0020) | transferFromAndAquaPush (0x0040)
// | aToB (0x0080), which is what the contract tests build for an ordinary trade.
//
// Hand-packed on purpose and only because it is degenerate. Anything with a slice in it belongs in
// the Solidity builder rather than in a third encoder here — this project has already paid once for
// two encoders of one format, and would not learn more by acquiring a third.
const TAKER_DATA = `0x${'00'.repeat(20)}00e1`;

const here = dirname(fileURLToPath(import.meta.url));
const ens = (...args) =>
    execFileSync(process.execPath, [join(here, 'ens.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' });

async function main() {
    const { order, strategyHash } = await liveOrder();
    const program = `0x${order.data.replace(/^0x/, '').slice(80)}`;
    const terms = readMandate(decodeProgram(program));

    console.log(`position   ${strategyHash}`);
    console.log(`router     ${ROUTER}`);
    if (!terms.name) {
        console.log('\nthis mandate names no registry: nothing on chain ends it early.');
        console.log('its only stops are the expiry and the maker docking the position.');
        return;
    }
    console.log(`kill switch  registry ${terms.name.registry}`);
    console.log(`             holder   ${terms.name.holder}`);
    console.log(`             name     "${terms.name.label}"`);

    const amountIn = 10n ** 18n;
    const before = await tryQuote(order, amountIn);
    console.log(`\nquote 1 A, name held      -> ${before.ok ? `${before.amountOut} B` : `refused: ${before.why}`}`);

    if (!process.argv.includes('--prove')) {
        console.log('\nrun again with --prove to revoke the name and quote the same position again');
        return;
    }

    const label = terms.name.label || MANDATE_NAME;
    console.log(`\nrevoking "${label}" …`);
    ens('--revoke', label);

    // The re-grant runs whatever the middle quote does. A demonstration that ends with the name
    // still revoked because the RPC hiccuped has not left the name as it found it, and the agent
    // is stopped until somebody notices.
    let during;
    try {
        during = await tryQuote(order, amountIn);
        console.log(`quote 1 A, name revoked   -> ${during.ok ? `${during.amountOut} B` : `refused: ${during.why}`}`);
    } finally {
        console.log(`\nre-granting "${label}" …`);
        try {
            // `--grant` also writes the grant to the HCS topic, so the ledger's last word about the
            // name is not the revocation above. That note is best-effort inside ens.mjs; the one
            // line worth repeating here is whether it landed.
            const out = ens('--grant', label);
            const note = out.split('\n').filter((line) => /HCS/.test(line));
            if (note.length) console.log(note.map((line) => `  ${line.trim()}`).join('\n'));
        } catch (e) {
            console.error(`re-grant failed: ${String(e.stderr || e.message || e).trim()}`);
            console.error(`the name "${label}" is still revoked and the agent is stopped. restore it by hand:`);
            console.error(`  node agent/ens.mjs --grant ${label}`);
            process.exitCode = 1;
        }
    }

    const after = await tryQuote(order, amountIn);
    console.log(`quote 1 A, name restored  -> ${after.ok ? `${after.amountOut} B` : `refused: ${after.why}`}`);

    // The re-grant bumps the registry's version counter, so the name has a new token id. Asking the
    // registry for it rather than deriving it from the label is what makes this line work at all.
    console.log('');
    const held = verdict({ before, during, after });
    console.log(held.gated ? 'the name gates the settlement, not merely the agent.' : `unexpected: ${held.reason}`);
    if (!held.gated) process.exitCode = 1;
}

/**
 * Did the three quotes actually demonstrate the claim?
 *
 * Separate and pure because "the middle one failed" is not the claim. A position that refuses
 * everything would also produce a failing middle quote, and so would one that broke between the
 * first call and the second. The claim is the shape: worked, refused, worked again — and the two
 * working quotes agreeing on the price is what says the position came back rather than merely
 * stopped erroring.
 */
export function verdict({ before, during, after }) {
    if (!before?.ok) return { gated: false, reason: 'the position was already refusing before the name was touched' };
    if (during?.ok) return { gated: false, reason: 'revoking the name did not stop the settlement' };
    if (!after?.ok) return { gated: false, reason: 'the position did not come back after the name was re-granted' };
    if (String(before.amountOut) !== String(after.amountOut)) {
        return { gated: false, reason: 'the position came back at a different price than it left at' };
    }
    return { gated: true, reason: 'refused only while the name was gone, and returned unchanged' };
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        // An exhausted scan is a statement about how far we looked, not about the chain; it is
        // printed as the message it already is rather than as a crash.
        console.error(e.scanExhausted ? e.message : String(e.shortMessage ?? e.message ?? e));
        process.exitCode = 1;
    });
}
