// The two parts of the kill-switch proof that do not need a chain.
//
//   node --test agent/killswitch.test.mjs
//
// The three quotes themselves are live by necessity — the whole point is that the settlement on
// Sepolia refuses — and they are not tested here. What is tested is the pair of things that would
// make that demonstration lie without anyone noticing: a selector table that has drifted from the
// contracts, and a verdict that says "gated" for a position that was merely broken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { toFunctionSelector } from 'viem';

import { ERRORS, verdict } from './killswitch.mjs';

/**
 * Every error the built router declares, as selector → signature.
 *
 * The router rather than our libraries, because the router is what `killswitch.mjs` calls and its
 * ABI is the full set a quote can revert with — including SwapVM's own, which is how the first
 * version of this test failed: it checked only the three Batas source files and reported
 * `DeadlineReached` as an error no contract produces, when in fact it comes from the vendor
 * instruction the mandate compiles into every program.
 */
async function selectorsFromArtifacts() {
    const out = {};
    for (const path of [
        '../out/BatasRouter.sol/BatasRouter.json',
        '../out/BatasApp.sol/BatasApp.json',
    ]) {
        const artifact = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
        for (const entry of artifact.abi) {
            if (entry.type !== 'error') continue;
            const signature = `${entry.name}(${entry.inputs.map((i) => i.type).join(',')})`;
            out[toFunctionSelector(signature).toLowerCase()] = signature;
        }
    }
    return out;
}

test('every selector the script can name is one the contracts actually produce', async () => {
    // The failure this prevents: rename an error in Solidity, and the table keeps printing the old
    // name for a selector nothing emits any more — while the refusal that does happen prints as
    // bare hex. Both halves of that are worse than having no table.
    const known = await selectorsFromArtifacts();
    for (const [selector, description] of Object.entries(ERRORS)) {
        const signature = known[selector];
        assert.ok(signature, `${selector} (${description}) matches no error in the built contracts`);
        const name = signature.split('(')[0];
        assert.ok(
            description.startsWith(name),
            `${selector} is ${signature} but the script calls it "${description}"`,
        );
    }
});

test('the refusals this demonstration depends on are all in the table', async () => {
    // Narrower than "every error is covered", on purpose. Most of BatasApp's errors cannot be
    // reached by a read-only quote against a live position. These three can, and they are the ones
    // a viewer needs named rather than shown as hex.
    const known = await selectorsFromArtifacts();
    for (const signature of [
        'MandateNameNotHeld(address,address)',
        'MandateNameLapsed(uint64,uint256)',
        'MandateAmountInExceeded(uint256,uint256)',
        'DeadlineReached(uint256)',
    ]) {
        const selector = toFunctionSelector(signature).toLowerCase();
        assert.ok(known[selector], `${signature} is not declared by any built contract`);
        assert.ok(ERRORS[selector], `${signature} would print as bare hex`);
    }
});

const ok = (out) => ({ ok: true, amountOut: out });
const refused = (why) => ({ ok: false, why });

test('the claim is the shape, not the middle failure', () => {
    assert.equal(verdict({
        before: ok(1952840679837944719n),
        during: refused('MandateNameNotHeld'),
        after: ok(1952840679837944719n),
    }).gated, true);
});

test('a position that was already refusing proves nothing', () => {
    // Without this, a broken position passes the demonstration: the middle quote fails because
    // everything fails, and "refused while the name was gone" is true for the wrong reason.
    const v = verdict({ before: refused('something else'), during: refused('x'), after: ok(1n) });
    assert.equal(v.gated, false);
    assert.match(v.reason, /already refusing/);
});

test('a name that was revoked and changed nothing is the failure being looked for', () => {
    const v = verdict({ before: ok(1n), during: ok(1n), after: ok(1n) });
    assert.equal(v.gated, false);
    assert.match(v.reason, /did not stop the settlement/);
});

test('a position that never comes back has not demonstrated a switch', () => {
    // A switch that only turns off is a break. The re-grant has to restore it or the claim is
    // "revoking ends the position permanently", which is a different and much worse property.
    const v = verdict({ before: ok(1n), during: refused('x'), after: refused('still broken') });
    assert.equal(v.gated, false);
    assert.match(v.reason, /did not come back/);
});

test('and it has to come back at the same price it left at', () => {
    // The re-grant bumps the registry's version counter, so the name has a new token id afterwards.
    // If anything about that changed what the position is worth, the two quotes would differ — and
    // a demonstration that moved the price while proving a point about authority would be showing
    // two things and claiming one.
    const v = verdict({ before: ok(1952840679837944719n), during: refused('x'), after: ok(1952840679000000000n) });
    assert.equal(v.gated, false);
    assert.match(v.reason, /different price/);
});
