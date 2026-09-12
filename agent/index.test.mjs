// What importing the library costs, which should be nothing.
//
// A barrel that reads `.env` or opens a connection on import is a library that behaves differently
// on the author's machine than on anyone else's. So this points dotenv at a file that does not
// exist before anything loads, watches `fetch`, and then imports.

import test from 'node:test';
import assert from 'node:assert/strict';

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
        'decodeAnswer', 'publicationAnswer', 'authorityAnswer', 'reputationAnswer', 'client',
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
