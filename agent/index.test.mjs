// What importing the library costs, which should be nothing.
//
// A barrel that reads `.env` or opens a connection on import is a library that behaves differently
// on the author's machine than on anyone else's. So this points dotenv at a file that does not
// exist before anything loads, watches `fetch`, and then imports.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.DOTENV_CONFIG_PATH = '/nonexistent/.env';
delete process.env.HEDERA_AGENT_KEY;

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { calls.push(args); return realFetch(...args); };

const batas = await import('./index.mjs');
globalThis.fetch = realFetch;

test('importing the barrel reads no .env and reaches no network', () => {
    assert.equal(process.env.HEDERA_AGENT_KEY, undefined, '.env was read');
    assert.deepEqual(calls, [], 'something fetched on import');
});

test('everything promised is exported', () => {
    for (const name of [
        'decode', 'explain', 'toProgram', 'decideMandate', 'volatilityBudget', 'clearsFloor', 'OP',
        'lookupMandate', 'lookupRevocations', 'mandateNameStatus', 'classifyName', 'resolveAgent', 'vouchesFor',
        'readReputation', 'feedbackFromTrade', 'latestProgramOnChain', 'programFromStrategy',
        'decodeAnswer', 'publicationAnswer', 'authorityAnswer', 'reputationAnswer', 'nameAnswer', 'paymentsAnswer', 'client',
    ]) {
        assert.equal(typeof batas[name], name === 'OP' ? 'object' : 'function', name);
    }
    assert.match(batas.deployment.ROUTER, /^0x/);
});

test('the client is built lazily and calls the free routes with the right shapes', async () => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
        seen.push([url, init]);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
        const c = batas.client('https://example.test');
        assert.deepEqual(await c.decode('0x00'), { ok: true });
        await c.authority({ label: 'agent' });
        await c.reputation();
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.equal(seen[0][0], 'https://example.test/v1/mandate/decode');
    assert.equal(seen[0][1].method, 'POST');
    assert.equal(seen[0][1].body, JSON.stringify({ program: '0x00' }));
    assert.equal(seen[1][0], 'https://example.test/v1/agent/authority?label=agent');
    assert.equal(seen[2][0], 'https://example.test/v1/agent/reputation?');
});

test('a service error is thrown with its status rather than returned as an answer', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'program must be a 0x hex string' }), { status: 400 });
    try {
        await assert.rejects(() => batas.client('https://example.test').decode('nope'), (e) => {
            assert.equal(e.status, 400);
            assert.match(e.message, /0x hex/);
            return true;
        });
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('decode works offline through the barrel', () => {
    const program = batas.toProgram({
        tokenIn: '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B',
        tokenOut: '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81',
        maxAmountIn: 5n * 10n ** 18n, minRateE18: 2n * 10n ** 18n, expiry: 1788706874n, feeBps: 30000, salt: 1n,
    });
    assert.equal(batas.explain(program).guarded, true);
});

// --- the client against a real service --------------------------------------
//
// The shape test above fakes fetch, which proves the URL is built right and nothing else. These
// start the actual service on a port of their own and ask it, so the client, the route and the
// answer behind it are checked together against Sepolia and the public mirror node.

const PORT = Number(process.env.BATAS_SDK_TEST_PORT || 4350);
const LOCAL = `http://127.0.0.1:${PORT}`;
// The first recorded payment, the same one agent/payment-trail.test.mjs pins.
const AGENT_ACCOUNT = '0.0.10388401';
const FIRST_PAYMENT = { sequenceNumber: 16, transaction: '0.0.7162784@1789303433.642299625' };

test('against a local service, name() and payments() answer from the chain and the mirror node', async (t) => {
    // The parent pointed dotenv at nothing to prove the barrel reads no .env; the service is a
    // separate program that does need its own, so the child gets the variable back.
    const env = { ...process.env, PORT: String(PORT), HEDERA_SERVICE_ID: process.env.HEDERA_SERVICE_ID || '0.0.10388560' };
    delete env.DOTENV_CONFIG_PATH;
    const service = spawn(process.execPath, [fileURLToPath(new URL('./service.mjs', import.meta.url))], {
        env, cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore',
    });
    t.after(() => service.kill());

    const exited = new Promise((resolve) => service.once('exit', (code) => resolve(code)));
    for (let i = 0; ; i++) {
        const up = await fetch(`${LOCAL}/`).then((r) => r.ok, () => false);
        if (up) break;
        const code = await Promise.race([exited, sleep(250).then(() => undefined)]);
        assert.equal(code, undefined, `the service exited with ${code} before answering; is port ${PORT} free?`);
        assert.ok(i < 120, `the service did not answer on ${LOCAL} within 30s`);
    }

    const c = batas.client(LOCAL);

    await t.test('name() resolves the agent and its ENSIP-25 link', async () => {
        const n = await c.name();
        assert.equal(n.name, batas.deployment.ENS_NAME);
        assert.match(n.address, /^0x[0-9a-fA-F]{40}$/);
        assert.match(n.text['agent-endpoint[mcp]'], /\/mcp$/);
        assert.equal(n.erc8004.agentId, batas.deployment.AGENT_ID);
        assert.equal(n.erc8004.linked, true, 'the name and the identity name each other');

        await assert.rejects(() => c.name({ name: 'vitalik.eth' }), (e) => {
            assert.equal(e.status, 400);
            assert.match(e.message, /under batas\.eth/);
            return true;
        });
    });

    await t.test('payments() returns the verified trail, bounded by limit', async () => {
        const all = await c.payments({ payer: AGENT_ACCOUNT, limit: 100 });
        assert.equal(all.topic, batas.deployment.HCS_TOPIC);
        assert.ok(all.total >= 2, `at least the two recorded payments; saw ${all.total}`);
        assert.equal(all.payments.length, Math.min(all.total, 100));
        const first = all.payments.find((p) => p.sequenceNumber === FIRST_PAYMENT.sequenceNumber);
        assert.ok(first, `record #${FIRST_PAYMENT.sequenceNumber} is in the trail`);
        assert.equal(first.transaction, FIRST_PAYMENT.transaction);
        assert.equal(first.verified, true, first.reason);
        assert.equal(first.result, 'SUCCESS');
        assert.equal(all.verifiedCount, all.payments.filter((p) => p.verified === true).length);

        // The newest one, not the oldest: a limit is a window on the recent end of the trail.
        const one = await c.payments({ payer: AGENT_ACCOUNT, limit: 1 });
        assert.equal(one.limit, 1);
        assert.equal(one.payments.length, 1);
        assert.equal(one.total, all.total, 'the totals describe the whole trail, not the window');
        assert.equal(one.payments[0].sequenceNumber, Math.max(...all.payments.map((p) => p.sequenceNumber)));

        assert.equal((await c.payments()).limit, 20, 'the default window');

        for (const bad of [{ limit: 0 }, { limit: 101 }, { payer: 'not-an-account' }]) {
            await assert.rejects(() => c.payments(bad), (e) => e.status === 400, JSON.stringify(bad));
        }
    });
});
