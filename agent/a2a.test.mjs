// The A2A surface, against the live position.
//
// Nothing here is simulated. The service is the real app on an ephemeral port, the negotiation is
// priced from Sepolia at the block it reads, and the payment requirement comes from the Blocky402
// facilitator's own /supported. The round that actually pays is behind BATAS_A2A_PAID=1, because
// it spends 0.001 HBAR from HEDERA_AGENT_ID every time it runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { parseUnits } from 'viem';

process.env.HEDERA_SERVICE_ID ||= '0.0.10388560';
const { default: app } = await import('./service.mjs');
const { X402_EXTENSION } = await import('./a2a.mjs');

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
    server.closeAllConnections();
    server.close();
});

let seq = 0;
async function rpc(method, params, raw) {
    const res = await fetch(`${base}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-A2A-Extensions': X402_EXTENSION },
        body: JSON.stringify(raw ?? { jsonrpc: '2.0', id: ++seq, method, params }),
    });
    assert.equal(res.status, 200, 'JSON-RPC answers 200 whatever the outcome');
    return { res, body: await res.json() };
}
const send = (data, extra = {}) => rpc('message/send', {
    message: { kind: 'message', role: 'user', messageId: `m-${seq}`, parts: [{ kind: 'data', data }], ...extra },
});
const dataOf = (task) => task.status.message.parts.find((p) => p.kind === 'data')?.data;

test('the Agent Card declares the A2A interface, both negotiated skills, and requires the x402 extension', async () => {
    const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
    for (const field of ['name', 'description', 'url', 'version', 'protocolVersion']) assert.equal(typeof card[field], 'string', field);
    assert.match(card.url, /\/a2a$/);
    assert.equal(card.preferredTransport, 'JSONRPC');
    assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.equal(card.supportedInterfaces[0].url, card.url);
    const ext = card.capabilities.extensions.find((e) => e.uri === X402_EXTENSION);
    assert.ok(ext, 'the a2a-x402 extension is declared');
    assert.equal(ext.required, true);
    assert.ok(card.defaultInputModes.includes('application/json'));
    assert.ok(card.defaultOutputModes.includes('application/json'));
    const ids = card.skills.map((s) => s.id);
    // The existing skills stay; the card was extended, not replaced.
    for (const id of ['read_mandate', 'inspect_mandate_paid', 'negotiate-fill', 'inspect-mandate']) assert.ok(ids.includes(id), id);
});

test('JSON-RPC protocol errors carry the codes the spec assigns', async () => {
    assert.equal((await rpc(null, null, { jsonrpc: '1.0', id: 1, method: 'message/send' })).body.error.code, -32600);
    assert.equal((await rpc(null, null, [{ jsonrpc: '2.0', id: 1, method: 'tasks/get' }])).body.error.code, -32600);
    assert.equal((await rpc('tasks/nope', {})).body.error.code, -32601);
    assert.equal((await rpc('message/send', {})).body.error.code, -32602);
    assert.equal((await rpc('tasks/get', { id: 'no-such-task' })).body.error.code, -32001);
    assert.equal((await rpc('message/stream', {})).body.error.code, -32004);
    const bad = await send({ direction: 'sideways', amountIn: '1' });
    assert.equal(bad.body.error.code, -32602);
    assert.match(bad.body.error.message, /direction/);
    // Echoed, because the client asked for it.
    assert.equal(bad.res.headers.get('x-a2a-extensions'), X402_EXTENSION);
});

test('an oversized proposal under the floor is countered from the live position, then accepted with a payment requirement', async () => {
    const decoded = await (await fetch(`${base}/v1/mandate/decode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).json();
    const cap = BigInt(decoded.mandate.maxAmountIn);
    const floor = BigInt(decoded.mandate.minRateE18);

    const opening = { direction: decoded.mandate.direction, amountIn: String(Number(cap * 2n / 10n ** 16n) / 100), limitRate: '1' };
    const first = (await send(opening)).body.result;
    assert.equal(first.kind, 'task');
    assert.equal(first.status.state, 'input-required');
    assert.equal(first.status.message.metadata, undefined, 'no payment is asked for terms nobody agreed');
    const offer = dataOf(first);
    assert.equal(offer.kind, 'batas.counter-offer');
    assert.equal(offer.reasons.length, 2, 'both the size and the limit were outside the mandate');
    assert.ok(parseUnits(offer.counter.amountIn, 18) <= cap);
    assert.ok(parseUnits(offer.counter.amountIn, 18) < parseUnits(opening.amountIn, 18));
    assert.ok(parseUnits(offer.counter.limitRate, 18) >= floor, 'the counter limit is at or above the floor');
    assert.equal(offer.counter.amountIn, offer.mandate.largestClearingInputNow);
    assert.ok(offer.readAt.blockNumber > 0);

    const second = (await send(offer.counter, { taskId: first.id, contextId: first.contextId })).body.result;
    assert.equal(second.id, first.id);
    assert.equal(second.contextId, first.contextId);
    assert.equal(second.status.state, 'input-required');
    assert.equal(dataOf(second).kind, 'batas.terms-accepted');
    const meta = second.status.message.metadata;
    assert.equal(meta['x402.payment.status'], 'payment-required');
    const required = meta['x402.payment.required'];
    assert.equal(required.x402Version, 2);
    assert.match(required.resource.url, /\/a2a$/);
    const [req] = required.accepts;
    assert.equal(req.scheme, 'exact');
    assert.equal(req.network, 'hedera:testnet');
    assert.equal(req.asset, '0.0.0');
    assert.equal(req.amount, process.env.X402_PRICE_TINYBAR || '100000');
    assert.equal(req.payTo, process.env.HEDERA_SERVICE_ID);
    assert.match(req.extra.feePayer, /^0\.0\.\d+$/, 'the facilitator named its fee payer');

    const got = (await rpc('tasks/get', { id: first.id })).body.result;
    assert.equal(got.status.state, 'input-required');
    assert.equal(got.history.length, 4);

    // A payload that answers a different requirement is refused before the facilitator is asked.
    const forged = (await send(offer.counter, {
        taskId: first.id, contextId: first.contextId,
        metadata: {
            'x402.payment.status': 'payment-submitted',
            'x402.payment.payload': { x402Version: 2, accepted: { ...req, payTo: '0.0.1' }, payload: {} },
        },
    })).body.result;
    assert.equal(forged.status.state, 'input-required');
    assert.equal(forged.status.message.metadata['x402.payment.status'], 'payment-rejected');
    assert.ok(forged.status.message.metadata['x402.payment.required'], 'the requirement is issued again');

    const cancelled = (await send({ decision: 'reject' }, { taskId: first.id })).body.result;
    assert.equal(cancelled.status.state, 'canceled');
    assert.equal((await send(offer.counter, { taskId: first.id })).body.error.code, -32602);
});

test('the paid round settles on Hedera and the mirror node confirms it', { skip: !process.env.BATAS_A2A_PAID && 'set BATAS_A2A_PAID=1 to spend 0.001 HBAR' }, async () => {
    const { negotiateAndSettle } = await import('./a2a-client.mjs');
    const { task, quote, receipt, onLedger, turns } = await negotiateAndSettle({ origin: base, endpoint: `${base}/a2a` });
    assert.ok(turns.length >= 2, 'at least one counter-offer before agreement');
    assert.equal(task.status.state, 'completed');
    assert.equal(receipt.success, true);
    assert.equal(quote.kind, 'batas.firm-quote');
    assert.equal(onLedger.confirmed, true, onLedger.reason);
});
