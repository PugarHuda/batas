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
        const m = line.trim().match(/^CASE (\S+) (\d+) (\d+) (\d+) (\d+) (\d+) (0x[0-9a-fA-F]{40}) (0x[0-9a-fA-F]{40}) (\S+) (0x[0-9a-fA-F]*)$/);
        if (!m) continue;
        cases.push({
            label: m[1],
            maxAmountIn: BigInt(m[2]),
            minRateE18: BigInt(m[3]),
            expiry: BigInt(m[4]),
            feeBps: Number(m[5]),
            salt: BigInt(m[6]),
            nameRegistry: m[7],
            nameHolder: m[8],
            nameLabel: m[9] === '-' ? '' : m[9],
            program: m[10].toLowerCase(),
        });
    }
    return cases;
}

const cases = solidityCases();

test('the Solidity dumper produced cases to compare against', () => {
    assert.ok(cases.length >= 6, `expected at least 6 cases, parsed ${cases.length}`);
});

for (const c of cases) {
    test(`encoders agree byte for byte: ${c.label}`, () => {
        const fromJs = toProgram({
            // DumpPrograms.s.sol builds every case with tokenIn 0x1111 and tokenOut 0x2222.
            tokenIn: '0x0000000000000000000000000000000000001111',
            tokenOut: '0x0000000000000000000000000000000000002222',
            maxAmountIn: c.maxAmountIn,
            minRateE18: c.minRateE18,
            expiry: c.expiry,
            feeBps: c.feeBps,
            salt: c.salt,
            nameRegistry: c.nameRegistry,
            nameHolder: c.nameHolder,
            nameLabel: c.nameLabel,
        }).toLowerCase();

        assert.equal(
            fromJs,
            c.program,
            `JavaScript and Solidity disagree on "${c.label}".\n  solidity ${c.program}\n  javascript ${fromJs}`,
        );
    });
}

test('the kill switch is among the cases, and survives the round trip', () => {
    // A variable-length field is where two encoders drift most easily: they have to agree about the
    // length byte as well as the bytes it counts. Without a case carrying one, parity would be
    // proved only for the fixed-width half of the format.
    const named = cases.filter((c) => c.nameLabel !== '');
    assert.ok(named.length >= 2, `expected cases carrying a mandate name; found ${named.length}`);
    for (const c of named) {
        assert.ok(c.program.includes('22'), `"${c.label}" should carry a MandateName instruction`);
        assert.ok(
            c.program.includes(Buffer.from(c.nameLabel, 'utf8').toString('hex')),
            `"${c.label}" should carry the label bytes themselves`,
        );
    }
});

test('every compiled mandate carries an expiry', () => {
    // The bug this file exists for: a program without Deadline is a grant that never ends.
    for (const c of cases) {
        assert.ok(c.program.includes('2005'), `"${c.label}" has no Deadline instruction`);
    }
});
