// Is what is deployed what is in this repository?
//
// This was not a hypothetical. `BatasApp` at 0x369D326c… was deployed before `ZeroAmountOut`
// existed — the guard added to fix a bug the fuzzer found, where a one-wei input has its whole
// value eaten by the rounded-up fee and the taker pays for nothing. The fix was written, tested,
// documented and never deployed. Everything read as correct: the tests passed, the address held
// code, the explorer showed a verified contract. It was simply a version behind on the one thing
// that mattered.
//
// A verification artifact went stale the same way, so `verification/` described a contract that
// was no longer the source either.
//
// Comparing selectors would not have caught it — under `via_ir` the optimizer does not leave error
// selectors lying around as searchable constants, which is how the first attempt at this check
// gave a confident wrong answer. So the whole runtime is compared instead, minus the trailing
// metadata, which encodes a hash of the source layout and differs for reasons that are not the
// code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

import { ROUTER, APP } from './deployment.mjs';

const client = createPublicClient({
    chain: sepolia,
    transport: http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'),
});

/**
 * Drop the CBOR metadata Solidity appends to runtime code.
 *
 * The last two bytes give its length. It carries a hash of the source and of the compiler
 * settings, so two builds of identical code can differ there — comparing it would report drift
 * that is not drift.
 */
function withoutMetadata(hex) {
    const body = String(hex).trim().replace(/^0x/, '').toLowerCase();
    const len = parseInt(body.slice(-4), 16);
    if (!Number.isFinite(len) || len * 2 + 4 > body.length) return body;
    return body.slice(0, body.length - 4 - len * 2);
}

/**
 * Blank the immutables.
 *
 * A compiled artifact leaves immutable slots as zeroes; the constructor writes them at deploy time.
 * Comparing raw bytes therefore reports a difference for every immutable — the Aqua address, here —
 * which is not drift. The artifact says exactly where they are.
 */
function maskImmutables(hex, refs) {
    const bytes = Buffer.from(hex, 'hex');
    for (const spans of Object.values(refs ?? {})) {
        for (const { start, length } of spans) bytes.fill(0, start, start + length);
    }
    return bytes.toString('hex');
}

async function artifactOf(name) {
    return JSON.parse(await readFile(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
}

/** A short, comparable fingerprint: metadata dropped, immutables blanked. */
async function fingerprints(name, address) {
    const artifact = await artifactOf(name);
    const refs = artifact.deployedBytecode.immutableReferences;
    const onChain = await client.getCode({ address });
    assert.ok(onChain && onChain !== '0x', `${address} holds no code`);
    return {
        chain: maskImmutables(withoutMetadata(onChain), refs),
        local: maskImmutables(withoutMetadata(artifact.deployedBytecode.object), refs),
    };
}

for (const [name, address] of [['BatasRouter', ROUTER], ['BatasApp', APP]]) {
    test(`${name} on Sepolia is the ${name} in this repository`, async () => {
        const { chain, local } = await fingerprints(name, address);
        // Compared by length and by a slice rather than by dumping two kilobytes of hex on failure:
        // the useful information is that they differ and where, not the whole of both.
        const at = [...local].findIndex((c, i) => c !== chain[i]);
        const sha = (h) => createHash('sha256').update(h).digest('hex').slice(0, 16);
        assert.equal(
            at,
            -1,
            `${name} at ${address} is not built from src/${name}.sol — first difference at byte `
            + `${Math.floor(at / 2)} of ${local.length / 2}
`
            + `  built here ${sha(local)} (${local.length / 2} bytes)
`
            + `  on chain   ${sha(chain)} (${chain.length / 2} bytes)
`
            + `  local  …${local.slice(Math.max(0, at - 24), at + 40)}
`
            + `  chain  …${chain.slice(Math.max(0, at - 24), at + 40)}
`
            + '  note: out/ must come from `forge build`. `forge test` compiles src/ differently'
            + ' — 20,596 bytes for BatasRouter against 20,538 — so an artifact left by a test'
            + ' run differs here for reasons that are not a stale deployment. Run `forge build`'
            + ' and try again before redeploying anything.',
        );
    });
}

test('the verification inputs describe the contracts as they are now', async () => {
    // `verification/` exists so a reader can reproduce the bytecode without trusting the explorer.
    // A stale one is worse than none: it invites someone to check, and then tells them the
    // deployment does not match.
    for (const name of ['BatasRouter', 'BatasApp']) {
        const input = JSON.parse(
            await readFile(new URL(`../verification/${name}.standard-input.json`, import.meta.url), 'utf8'),
        );
        for (const path of ['src/BatasApp.sol', 'src/PolicyEnvelope.sol', 'src/Mandate.sol', 'src/BatasRouter.sol']) {
            const key = Object.keys(input.sources).find((k) => k.endsWith(path));
            if (!key) continue;
            const onDisk = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
            assert.equal(
                input.sources[key].content,
                onDisk.replace(/\r\n/g, '\n'),
                `verification/${name}.standard-input.json carries an old copy of ${path}`,
            );
        }
    }
});

test('no npm script is named in a way the host will run on deploy', async () => {
    // Adding a script called "build" broke a Vercel deployment: the platform treats that name as
    // the project's build command and ran `forge build --force` on a machine with no forge, which
    // fails with exit 127 and no obvious connection to the change that caused it. The contracts
    // build is `build:contracts` for that reason, and this keeps it that way.
    //
    // Nothing here needs a build step at deploy time — Vercel serves the Express app directly.
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    for (const reserved of ['build', 'vercel-build', 'now-build']) {
        assert.equal(
            pkg.scripts[reserved],
            undefined,
            `"${reserved}" is run automatically by the host on deploy; name it something else`,
        );
    }
    assert.equal(pkg.scripts['build:contracts'], 'forge build --force', 'the contracts build must stay forced');
});

test('the demo script and the agent point at the same deployment', async () => {
    // They did not, and nothing noticed. `agent/deployment.mjs` was moved to a freshly deployed
    // router while `script/Demo.s.sol` kept a hard-coded default pointing at the old one, so a demo
    // run shipped a position the agent then could not find — "no position shipped to this router
    // yet", from a script that had just shipped one.
    //
    // The address lives in two languages and there is no single place to put it that both can read,
    // so the honest fix is to check rather than to pretend. Grepping a Solidity constant is crude;
    // it is also exactly as strong as the thing it is protecting against.
    const demo = await readFile(new URL('../script/Demo.s.sol', import.meta.url), 'utf8');
    const found = demo.match(/DEFAULT_ROUTER = (0x[0-9a-fA-F]{40})/);
    assert.ok(found, 'Demo.s.sol no longer declares a DEFAULT_ROUTER');
    assert.equal(
        found[1].toLowerCase(),
        ROUTER.toLowerCase(),
        'Demo.s.sol ships to a different router than agent/deployment.mjs reads from',
    );
});
