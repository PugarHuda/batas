// The JavaScript encoder and the Solidity one must produce identical bytes.
//
//   node --test agent/encoder-parity.test.mjs
//
// A SwapVM program is just bytes, so nothing on chain objects to an agent shipping something the
// project's own compiler would never emit. That makes a divergence between the two encoders
// silent by nature, and the first version of the agent had one: it dropped the Deadline
// instruction, so every mandate it granted was authority with no end.
//
// This test runs the Solidity encoder through forge and compares it against the JavaScript one
// case by case, so that class of bug cannot come back unnoticed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { toProgram } from './swapvm.mjs';

/** forge is not always on PATH in a fresh shell; fall back to foundryup's install location. */
function forgeBinary() {
    const local = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'forge.exe' : 'forge');
    return existsSync(local) ? local : 'forge';
}

function solidityCases() {
    const out = execFileSync(
        forgeBinary(),
        ['script', 'script/DumpPrograms.s.sol:DumpPrograms'],
        // fileURLToPath, not URL.pathname: the repository path contains a space, and pathname
        // hands back the percent-encoded form which is not a directory anyone can cd into.
        { encoding: 'utf8', cwd: dirname(dirname(fileURLToPath(import.meta.url))) },
    );

    const cases = [];
    for (const line of out.split('\n')) {
        const m = line.trim().match(/^CASE (\S+) (\d+) (\d+) (\d+) (\d+) (\d+) (0x[0-9a-fA-F]*)$/);
        if (!m) continue;
        cases.push({
            label: m[1],
            maxAmountIn: BigInt(m[2]),
            minRateE18: BigInt(m[3]),
            expiry: BigInt(m[4]),
            feeBps: Number(m[5]),
            salt: BigInt(m[6]),
            program: m[7].toLowerCase(),
        });
    }
    return cases;
}

const cases = solidityCases();

test('the Solidity dumper produced cases to compare against', () => {
    assert.ok(cases.length >= 4, `expected at least 4 cases, parsed ${cases.length}`);
});

for (const c of cases) {
    test(`encoders agree byte for byte: ${c.label}`, () => {
        const fromJs = toProgram({
            maxAmountIn: c.maxAmountIn,
            minRateE18: c.minRateE18,
            expiry: c.expiry,
            feeBps: c.feeBps,
            salt: c.salt,
        }).toLowerCase();

        assert.equal(
            fromJs,
            c.program,
            `JavaScript and Solidity disagree on "${c.label}".\n  solidity ${c.program}\n  javascript ${fromJs}`,
        );
    });
}

test('every compiled mandate carries an expiry', () => {
    // The bug this file exists for: a program without Deadline is a grant that never ends.
    for (const c of cases) {
        assert.ok(c.program.includes('2005'), `"${c.label}" has no Deadline instruction`);
    }
});
