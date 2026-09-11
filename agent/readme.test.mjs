// The README is a claim about the world, so it is checked like one.
//
// Every address, account and topic this project points a reader at is a link a judge or a user will
// click. A dead one costs more than a missing paragraph: it says the thing was described rather
// than built. Two of these went wrong already — an ERC-8004 registration naming a GitHub URL that
// did not exist, and a registry address copied from a write-up that holds code on mainnet only and
// reads as empty on Sepolia, which looks exactly like a correct address for an unregistered agent.
//
// So this walks the README, pulls out everything it points at, and asks the chain.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { SEPOLIA_RPC } from './deployment.mjs';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const unique = (xs) => [...new Set(xs)];
const found = (re) => unique(readme.match(re) ?? []);

const client = createPublicClient({
    chain: sepolia,
    transport: http(SEPOLIA_RPC),
});

/** The deployment table only — not every linked address, since some are accounts on purpose. */
function deployedContracts() {
    const from = readme.indexOf('### Live on Sepolia');
    const to = readme.indexOf('### Live on Hedera testnet');
    assert.ok(from !== -1 && to > from, 'the deployment table has moved or been renamed');
    return unique(
        (readme.slice(from, to).match(/etherscan\.io\/address\/(0x[0-9a-fA-F]{40})/g) ?? [])
            .map((m) => m.split('/').pop()),
    );
}

test('every contract in the deployment table holds code on Sepolia', async () => {
    const addresses = deployedContracts();
    assert.ok(addresses.length >= 6, `expected six or more contracts listed; found ${addresses.length}`);

    for (const address of addresses) {
        const code = await client.getCode({ address });
        assert.ok(code && code !== '0x', `${address} is in the deployment table but holds no code`);
    }
});

test('the tokens the walkthrough says were paid out are actually there', async () => {
    // The recipient is an address nobody holds the key for — keccak256("batas.demo.recipient") —
    // so it has no code and has never sent a transaction. Checking it exists proves nothing; what
    // the README claims is that a specific amount of tokenB arrived, and that is checkable.
    // Parsed in steps rather than with one regex spanning a line break: the amount, then the
    // address it is stated to have gone to.
    const stated = readme.match(/\*\*([0-9.]+) tokenB\*\* out to/);
    const after = stated ? readme.slice(readme.indexOf(stated[0])) : '';
    const to = after.match(/etherscan\.io\/address\/(0x[0-9a-fA-F]{40})/);
    const claim = stated && to ? [null, stated[1], to[1]] : null;
    assert.ok(claim, 'the walkthrough should state an amount and the address it went to');

    const [, amount, recipient] = claim;
    const tokenB = readme.match(/Demo token B \| \[`(0x[0-9a-fA-F]{40})`\]/)[1];

    const balance = await client.readContract({
        address: tokenB,
        abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
        functionName: 'balanceOf',
        args: [recipient],
    });

    const claimed = BigInt(Math.round(Number(amount) * 1e9)) * 10n ** 9n;
    assert.ok(
        balance >= claimed,
        `the README says ${amount} tokenB went to ${recipient}, which holds ${balance}`,
    );
});

test('the contracts named in prose are the ones actually linked', async () => {
    // A table that links one router and prose that names another is the kind of drift nobody
    // notices until someone tries to reproduce a result.
    for (const [label, address] of [
        ['Aqua', '0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a'],
        ['ERC-8004 identity registry', '0x8004A818BFB912233c491871b3d84c89A494BD9e'],
    ]) {
        assert.ok(readme.includes(address), `${label} ${address} is no longer mentioned in the README`);
        const code = await client.getCode({ address });
        assert.ok(code && code !== '0x', `${label} ${address} holds no code on Sepolia`);
    }
});

test('the HCS topic the README publishes exists and holds the mandate it claims', async () => {
    const topics = unique(
        (readme.match(/topics\/(\d+\.\d+\.\d+)/g) ?? []).map((m) => m.split('/').pop()),
    );
    assert.equal(topics.length, 1, `the README should name exactly one topic; found ${topics.join(', ')}`);

    const res = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/topics/${topics[0]}/messages?limit=25&order=asc`);
    assert.equal(res.status, 200, `topic ${topics[0]} is not readable on the public mirror node`);

    const { messages } = await res.json();
    assert.ok(messages.length > 0, 'the topic the README sends readers to has nothing in it');

    // And the decoded example in the README has to be one of the records actually on it, or the
    // walkthrough is describing a run that no longer exists.
    const shown = readme.match(/topic \d+\.\d+\.\d+ #(\d+)\)/);
    assert.ok(shown, 'the worked example should name the sequence number it is quoting');
    assert.ok(
        messages.some((m) => String(m.sequence_number) === shown[1]),
        `the README quotes sequence #${shown[1]}, which is not on topic ${topics[0]}`,
    );
});

test('the Hedera accounts the README links to exist', async () => {
    const accounts = unique(
        (readme.match(/hashscan\.io\/testnet\/account\/(\d+\.\d+\.\d+)/g) ?? []).map((m) => m.split('/').pop()),
    );
    assert.ok(accounts.length >= 2, 'the paying and paid accounts should both be linked');

    for (const id of accounts) {
        const res = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${id}`);
        assert.equal(res.status, 200, `account ${id} is linked from the README but not found on Hedera testnet`);
    }
});

test('the addresses that resolve to nothing here are never given in a usable form', async () => {
    // The trap: the ERC-8004 addresses that circulate in write-ups (0x8004A169…, 0x8004BAa1…) hold
    // code on mainnet only and read as empty on Sepolia, which looks exactly like a correct address
    // for an unregistered agent. The README warns about them by name, and it should — a warning
    // that cannot name the thing it warns about is not much of a warning.
    //
    // So the rule is not "never mentioned" but "never usable": truncated in prose, never complete,
    // and never behind a link somebody could click and copy.
    for (const wrong of ['0x8004A169', '0x8004BAa1', '0x8004B663056e9e57']) {
        const complete = new RegExp(`${wrong}[0-9a-fA-F]{${40 - (wrong.length - 2)}}`);
        assert.ok(!complete.test(readme), `${wrong}… appears in full and could be copied out`);
        assert.ok(!readme.includes(`address/${wrong}`), `${wrong}… is linked as if it were usable`);
    }

    // Every address given in full must be one the earlier tests checked.
    //
    // The lookahead is load-bearing: without it this matches the first forty characters of every
    // 64-character transaction hash in the document and then reports each one as an address with
    // no code, which is true and entirely beside the point.
    const inFull = unique(readme.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []);
    const linked = new Set(
        found(/sepolia\.etherscan\.io\/address\/(0x[0-9a-fA-F]{40})/g).map((m) => m.split('/').pop().toLowerCase()),
    );
    const allowed = new Set([
        ...linked,
        '0x0000000000000000000000000000000000000000'.toLowerCase(),
    ]);
    // A contract must hold code; an account must have acted. Either proves the address is a real
    // participant rather than a transposed character, which is the failure this is for — a wrong
    // address is indistinguishable from a right one until someone tries to use it.
    for (const a of inFull) {
        if (allowed.has(a.toLowerCase())) continue;
        const [code, nonce] = await Promise.all([
            client.getCode({ address: a }),
            client.getTransactionCount({ address: a }),
        ]);
        assert.ok(
            (code && code !== '0x') || nonce > 0,
            `${a} is written out in full but has neither code nor any transaction on Sepolia`,
        );
    }
});

/**
 * A receipt, insisted upon.
 *
 * The default endpoint fronts a pool, and the backends in it do not all hold the same receipts:
 * one linked transaction answers on roughly half of the calls and "could not be found" on the
 * rest, independently each time. A single ask was enough to make this test claim the transaction
 * is not on Sepolia — a gap in our own RPC pool reported as a fact about the chain, which is the
 * same mistake as reporting our own bad arguments as somebody else's missing identity.
 *
 * One yes settles it. A no settles nothing, so absence has to survive being asked again, and the
 * error behind the last one is carried into the message rather than swallowed: a transport that
 * is down and a transaction that never happened must not read alike.
 */
async function receiptOf(hash, attempts = 12) {
    let last;
    for (let i = 0; i < attempts; i++) {
        const receipt = await client.getTransactionReceipt({ hash }).catch((error) => {
            last = error;
            return null;
        });
        if (receipt) return receipt;
    }
    throw new Error(
        `${hash} is linked from the README and no backend returned it in ${attempts} tries — ` +
            `last answer: ${last?.shortMessage ?? last?.message ?? 'none'}`,
    );
}

test('the expiry the README quotes is the one the live mandate carries', async () => {
    // The claim this document makes about the name is that it ends when the authority does. Two
    // places quote that moment — the name read back off chain, and the decoded program the paid
    // answer returns — and they had drifted a month apart, which makes the claim false in the one
    // spot a reader would check it. Neither is a fixed example: both describe the position this
    // repository points at, so the chain decides what they say rather than whichever run happened
    // to be pasted in.
    const { latestProgramOnChain, programFromStrategy } = await import('./inspect.mjs');
    const { decodeProgram, readMandate } = await import('./swapvm.mjs');

    const shipped = await latestProgramOnChain();
    assert.ok(shipped, 'no mandate found on chain to check the README against');
    const { expiry } = readMandate(decodeProgram(programFromStrategy(shipped.strategy)));
    assert.ok(expiry, 'the live mandate carries no deadline');

    const onChain = new Date(expiry * 1000).toISOString();
    const quoted = unique(readme.match(/^ *expir(?:y|es) +(20\d\d-\S+Z)$/gm) ?? []).map((line) =>
        line.trim().split(/\s+/).pop(),
    );
    assert.ok(quoted.length >= 2, `expected the README to quote the expiry; found ${quoted.length}`);
    for (const shown of quoted) {
        assert.equal(shown, onChain, 'the README quotes an expiry the live mandate does not carry');
    }
});

test('every Sepolia transaction the README links to actually happened', async () => {
    // These are the receipts for the claims: the mandate shipped, the swap settled, the identity
    // minted. A link that resolves to nothing turns evidence back into assertion.
    const hashes = unique(
        (readme.match(/sepolia\.etherscan\.io\/tx\/(0x[0-9a-fA-F]{64})/g) ?? []).map((m) => m.split('/').pop()),
    );
    assert.ok(hashes.length >= 2, `expected the walkthrough to link its transactions; found ${hashes.length}`);

    for (const hash of hashes) {
        const receipt = await receiptOf(hash);
        assert.equal(receipt.status, 'success', `${hash} is linked as evidence but reverted`);
    }

    // And asking again must not have turned the check into a rubber stamp: a hash that was never
    // mined has to stay refused, however many times it is asked for.
    await assert.rejects(receiptOf(`0x${'de'.repeat(32)}`), /no backend returned it/);
});
