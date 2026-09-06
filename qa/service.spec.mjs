import { test, expect } from '@playwright/test';

// The paid surface, exercised the way a caller meets it: an unpaid request, the 402 that comes
// back, and what that 402 actually promises. Getting the payment requirement wrong is the failure
// that matters here — a caller would settle against the wrong network, asset or facilitator and
// still see a plausible response.

const LIVE_PROGRAM =
    '0x2120000000000000000579a814e10a74000000000000000000001aaa51121b231412700300753050000208000000006a9d5ef4';

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
