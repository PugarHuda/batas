// Tests for the MCP surface.
//
// A tool description is not documentation, it is the interface: the model picking a tool sees only
// the name, the description and the schema, and picks wrong when they are vague about cost. So the
// checks here are less about wiring than about whether an assistant could tell, without trying it,
// which of these calls spends money.
//
// The free tools are driven end to end against a real client over an in-memory transport, and the
// paid one is only listed rather than called: asserting on it would settle real HBAR on every test
// run, and a test suite that spends money is one people stop running.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from './mcp.mjs';
import { xycSwap, salt } from './swapvm.mjs';

const LIVE_PROGRAM =
    '0x21200000000000000000f3e04a65862e64ff00000000000000001aaa51121b2314122005006ac57186700300753050000208000000006a9de486';

async function connected() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([client.connect(clientSide), createServer().connect(serverSide)]);
    return client;
}

const parse = (result) => JSON.parse(result.content[0].text);

test('the tools an assistant would see', async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['check_agent_authority', 'check_publication', 'inspect_mandate_paid', 'read_mandate']);

    // The paid one has to announce itself as paid in the text the model reads, not only in its
    // name. A model that discovers the cost by being charged has discovered it too late.
    const paid = tools.find((t) => t.name === 'inspect_mandate_paid');
    assert.match(paid.description, /SPENDS MONEY/);
    assert.match(paid.description, /0\.001 HBAR/);
    assert.match(paid.description, /free tools first/i);

    for (const free of ['read_mandate', 'check_publication', 'check_agent_authority']) {
        assert.match(tools.find((t) => t.name === free).description, /\bFree\b/i, `${free} must say it is free`);
    }
});

test('read_mandate decodes a program without touching the network', async () => {
    const client = await connected();
    const out = parse(await client.callTool({ name: 'read_mandate', arguments: { program: LIVE_PROGRAM } }));

    assert.equal(out.guarded, true);
    assert.equal(out.mandate.minRateFormatted, '1.92143732923348277');
    assert.equal(out.mandate.curve, 'constant product (x*y=k)');
    assert.deepEqual(out.instructions.map((i) => i.name), ['POLICY_ENVELOPE', 'DEADLINE', 'FEE_FLAT_IN', 'XYC_SWAP', 'SALT']);
});

test('a program that is not a program comes back as an error, not as an empty mandate', async () => {
    const client = await connected();
    const res = await client.callTool({ name: 'read_mandate', arguments: { program: 'not hex' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /0x hex/);
});

test('an unguarded program is reported as unguarded through the tool as well', async () => {
    // The one field worth reading first. If it survived the service but not this surface, an
    // assistant would be told a position is bounded when it is not.
    const client = await connected();
    // Built with the encoder rather than typed out: a hand-written instruction stream is exactly
    // how this project shipped a mandate with no deadline, and a malformed fixture would prove
    // nothing about the guard.
    const unguarded = xycSwap() + salt(1n).slice(2);
    const out = parse(await client.callTool({ name: 'read_mandate', arguments: { program: unguarded } }));
    assert.equal(out.guarded, false);
    assert.ok(out.notes.some((n) => /unbounded/.test(n)), JSON.stringify(out.notes));
});

test('check_publication finds the live mandate on the public mirror node', {
    skip: !process.env.BATAS_HCS_TOPIC && 'BATAS_HCS_TOPIC not set',
}, async () => {
    const client = await connected();
    const out = parse(await client.callTool({ name: 'check_publication', arguments: { program: LIVE_PROGRAM } }));
    assert.equal(out.published, true);
    assert.ok(Date.parse(out.publishedAt) > 0);
    assert.match(out.mirror, /mirrornode\.hedera\.com/);
});

test('check_publication says no for bytes nobody published', {
    skip: !process.env.BATAS_HCS_TOPIC && 'BATAS_HCS_TOPIC not set',
}, async () => {
    const client = await connected();
    const out = parse(await client.callTool({ name: 'check_publication', arguments: { program: '0xdeadbeef' } }));
    assert.equal(out.published, false);
});

test('check_agent_authority reads the live mandate name', {
    skip: !(process.env.BATAS_ENS_REGISTRY && process.env.BATAS_OWNER) && 'ENS registry or owner not set',
}, async () => {
    const client = await connected();
    const out = parse(await client.callTool({ name: 'check_agent_authority', arguments: {} }));
    assert.equal(typeof out.valid, 'boolean');
    assert.equal(typeof out.reason, 'string');
    assert.equal(typeof out.expiry, 'number');
});

test('a missing configuration is reported rather than answered as "not authorised"', async () => {
    // These two are not the same, and confusing them would have an assistant tell someone their
    // agent had been revoked when in fact nothing was ever looked up.
    const saved = process.env.BATAS_ENS_REGISTRY;
    delete process.env.BATAS_ENS_REGISTRY;
    try {
        const client = await connected();
        const res = await client.callTool({ name: 'check_agent_authority', arguments: {} });
        assert.equal(res.isError, true);
        assert.match(res.content[0].text, /must be set/);
    } finally {
        if (saved !== undefined) process.env.BATAS_ENS_REGISTRY = saved;
    }
});
