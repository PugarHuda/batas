import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';

// The paid surface, exercised the way a caller meets it: an unpaid request, the 402 that comes
// back, and what that 402 actually promises. Getting the payment requirement wrong is the failure
// that matters here — a caller would settle against the wrong network, asset or facilitator and
// still see a plausible response.

const LIVE_PROGRAM =
    '0x212100000000000000006367be30fcbd45ea00000000000000001aeff914e72b45e8802005006acd0476222e945800Bd6CDd60521B64a12D7b3F12fC90916a6B39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E056167656e74700300753050000208000000006aa5dc37';

const decodeRequirement = (header) => JSON.parse(Buffer.from(header, 'base64').toString('utf8'));

test('the free description says what is sold and what it costs', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.endpoint).toBe('POST /v1/mandate/explain');
    expect(body.network).toBe('hedera:testnet');
    expect(body.price).toBe('0.001 HBAR');
    // The Hedera track requires Blocky402 specifically; the official PoC points testnet at
    // x402.org, so this assertion is guarding against the easiest mistake in the integration.
    expect(body.facilitator).toContain('blocky402.com');
    expect(body.payTo).toMatch(/^0\.0\.\d+$/);
    // The publication topic is part of what the answer is worth, so a caller must be able to see
    // which ledger the service will check before deciding to pay for the check.
    expect(body.topic, 'the HCS topic must be advertised, not implied').toMatch(/^0\.0\.\d+$/);
    expect(body.describes).toContain('Hedera Consensus Service');
});

test('an unpaid request is refused with a payment requirement, not an error', async ({ request }) => {
    const res = await request.post('/v1/mandate/explain', { data: { program: LIVE_PROGRAM } });
    expect(res.status()).toBe(402);

    const header = res.headers()['payment-required'];
    expect(header, 'PAYMENT-REQUIRED header must be present').toBeTruthy();

    const requirement = decodeRequirement(header);
    expect(requirement.x402Version).toBe(2);
    expect(requirement.accepts).toHaveLength(1);

    const [accepts] = requirement.accepts;
    expect(accepts.scheme).toBe('exact');
    expect(accepts.network).toBe('hedera:testnet');
    expect(accepts.amount).toBe('100000'); // 0.001 HBAR in tinybars
    expect(accepts.asset).toBe('0.0.0'); // HBAR, so no HTS association is needed to pay
    expect(accepts.payTo).toMatch(/^0\.0\.\d+$/);
    // Blocky402's testnet fee payer. Settling against x402.org would carry a different one.
    expect(accepts.extra.feePayer).toBe('0.0.7162784');
});

test('the paywall covers the endpoint regardless of payload', async ({ request }) => {
    for (const data of [{}, { program: '0x' }, { program: 'not-hex' }, { nope: 1 }]) {
        const res = await request.post('/v1/mandate/explain', { data });
        expect(res.status(), `payload ${JSON.stringify(data)} must not slip past the paywall`).toBe(402);
    }
});

test('payment is demanded before validation, so a bad body cannot probe the decoder for free', async ({ request }) => {
    const res = await request.post('/v1/mandate/explain', { data: { program: 'clearly not a program' } });
    expect(res.status()).toBe(402);
    expect(await res.text()).not.toContain('not whole bytes');
});

test('an unpaid GET on the paid path is refused too', async ({ request }) => {
    const res = await request.get('/v1/mandate/explain');
    // Either the paywall rejects it or the route does not exist for GET; what must not happen is
    // an answer.
    expect([402, 404]).toContain(res.status());
});

test('an unknown path is a plain 404 and never a paywall', async ({ request }) => {
    const res = await request.post('/v1/nothing/here', { data: {} });
    expect(res.status()).toBe(404);
    expect(res.headers()['payment-required']).toBeUndefined();
});

test('the payment requirement is stable across calls', async ({ request }) => {
    const first = await request.post('/v1/mandate/explain', { data: { program: LIVE_PROGRAM } });
    const second = await request.post('/v1/mandate/explain', { data: { program: LIVE_PROGRAM } });

    const a = decodeRequirement(first.headers()['payment-required']);
    const b = decodeRequirement(second.headers()['payment-required']);
    expect(a.accepts[0]).toEqual(b.accepts[0]);
});

test('the 402 names the resource the manifest names, scheme included', async ({ request }) => {
    // The middleware derives `resource.url` from req.protocol unless told otherwise, and behind a
    // proxy that is `http`. Two names for one resource is what an indexer would have stored.
    const res = await request.post('/v1/mandate/explain', { data: { program: LIVE_PROGRAM } });
    expect(res.status()).toBe(402);
    const requirement = decodeRequirement(res.headers()['payment-required']);
    const manifest = await (await request.get('/.well-known/x402')).json();
    expect(requirement.resource.url).toBe(manifest.resources[0].url);
    expect(requirement.resource.url).toMatch(/^https:\/\//);
});

test('the discovery manifest is free, well formed, and outside the paywall', async ({ request }) => {
    // draft-hawkins-x402-dns-discovery. An indexer finds this without being told the paid URL
    // first, so it must answer 200 rather than 402 — putting discovery behind the paywall would
    // mean only someone who already knows the price can learn the price.
    const res = await request.get('/.well-known/x402');
    expect(res.status()).toBe(200);
    expect(res.headers()['payment-required']).toBeUndefined();

    const m = await res.json();
    expect(m.x402Version).toBe(2);
    expect(m.kind).toBe('resource-server');
    expect(typeof m.name).toBe('string');
    expect(Date.parse(m.updated)).toBeGreaterThan(0);

    // "Each url MUST be HTTPS and on the manifest's own domain or a subdomain." A manifest that
    // points somewhere else is one a conforming consumer must refuse to dereference.
    expect(m.resources).toHaveLength(1);
    const [r] = m.resources;
    expect(r.url).toMatch(/^https:\/\//);
    expect(r.method).toBe('POST');
    expect(r.url.endsWith('/v1/mandate/explain'), 'must name the route the paywall actually covers').toBe(true);

    // And the advertised price must be the one the 402 will demand, or the manifest is bait.
    const unpaid = await request.post('/v1/mandate/explain', { data: { program: LIVE_PROGRAM } });
    const demanded = decodeRequirement(unpaid.headers()['payment-required']).accepts[0];
    expect(r.accepts[0].amount).toBe(demanded.amount);
    expect(r.accepts[0].asset).toBe(demanded.asset);
    expect(r.accepts[0].network).toBe(demanded.network);
    expect(r.accepts[0].payTo).toBe(demanded.payTo);
});

test('the client refuses to pay more than its cap, before creating a payment', async () => {
    // The spend cap is advertised as the same idea the contracts enforce, one layer up: the agent
    // is autonomous inside a number somebody else set. Nothing checked that it binds, and a cap
    // that does not cap is decoration on the one claim this project is about.
    //
    // It runs on a key generated here rather than the real one. The refusal happens while the
    // client is building the payload — before anything is signed or sent — so an unfunded key
    // reaches it, no HBAR can move even if the assertion is wrong, and CI needs no secret.
    const saved = { ...process.env };
    process.env.HEDERA_AGENT_ID = '0.0.12345';
    process.env.HEDERA_AGENT_KEY = `0x${randomBytes(32).toString('hex')}`;
    process.env.X402_MAX_TINYBAR = '1'; // one tinybar against a price of 100,000
    process.env.BATAS_SERVICE_URL = 'http://127.0.0.1:4021';
    try {
        const { payForExplanation } = await import('../agent/inspect.mjs');
        await expect(payForExplanation(LIVE_PROGRAM)).rejects.toThrow(/spendControls|maxAmountPerPayment/i);
    } finally {
        for (const k of ['HEDERA_AGENT_ID', 'HEDERA_AGENT_KEY', 'X402_MAX_TINYBAR', 'BATAS_SERVICE_URL']) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
});

// --- HTTP edges ---------------------------------------------------------------
//
// Nothing that calls this endpoint is a browser. It is agents, indexers and facilitators, so every
// answer has to be machine-readable — including the ones that say no. Body parsing fails before any
// route sees the request, and Express answered those with an HTML error page from a service whose
// every other response is JSON.

test('a malformed body is refused as JSON, not as an HTML error page', async ({ request }) => {
    const res = await request.post('/v1/mandate/explain', {
        headers: { 'Content-Type': 'application/json' },
        data: '{broken',
    });
    expect(res.status()).toBe(400);
    expect(res.headers()['content-type']).toContain('application/json');
    expect((await res.json()).error).toMatch(/valid JSON/);
});

test('a body past the limit is refused as JSON, with the limit stated', async ({ request }) => {
    const res = await request.post('/v1/mandate/explain', {
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ program: `0x${'00'.repeat(200_000)}` }),
    });
    expect(res.status()).toBe(413);
    expect(res.headers()['content-type']).toContain('application/json');

    const body = await res.json();
    expect(body.limit).toBe(262_144);
    // A caller told "too large" without being told the size cannot fix it on the next attempt.
    expect(body.error).toMatch(/256kb/);
});

test('no route answers with HTML, whatever it is sent', async ({ request }) => {
    const attempts = [
        ['/', 'GET', undefined],
        ['/.well-known/x402', 'GET', undefined],
        ['/v1/mandate/explain', 'POST', { program: LIVE_PROGRAM }],
        ['/v1/mandate/explain', 'POST', {}],
        ['/v1/nothing/here', 'POST', {}],
    ];
    for (const [path, method, data] of attempts) {
        const res = method === 'GET'
            ? await request.get(path)
            : await request.post(path, { data });
        const type = res.headers()['content-type'] ?? '';
        expect(type, `${method} ${path} answered ${type}`).not.toContain('text/html');
    }
});

// --- the one surface meant for a person -------------------------------------
//
// Adding HTML to a service whose whole point is that it never answers HTML needs to be pinned from
// both sides, or the next person to read the suite cannot tell an exception from an erosion.

test('a browser gets a page; everything else still gets JSON', async ({ request }) => {
    const html = await request.get('/', { headers: { Accept: 'text/html,application/xhtml+xml' } });
    expect(html.status()).toBe(200);
    expect(html.headers()['content-type']).toContain('text/html');
    const body = await html.text();
    expect(body).toContain('<title>Batas');
    // The page must not reach for the paid route: everything on it is one of the free answers.
    expect(body).not.toContain('/v1/mandate/explain');

    for (const accept of ['*/*', 'application/json']) {
        const res = await request.get('/', { headers: { Accept: accept } });
        expect(res.headers()['content-type'], `Accept: ${accept}`).toContain('application/json');
        expect((await res.json()).service).toBe('Batas mandate inspection');
    }
});

test('and the page can link to its own JSON without being handed itself again', async ({ request }) => {
    const res = await request.get('/?format=json', { headers: { Accept: 'text/html' } });
    expect(res.headers()['content-type']).toContain('application/json');
    expect((await res.json()).service).toBe('Batas mandate inspection');
});

test('the free routes are free, and are not the paid one in disguise', async ({ request }) => {
    const decoded = await request.post('/v1/mandate/decode', { data: { program: LIVE_PROGRAM } });
    expect(decoded.status(), 'a free route must never answer 402').toBe(200);
    expect(decoded.headers()['payment-required']).toBeUndefined();

    const answer = await decoded.json();
    expect(answer.guarded).toBe(true);
    expect(answer.mandate.minRateE18).toBeTruthy();
    // What the payment buys must not leak out of the free door. These two fields are the paid
    // answer, and a free route that carried them would leave nothing to sell.
    expect(answer.publication, 'publication belongs to the paid answer').toBeUndefined();
    expect(answer.operator, 'the operator identity belongs to the paid answer').toBeUndefined();
});

test('a free route refuses a bad program as a request error, not a server one', async ({ request }) => {
    const res = await request.post('/v1/mandate/decode', { data: { program: 'not-hex' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/0x hex/);
});

test('the description lists what is free and what is paid', async ({ request }) => {
    const body = await (await request.get('/')).json();
    expect(Object.keys(body.free)).toEqual([
        'POST /v1/mandate/decode',
        'POST /v1/mandate/publication',
        'GET /v1/agent/authority',
        'GET /v1/agent/reputation',
        'GET /v1/position/health',
    ]);
    expect(body.endpoint).toBe('POST /v1/mandate/explain');
    expect(body.attribution).toMatch(/SwapVM/);
});

// --- described, so a machine can find it ------------------------------------
//
// Three documents in formats other people's software already reads, all generated from the one
// route table in openapi.mjs. What is pinned is that they name every route the service actually
// has, and that the free/paid split survives the translation.

test('the OpenAPI document names every route, and says which one costs money', async ({ request }) => {
    const res = await request.get('/openapi.json');
    expect(res.status()).toBe(200);
    expect(res.headers()['payment-required']).toBeUndefined();

    const doc = await res.json();
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.servers[0].url).toMatch(/^https:\/\//);
    for (const path of ['/v1/mandate/decode', '/v1/mandate/publication', '/v1/agent/authority', '/v1/agent/reputation',
        '/v1/mandate/explain', '/.well-known/x402', '/.well-known/agent-card.json', '/openapi.json', '/mcp', '/']) {
        expect(doc.paths[path], `${path} is missing from the document`).toBeTruthy();
    }
    const paid = doc.paths['/v1/mandate/explain'].post;
    expect(paid['x-cost']).toContain('0.001 HBAR');
    expect(paid.responses['402'], 'the 402 is the interface; it has to be documented').toBeTruthy();
    expect(paid.responses['402'].headers['PAYMENT-REQUIRED']).toBeTruthy();
    expect(doc.paths['/v1/mandate/decode'].post['x-cost']).toBe('free');
    // Every $ref resolves: a schema that points at nothing validates nothing.
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/(\w+)/g) ?? [];
    for (const ref of refs) expect(doc.components.schemas[ref.split('/').pop()], `${ref} is dangling`).toBeTruthy();
    // And the description links to it.
    expect((await (await request.get('/')).json()).openapi).toMatch(/\/openapi\.json$/);
});

test('the Agent Card carries the four questions as skills and points at the x402 manifest', async ({ request }) => {
    const res = await request.get('/.well-known/agent-card.json');
    expect(res.status()).toBe(200);
    const card = await res.json();
    expect(typeof card.name).toBe('string');
    expect(typeof card.description).toBe('string');
    expect(card.url).toMatch(/^https:\/\//);
    expect(card.version).toBeTruthy();
    expect(card.capabilities).toBeTruthy();
    expect(Array.isArray(card.supportedInterfaces)).toBe(true);
    expect(card.skills.map((s) => s.id)).toEqual([
        'read_mandate', 'check_publication', 'check_agent_authority', 'check_reputation', 'inspect_mandate_paid',
    ]);
    for (const s of card.skills) {
        expect(typeof s.name).toBe('string');
        expect(typeof s.description).toBe('string');
        expect(s.tags.length).toBeGreaterThan(0);
    }
    // The paid skill says so where the reader will look, not only in a tag.
    expect(card.skills.find((s) => s.id === 'inspect_mandate_paid').description).toContain('HBAR');
    const x402 = card.extensions.find((e) => e.uri.includes('x402'));
    expect(x402.params.manifest).toMatch(/\/\.well-known\/x402$/);
    const erc8004 = card.extensions.find((e) => e.uri.includes('8004'));
    expect(erc8004.params.agentId).toMatch(/^\d+$/);
    expect(erc8004.params.identityRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
});

test('the MCP server answers over HTTP with the same four tools', async ({ request }) => {
    const headers = { Accept: 'application/json, text/event-stream' };
    const init = await request.post('/mcp', {
        headers,
        data: {
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa', version: '0' } },
        },
    });
    expect(init.status()).toBe(200);
    expect(init.headers()['payment-required']).toBeUndefined();
    const hello = await init.json();
    expect(hello.result.serverInfo.name).toBe('batas');
    // Stateless: no session to carry, so nothing to hand back.
    expect(init.headers()['mcp-session-id']).toBeUndefined();

    const list = await request.post('/mcp', { headers, data: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    expect(list.status()).toBe(200);
    const names = (await list.json()).result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['check_agent_authority', 'check_publication', 'inspect_mandate_paid', 'read_mandate']);
});

test('the free routes have a brake, and it says how to wait', async ({ request }) => {
    // Counted up to a bound rather than to a number, on purpose. `reuseExistingServer` means this
    // may be talking to a server somebody started by hand with the production limit rather than the
    // low one `playwright.config.mjs` sets, and a test that hard-codes the low number fails
    // mysteriously in that case. What is being pinned is that a limit exists, answers JSON like
    // everything else, and says when to come back — not where it sits.
    const CEILING = 80;
    let first = null;
    let sent = 0;
    while (sent < CEILING && !first) {
        const res = await request.post('/v1/mandate/decode', { data: { program: LIVE_PROGRAM } });
        sent += 1;
        if (res.status() === 429) first = res;
    }
    expect(first, `no request was refused in ${sent} attempts; is the brake wired up?`).not.toBeNull();
    expect(first.headers()['content-type']).toContain('application/json');
    expect(first.headers()['retry-after']).toBeTruthy();
    const body = await first.json();
    expect(body.error).toMatch(/too many free requests/);
    // And the shape of the offer: the paid route is not what is being limited.
    expect(body.note).toMatch(/paid route is not rate limited/);
});

test('concurrent callers all get the same payment requirement', async ({ request }) => {
    // The facilitator handshake runs on the request path, so a burst is where a shared client would
    // show up as inconsistent terms — one caller quoted a different price than another.
    const results = await Promise.all(
        Array.from({ length: 8 }, () => request.post('/v1/mandate/explain', { data: { program: LIVE_PROGRAM } })),
    );
    const requirements = results.map((r) => {
        expect(r.status()).toBe(402);
        return decodeRequirement(r.headers()['payment-required']).accepts[0];
    });
    for (const accepts of requirements) expect(accepts).toEqual(requirements[0]);
});
