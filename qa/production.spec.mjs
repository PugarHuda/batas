import { test, expect } from '@playwright/test';

// The deployed endpoint, tested as a stranger meets it.
//
// This is the URL the ERC-8004 registration advertises on chain, so it is the one that matters
// most and the one that was hardest to keep honest: a local suite passing says nothing about
// whether the thing people were pointed at still answers.

const PROD = 'https://batas-one.vercel.app';

const LIVE_PROGRAM =
    '0x2120000000000000000579a814e10a74000000000000000000001aaa51121b231412700300753050000208000000006a9d5ef4';

/**
 * Serverless answers its first request cold and the facilitator handshake the paywall needs runs
 * on that path, so a cold caller can see a 5xx where a warm one sees the 402. Retrying is the
 * behaviour a real client has to have, and asserting it here keeps the suite honest about it
 * rather than hiding a flake.
 */
async function postWithWarmup(request, path, data) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await request.post(`${PROD}${path}`, { data, timeout: 60_000 });
        if (res.status() < 500) return res;
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('service stayed cold across three attempts');
}

test('the deployment is reachable and describes itself', async ({ request }) => {
    const res = await request.get(`${PROD}/`, { timeout: 60_000 });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.service).toBe('Batas mandate inspection');
    expect(body.network).toBe('hedera:testnet');
    expect(body.facilitator).toContain('blocky402.com');
});

test('the advertised paid route demands payment', async ({ request }) => {
    const res = await postWithWarmup(request, '/v1/mandate/explain', { program: LIVE_PROGRAM });
    expect(res.status()).toBe(402);

    const requirement = JSON.parse(
        Buffer.from(res.headers()['payment-required'], 'base64').toString('utf8'),
    );
    const [accepts] = requirement.accepts;
    expect(accepts.network).toBe('hedera:testnet');
    expect(accepts.asset).toBe('0.0.0');
    expect(accepts.amount).toBe('100000');
    // Blocky402's testnet fee payer. The Hedera track requires that facilitator specifically, and
    // production is where getting it wrong would actually cost someone.
    expect(accepts.extra.feePayer).toBe('0.0.7162784');
});

test('production and the local build agree on what is being sold', async ({ request }) => {
    // Vercel serves the same Express app this repository runs, so a drift here means the deploy
    // is stale rather than that the two were written differently.
    const res = await request.get(`${PROD}/`, { timeout: 60_000 });
    const body = await res.json();
    expect(body.endpoint).toBe('POST /v1/mandate/explain');
    expect(body.price).toBe('0.001 HBAR');
    expect(body.payTo).toMatch(/^0\.0\.\d+$/);
});

test('an unknown path on the deployment is a plain 404', async ({ request }) => {
    const res = await request.post(`${PROD}/v1/nothing/here`, { data: {}, timeout: 60_000 });
    expect(res.status()).toBe(404);
    expect(res.headers()['payment-required']).toBeUndefined();
});
