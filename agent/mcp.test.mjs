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

import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

import { createServer } from './mcp.mjs';
import { TOOLS } from './tools.mjs';
import { openapiDocument } from './openapi.mjs';
import { xycSwap, salt } from './swapvm.mjs';

const LIVE_PROGRAM =
    '0x212100000000000000006367be30fcbd45ea00000000000000001aeff914e72b45e8802005006acd0476222e945800Bd6CDd60521B64a12D7b3F12fC90916a6B39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E056167656e74700300753050000208000000006aa5dc37';

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
    assert.deepEqual(names, [
        'check_agent_authority', 'check_payment_trail', 'check_publication', 'inspect_mandate_paid', 'read_mandate', 'resolve_agent_name',
    ]);

    // The paid one has to announce itself as paid in the text the model reads, not only in its
    // name. A model that discovers the cost by being charged has discovered it too late.
    const paid = tools.find((t) => t.name === 'inspect_mandate_paid');
    assert.match(paid.description, /SPENDS MONEY/);
    assert.match(paid.description, /0\.001 HBAR/);
    assert.match(paid.description, /free tools first/i);

    for (const free of ['read_mandate', 'check_publication', 'check_agent_authority', 'resolve_agent_name', 'check_payment_trail']) {
        const t = tools.find((x) => x.name === free);
        assert.match(t.description, /\bFree\b/i, `${free} must say it is free`);
        // A client that honours hints would otherwise treat a read as a write and ask before each call.
        assert.equal(t.annotations.readOnlyHint, true, `${free} is read-only`);
        assert.equal(t.annotations.destructiveHint, false, `${free} is not destructive`);
    }
    // And the two newest say what they do not cost, not only that they are free.
    assert.match(tools.find((t) => t.name === 'resolve_agent_name').description, /no payment is asked for or made/);
    assert.match(tools.find((t) => t.name === 'check_payment_trail').description, /nothing is paid/);
});

test('read_mandate decodes a program without touching the network', async () => {
    const client = await connected();
    const out = parse(await client.callTool({ name: 'read_mandate', arguments: { program: LIVE_PROGRAM } }));

    assert.equal(out.guarded, true);
    assert.equal(out.mandate.minRateFormatted, '1.941043832593008104');
    assert.equal(out.mandate.curve, 'constant product (x*y=k)');
    assert.deepEqual(out.instructions.map((i) => i.name), ['POLICY_ENVELOPE', 'DEADLINE', 'MANDATE_NAME', 'FEE_FLAT_IN', 'XYC_SWAP', 'SALT']);
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

test('authority carries why it ended, not only that it did', async () => {
    // This replaced a test that could no longer fail. It deleted an environment variable the tool
    // had already read at import, so the guard it checked was unreachable — and once the live
    // deployment became the default, the "not configured" case stopped existing at all.
    //
    // What is still worth pinning is the distinction an assistant actually needs: a grant that ran
    // out and one the owner pulled call for different responses, and a result that only said
    // "invalid" would collapse them.
    const client = await connected();
    const out = parse(await client.callTool({ name: 'check_agent_authority', arguments: {} }));

    assert.equal(typeof out.valid, 'boolean');
    assert.equal(typeof out.revoked, 'boolean', 'revocation must be reported as its own fact');
    assert.ok(!(out.valid && out.revoked), 'a live name cannot also be a revoked one');
    if (!out.valid) assert.match(out.reason, /revoked|expired|no mandate name|is held by/);
});

test('an unknown label is answered, not guessed at', async () => {
    const client = await connected();
    const out = parse(await client.callTool({
        name: 'check_agent_authority', arguments: { label: 'no-such-mandate-name' },
    }));
    assert.equal(out.valid, false);
    assert.equal(out.revoked, false, 'a name that was never granted was not revoked');
    assert.match(out.reason, /no mandate name/);
});

test('called with no program, the tools read the live position', async () => {
    // The default path, and the one an assistant actually takes first: "what does the position
    // enforce right now". It resolves through latestProgramOnChain, so a break there would show up
    // here rather than as a confusing answer to a question nobody could see was misdirected.
    const client = await connected();
    const out = parse(await client.callTool({ name: 'read_mandate', arguments: {} }));

    assert.match(out.source, /^live position 0x[0-9a-f]{64}$/i, 'the answer must say what it read');
    assert.equal(out.guarded, true);
    assert.ok(out.mandate.expiry !== null, 'the live mandate carries a deadline');
});

test('the publication tool agrees with the mandate tool about which position that is', async () => {
    // Two tools, one live position. If they resolved differently an assistant could be told the
    // limits of one grant and the publication record of another, and nothing would look wrong.
    const client = await connected();
    const read = parse(await client.callTool({ name: 'read_mandate', arguments: {} }));
    const pub = parse(await client.callTool({ name: 'check_publication', arguments: {} }));
    assert.equal(pub.source, read.source);
});

// --- the tools and the HTTP document describe one interface ------------------
//
// An assistant reads the tool schema and a code generator reads the OpenAPI document, and both are
// told they are asking the same question. So a tool may not take an input its route does not, and
// what a tool returns must be a body its route's schema accepts.

const described = openapiDocument({ origin: 'https://example.invalid', price: '0.001 HBAR', network: 'hedera:testnet', payTo: '0.0.1' });
const operation = (id) => Object.values(described.paths).flatMap((ops) => Object.values(ops)).find((op) => op.operationId === id);
const resolve = (schema) => (schema?.$ref ? described.components.schemas[schema.$ref.split('/').pop()] : schema);
const validator = new AjvJsonSchemaValidator();
const conforms = (ref, data) => validator.getValidator({ $ref: `#/components/schemas/${ref}`, components: described.components })(data);

test('every tool input is one its HTTP route also takes', async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    for (const tool of tools) {
        const op = operation(tool.name);
        assert.ok(op, `${tool.name} has no operation of the same id in /openapi.json`);
        const http = new Set([
            ...(op.parameters ?? []).map((p) => p.name),
            ...Object.keys(resolve(op.requestBody?.content['application/json'].schema)?.properties ?? {}),
        ]);
        for (const input of Object.keys(tool.inputSchema.properties ?? {})) {
            assert.ok(http.has(input), `${tool.name} takes "${input}", which ${op.operationId} over HTTP does not`);
        }
    }
});

test('what the tools return is what the document says the routes return', async () => {
    const client = await connected();
    const decoded = await client.callTool({ name: 'read_mandate', arguments: { program: LIVE_PROGRAM } });
    const d = conforms('Decoded', decoded.structuredContent);
    assert.ok(d.valid, d.errorMessage);

    const authority = await client.callTool({ name: 'check_agent_authority', arguments: { label: 'no-such-mandate-name' } });
    const a = conforms('Authority', authority.structuredContent);
    assert.ok(a.valid, a.errorMessage);

    const name = await client.callTool({ name: 'resolve_agent_name', arguments: {} });
    const n = conforms('Name', name.structuredContent);
    assert.ok(n.valid, n.errorMessage);

    const trail = await client.callTool({ name: 'check_payment_trail', arguments: { limit: 2 } });
    const p = conforms('Payments', trail.structuredContent);
    assert.ok(p.valid, p.errorMessage);

    // And the check can fail, or the ones above prove nothing.
    assert.equal(conforms('Authority', { label: 'agent' }).valid, false);
    assert.equal(conforms('Payments', { ...trail.structuredContent, payments: [{ payer: '0.0.1' }] }).valid, false);
});

test('a deadline that is not unix seconds is refused before the chain is asked', async () => {
    // It used to be dropped: the HTTP route turned "abc" into NaN and the answer quietly ignored it,
    // so the caller was told about a question they had not asked.
    const client = await connected();
    for (const grantedUntil of [-1, 1.5]) {
        const res = await client.callTool({ name: 'check_agent_authority', arguments: { grantedUntil } });
        assert.equal(res.isError, true, `${grantedUntil} must be refused`);
        assert.match(res.content[0].text, /non-negative integer/);
    }
});

test('answers go out structured as well as as text, and the two agree', async () => {
    // A client that reads `structuredContent` should never have to parse the text block back into
    // JSON — and if the two ever diverged, two kinds of client would be told two different things.
    const client = await connected();
    const res = await client.callTool({ name: 'read_mandate', arguments: { program: LIVE_PROGRAM } });
    assert.deepEqual(res.structuredContent, parse(res));
    assert.equal(res.structuredContent.guarded, true);
});

// --- the name and the payment trail -----------------------------------------

// The first recorded payment, the same one agent/payment-trail.test.mjs pins.
const AGENT_ACCOUNT = '0.0.10388401';
const FIRST_PAYMENT = { sequenceNumber: 16, transaction: '0.0.7162784@1789303433.642299625' };

test('resolve_agent_name resolves the agent and checks its ENSIP-25 link both ways', async () => {
    const client = await connected();
    const out = parse(await client.callTool({ name: 'resolve_agent_name', arguments: {} }));
    assert.equal(out.name, 'agent.batas.eth');
    assert.match(out.text['agent-endpoint[mcp]'], /\/mcp$/);
    assert.equal(out.erc8004.forward, true);
    assert.equal(out.erc8004.reverse, true);
    assert.equal(out.erc8004.linked, true);
});

test('resolve_agent_name refuses names that are not the project\'s', async () => {
    // A free tool that resolved any name would be a Sepolia RPC relay for whoever holds the client.
    const client = await connected();
    const res = await client.callTool({ name: 'resolve_agent_name', arguments: { name: 'vitalik.eth' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /under batas\.eth/);
});

test('check_payment_trail lists the recorded payment as verified against the ledger', async () => {
    const client = await connected();
    const out = parse(await client.callTool({ name: 'check_payment_trail', arguments: { payer: AGENT_ACCOUNT, limit: 100 } }));
    const first = out.payments.find((p) => p.sequenceNumber === FIRST_PAYMENT.sequenceNumber);
    assert.ok(first, `record #${FIRST_PAYMENT.sequenceNumber} is in the trail`);
    assert.equal(first.verified, true, first.reason);
    assert.equal(first.transaction, FIRST_PAYMENT.transaction);
    assert.match(first.ledger, /mirrornode\.hedera\.com/);
    assert.ok(out.total >= 2, `at least the two recorded payments; saw ${out.total}`);
});

test('check_payment_trail holds limit to its bounds, over MCP as over HTTP', async () => {
    const client = await connected();
    const one = parse(await client.callTool({ name: 'check_payment_trail', arguments: { limit: 1 } }));
    assert.equal(one.payments.length, 1);
    for (const limit of [0, 101, 1.5]) {
        // The schema refuses these before the handler runs. Whether the SDK reports that as a tool
        // error or a protocol error, it must not come back as an answer.
        const res = await client.callTool({ name: 'check_payment_trail', arguments: { limit } })
            .catch((e) => ({ isError: true, content: [{ text: e.message }] }));
        assert.equal(res.isError, true, `limit ${limit} must be refused`);
    }
});

// --- the Hedera Agent Kit plugin ---------------------------------------------
//
// Driven through the kit's own LangChain toolkit, which is how a kit user reaches it: the toolkit
// registers the plugin, wraps each tool and stringifies what `execute` returns. Batas does not
// depend on the kit, so without it installed this is skipped and says so; any other import failure
// is a failure.

const kitAdapter = await import('./adapters/hedera-agent-kit.mjs').catch((e) => e);
const kitMissing = kitAdapter instanceof Error && kitAdapter.code === 'ERR_MODULE_NOT_FOUND' && /'hedera-agent-kit'/.test(kitAdapter.message);

test('the Hedera Agent Kit plugin offers every tool, and the new ones answer through the kit', {
    skip: kitMissing && 'hedera-agent-kit is not installed; Batas does not depend on it',
}, async () => {
    if (kitAdapter instanceof Error) throw kitAdapter;
    const { HederaLangchainToolkit } = await import('hedera-agent-kit');
    const { Client } = await import('@hashgraph/sdk');
    // A client with no operator: the kit insists on a network, and no Batas tool signs with it.
    const toolkit = new HederaLangchainToolkit({ client: Client.forTestnet(), configuration: { plugins: [kitAdapter.batasPlugin] } });
    const tools = Object.fromEntries(toolkit.getTools().map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(tools).sort(), Object.keys(TOOLS).sort());

    const name = JSON.parse(await tools.resolve_agent_name.invoke({}));
    assert.equal(name.raw.name, 'agent.batas.eth');
    assert.equal(name.raw.erc8004.linked, true);

    const trail = JSON.parse(await tools.check_payment_trail.invoke({ payer: AGENT_ACCOUNT, limit: 100 }));
    const first = trail.raw.payments.find((p) => p.sequenceNumber === FIRST_PAYMENT.sequenceNumber);
    assert.equal(first?.verified, true, first?.reason);

    // A refusal reaches the kit in the kit's own error shape rather than as an exception it cannot parse.
    const refused = JSON.parse(await tools.resolve_agent_name.invoke({ name: 'vitalik.eth' }));
    assert.match(refused.raw.error, /under batas\.eth/);
});
