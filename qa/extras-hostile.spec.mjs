import { test, expect } from '@playwright/test';

import { priceFor } from '../agent/service.mjs';
import { verifyEndpointDomains } from '../agent/domain-verify.mjs';
import { AGENT_ID } from '../agent/deployment.mjs';

// Hostile requests against the surfaces added last. Each test here was written to break something,
// and the ones that did carry the reason next to the fix in the file they broke.

const LIVE_PROGRAM =
    '0x212100000000000000006367be30fcbd45ea00000000000000001aeff914e72b45e8802005006acd0476222e945800Bd6CDd60521B64a12D7b3F12fC90916a6B39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E056167656e74700300753050000208000000006aa5dc37';

// Every test is its own caller, so the shared server's brake of twelve a minute refuses nobody for a
// request some other test made.
// Random rather than derived from the test name, so two tests never share a bucket by accident; the
// name is kept only so a reader can see which test a caller belongs to.
const caller = (_name) => ({ 'X-Forwarded-For': `10.38.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });

// `headers` may be a function, for a test that sends more than the brake allows one caller.
function rpc(request, headers) {
    return async (method, params, { raw } = {}) => {
        const res = await request.post('/a2a', {
            headers: typeof headers === 'function' ? headers() : headers,
            data: raw ?? { jsonrpc: '2.0', id: 7, method, params },
        });
        return { status: res.status(), body: await res.json() };
    };
}
const send = (message) => ({ message: { role: 'user', messageId: crypto.randomUUID(), ...message } });
const proposal = (data) => send({ parts: [{ kind: 'data', data }] });

// --- A2A: the envelope -----------------------------------------------------------

test('a2a refuses what is not one JSON-RPC 2.0 request, as JSON', async ({ request }) => {
    const call = rpc(request, caller('a2a-envelope'));
    for (const raw of [[{ jsonrpc: '2.0', id: 1, method: 'tasks/get' }], { jsonrpc: '1.0', id: 1, method: 'tasks/get' }, { jsonrpc: '2.0', id: 1 }]) {
        const { status, body } = await call(null, null, { raw });
        expect(status).toBe(200);
        expect(body.error.code, JSON.stringify(raw)).toBe(-32600);
        // The id is echoed when the request is an object that carries one, and null when it is not.
        expect(body.id).toBe(raw?.id ?? null);
    }
    const unknown = await call('tasks/list', {});
    expect(unknown.body).toMatchObject({ id: 7, error: { code: -32601 } });
    const stream = await call('message/stream', send({ parts: [] }));
    expect(stream.body.error.code).toBe(-32004);

    // Not JSON at all is refused before the route, and still as JSON rather than a page.
    const broken = await request.post('/a2a', { headers: { ...caller('a2a-envelope'), 'Content-Type': 'application/json' }, data: '{"jsonrpc":' });
    expect(broken.status()).toBe(400);
    expect(await broken.json()).toEqual({ error: 'body must be valid JSON' });

    const huge = await request.post('/a2a', { headers: caller('a2a-envelope'), data: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { pad: 'x'.repeat(300_000) } } });
    expect(huge.status()).toBe(413);
});

test('a2a: tasks/get and tasks/cancel on ids that are unknown or not ids at all', async ({ request }) => {
    const call = rpc(request, caller('a2a-ids'));
    expect((await call('tasks/get', { id: 'no-such-task' })).body.error.code).toBe(-32001);
    expect((await call('tasks/cancel', { id: 'no-such-task' })).body.error.code).toBe(-32001);
    for (const params of [undefined, {}, { id: { a: 1 } }, { id: ['x'] }, { id: 5 }]) {
        const { body } = await call('tasks/get', params);
        expect(body.error.code, JSON.stringify(params)).toBe(-32602);
    }
});

test('a2a: a taskId or contextId that is not a string does not become a task', async ({ request }) => {
    const call = rpc(request, caller('a2a-taskid'));
    for (const bad of [{ taskId: { x: 1 } }, { taskId: 12 }, { taskId: '' }, { contextId: ['c'] }]) {
        const { body } = await call('message/send', send({ ...bad, parts: [{ kind: 'data', data: { decision: 'reject' } }] }));
        expect(body.error?.code, JSON.stringify(bad)).toBe(-32602);
    }
});

// --- A2A: proposals ---------------------------------------------------------------

test('a2a refuses amounts that are negative, zero, NaN, exponent-shaped or not scalars, before any chain read', async ({ request }) => {
    const call = rpc(request, () => caller('a2a-amounts'));
    const cases = [
        { amountIn: '-1' }, { amountIn: '0' }, { amountIn: 0 }, { amountIn: '0.000' }, { amountIn: 'NaN' },
        { amountIn: '1e80' }, { amountIn: 1e80 }, { amountIn: 'Infinity' }, { amountIn: ['2.5'] }, { amountIn: { v: '2' } },
        { amountIn: true }, { amountIn: '1.0000000000000000001' }, { amountIn: ' 1' },
        { amountIn: '1', limitRate: '-2' }, { amountIn: '1', minAmountOut: 'NaN' }, { amountIn: '1', minAmountOut: ['1'] },
    ];
    for (const c of cases) {
        const { body } = await call('message/send', proposal({ direction: 'aToB', ...c }));
        expect(body.error?.code, JSON.stringify(c)).toBe(-32602);
    }
    for (const direction of [undefined, 'AtoB', 'sideways', ['aToB']]) {
        const { body } = await call('message/send', proposal({ direction, amountIn: '1' }));
        expect(body.error?.code, String(direction)).toBe(-32602);
    }
    for (const data of [undefined, null, [], 'aToB']) {
        const { body } = await call('message/send', send({ parts: data === undefined ? [] : [{ kind: 'data', data }] }));
        expect(body.error?.code, JSON.stringify(data)).toBe(-32602);
    }
});

test('a2a prices the wrong direction, both limits and neither limit against the live position', async ({ request }) => {
    test.setTimeout(180_000);
    const call = rpc(request, caller('a2a-live'));
    const settled = (task) => ['input-required', 'rejected'].includes(task.status.state);

    const wrong = (await call('message/send', proposal({ direction: 'bToA', amountIn: '0.1', limitRate: '1' }))).body.result;
    expect(settled(wrong)).toBe(true);
    const wrongData = wrong.status.message.parts.find((p) => p.kind === 'data')?.data;
    if (wrong.status.state === 'input-required') {
        // Never accepted: the router refuses bToA, so the answer is a counter in the permitted direction.
        expect(wrongData.kind).toBe('batas.counter-offer');
        expect(wrongData.counter.direction).toBe('aToB');
        expect(wrongData.reasons.join(' ')).toMatch(/only permits aToB/);
    }

    // Both limits: the stricter one is what is held to. Neither: the limit becomes the floor.
    for (const data of [{ minAmountOut: '0.01', limitRate: '0.02' }, {}]) {
        const task = (await call('message/send', proposal({ direction: 'aToB', amountIn: '0.1', ...data }))).body.result;
        expect(settled(task), JSON.stringify(data)).toBe(true);
        const out = task.status.message.parts.find((p) => p.kind === 'data')?.data;
        if (out?.kind === 'batas.counter-offer' || out?.kind === 'batas.terms-accepted') {
            const terms = out.counter ?? out.terms;
            expect(Number(terms.minAmountOut)).toBeGreaterThan(0);
            expect(Number(terms.limitRate)).toBeGreaterThanOrEqual(Number(out.mandate?.minRate ?? 0));
        }
    }

    // A size far past every cap is countered down to what clears, never accepted as sent.
    const huge = (await call('message/send', proposal({ direction: 'aToB', amountIn: '1'.repeat(60), limitRate: '1'.repeat(40) }))).body.result;
    expect(settled(huge)).toBe(true);
    expect(huge.status.message.parts.find((p) => p.kind === 'data')?.data.kind).not.toBe('batas.terms-accepted');
});

// --- A2A: payment inside the task -------------------------------------------------

async function inspectionOffer(call) {
    // A given program is checked by decoding alone, so the offer costs no chain read to obtain.
    const { body } = await call('message/send', proposal({ skill: 'inspect-mandate', program: LIVE_PROGRAM }));
    expect(body.result.status.state).toBe('input-required');
    expect(body.result.status.message.metadata['x402.payment.status']).toBe('payment-required');
    return body.result;
}

test('a2a: forged, altered and replayed payment payloads are rejected and nothing is released', async ({ request }) => {
    const call = rpc(request, caller('a2a-forged'));
    const offer = await inspectionOffer(call);
    const [accepted] = offer.status.message.metadata['x402.payment.required'].accepts;
    const pay = (payload) => call('message/send', send({
        taskId: offer.id, metadata: { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': payload }, parts: [],
    }));

    const cheaper = await pay({ x402Version: 2, accepted: { ...accepted, amount: '1' }, payload: { transaction: 'AAAA' } });
    expect(cheaper.body.result.status.message.metadata).toMatchObject({ 'x402.payment.status': 'payment-rejected', 'x402.payment.error': 'INVALID_AMOUNT' });

    for (const payload of [null, 'x', [], { x402Version: 9 }, { x402Version: 2 }]) {
        const r = await pay(payload);
        expect(r.body.result.status.message.metadata['x402.payment.status'], JSON.stringify(payload)).toBe('payment-rejected');
    }

    // The exact requirement with a transaction nobody signed: it reaches the facilitator, which refuses
    // it. The same payload sent twice is refused twice; a replay buys nothing either.
    const forged = { x402Version: 2, accepted, payload: { transaction: Buffer.from('forged').toString('base64') } };
    for (let i = 0; i < 2; i++) {
        const { body } = await pay(forged);
        const t = body.result;
        expect(t.status.state).toBe('input-required');
        expect(t.status.message.metadata['x402.payment.status']).toBe('payment-rejected');
        expect(t.status.message.metadata['x402.payment.error']).not.toBe('INVALID_AMOUNT');
        expect(t.artifacts).toBeUndefined();
    }
});

test('a2a: a payment-submitted flood is refused without the brake and without growing a task', async ({ request }) => {
    test.setTimeout(120_000);
    const headers = caller('a2a-flood');
    const call = rpc(request, headers);
    const offer = await inspectionOffer(call);
    // Paying turns skip the free brake by design, so thirty of them from one caller are all answered,
    // and every answer is a refusal carrying no chain reading: nothing past verification was run.
    let last;
    for (let i = 0; i < 30; i++) {
        last = await call('message/send', send({
            taskId: offer.id,
            metadata: { 'x402.payment.status': 'payment-submitted' },
            parts: [{ kind: 'text', text: 'x'.repeat(2_000) }],
        }));
        expect(last.status).toBe(200);
        const data = last.body.result.status.message.parts.find((p) => p.kind === 'data')?.data;
        expect(data?.readAt).toBeUndefined();
        expect(last.body.result.status.message.metadata['x402.payment.status']).toBe('payment-rejected');
    }
    // Each turn used to append two messages to the task for as long as the instance lived, and the
    // whole history came back on every answer, so one caller could grow memory and response size
    // without limit on the one path the brake does not cover.
    expect(last.body.result.history.length).toBeLessThanOrEqual(10);
    const got = await call('tasks/get', { id: offer.id });
    expect(got.body.result.history.length).toBeLessThanOrEqual(10);
});

test('a2a: a canceled task cannot be negotiated or paid again', async ({ request }) => {
    const call = rpc(request, caller('a2a-cancel'));
    const offer = await inspectionOffer(call);
    const canceled = await call('tasks/cancel', { id: offer.id });
    expect(canceled.body.result.status.state).toBe('canceled');
    expect((await call('tasks/cancel', { id: offer.id })).body.error.code).toBe(-32002);

    const again = await call('message/send', send({ taskId: offer.id, parts: [{ kind: 'data', data: { skill: 'inspect-mandate', program: LIVE_PROGRAM } }] }));
    expect(again.body.error).toMatchObject({ code: -32602, message: expect.stringMatching(/already canceled/) });
    const paid = await call('message/send', send({ taskId: offer.id, metadata: { 'x402.payment.status': 'payment-submitted' }, parts: [] }));
    expect(paid.body.error.code).toBe(-32602);
});

// --- Metering ------------------------------------------------------------------------

test('an agentId too large to encode is not billed for an operator read that cannot happen', async ({ request }) => {
    const base = Number(priceFor({ program: LIVE_PROGRAM }).total);
    const operator = 20_000;
    const max = (2n ** 256n - 1n).toString();
    const over = (2n ** 256n).toString();
    expect(Number(priceFor({ program: LIVE_PROGRAM, agentId: max }).total)).toBe(base + operator);
    // ownerOf takes a uint256, so this id fails to encode before any request leaves the service and
    // the answer can only say "not checked". The bill must not include a read that never ran.
    for (const agentId of [over, '9'.repeat(100)]) {
        expect(Number(priceFor({ program: LIVE_PROGRAM, agentId }).total), agentId.slice(0, 12)).toBe(base);
        const res = await request.post('/v1/mandate/explain', { data: { program: LIVE_PROGRAM, agentId } });
        const [hbar] = JSON.parse(Buffer.from(res.headers()['payment-required'], 'base64').toString()).accepts;
        expect(Number(hbar.amount)).toBe(base);
    }
});

// --- The name route --------------------------------------------------------------------

test('the name route refuses names outside batas.eth and names ENS cannot normalise, as the caller\'s error', async ({ request }) => {
    const headers = caller('name-hostile');
    const refusals = [
        'vitalik.eth', 'batas.eth', 'agent.batas.eth.evil.eth', 'agentbatas.eth', `${'x'.repeat(300)}.batas.eth`,
        // Not valid ENS names at all: each used to reach the resolver, fail there, and come back as a
        // 502 upstream fault telling the caller to retry a request that could never succeed.
        'xn--80ak6aa92e.batas.eth', '.batas.eth', 'a..batas.eth', '*.batas.eth', 'a_b.batas.eth', 'a b.batas.eth',
    ];
    for (const name of refusals) {
        const res = await request.get(`/v1/agent/name?name=${encodeURIComponent(name)}`, { headers });
        expect(res.status(), name.slice(0, 40)).toBe(400);
        expect((await res.json()).upstream).toBeUndefined();
    }
    const twice = await request.get('/v1/agent/name?name=agent.batas.eth&name=mandate.batas.eth', { headers });
    expect(twice.status()).toBe(400);
});

test('the name route normalises before it checks the parent, so a full-width spelling is the same name', async ({ request }) => {
    test.setTimeout(120_000);
    const res = await request.get(`/v1/agent/name?name=${encodeURIComponent('ＡＧＥＮＴ.batas.eth')}`, { headers: caller('name-fullwidth') });
    expect(res.status()).toBe(200);
    expect((await res.json()).name).toBe('agent.batas.eth');
});

// --- Domain verification -----------------------------------------------------------------

test('a domain that serves JSON null is reported as having no registrations, with a reason', async () => {
    test.setTimeout(60_000);
    // A data: URL is a real response body read through the real fetch: JSON that parses to null.
    const verdict = await verifyEndpointDomains(AGENT_ID, { originFor: () => 'data:application/json,null#' });
    expect(verdict.domains.length).toBeGreaterThan(0);
    for (const d of verdict.domains) {
        expect(d, d.domain).toMatchObject({ verified: false, reason: 'no-registrations', detail: expect.any(String) });
    }
});
