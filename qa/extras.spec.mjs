import { test, expect } from '@playwright/test';

import { priceFor } from '../agent/service.mjs';
import { verifyEndpointDomains } from '../agent/domain-verify.mjs';
import { HTS_TOKEN, AGENT_ID } from '../agent/deployment.mjs';
import { HTS_PRICE } from '../agent/hts.mjs';
import { IDENTITY_REGISTRY } from '../agent/erc8004.mjs';

// The surfaces added last: the metered 402, the HTS option, the well-known documents and the name
// route. These check the contract each one states, against the local service and the live chains
// it reads, with nothing stood in for either.

const LIVE_PROGRAM =
    '0x212100000000000000006367be30fcbd45ea00000000000000001aeff914e72b45e8802005006acd0476222e945800Bd6CDd60521B64a12D7b3F12fC90916a6B39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E056167656e74700300753050000208000000006aa5dc37';
// 0x5000 is one instruction, so a stream of n of them has a known count.
const stream = (n) => `0x${'5000'.repeat(n)}`;

// The suite shares one server whose free brake is twelve a minute. Each test names itself as its own
// caller, which the brake allows on purpose, so no test is refused for another test's requests.
const caller = (_name) => ({ 'X-Forwarded-For': `10.37.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
const requirementOf = (res) => JSON.parse(Buffer.from(res.headers()['payment-required'], 'base64').toString('utf8'));

test('the 402 for a body states exactly what priceFor bills, and never more than the manifest ceiling', async ({ request }) => {
    const manifest = await (await request.get('/.well-known/x402')).json();
    const [resource] = manifest.resources;
    const ceiling = BigInt(resource.accepts[0].amount);
    expect(ceiling).toBe(BigInt(resource.metered.max));

    const bodies = [
        {},
        { program: '' },
        { program: '0x' },
        { program: 'not hex' },
        { program: '0x5' },
        { program: LIVE_PROGRAM },
        { program: stream(255) },
        { program: stream(256) },
        { program: stream(257) },
        { program: stream(4000), agentId: '10123' },
        { program: stream(4000), agentId: 10123, maker: '0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E' },
        { program: LIVE_PROGRAM, agentId: 0 },
        { program: LIVE_PROGRAM, agentId: -1 },
        { program: LIVE_PROGRAM, agentId: 'abc' },
        { program: LIVE_PROGRAM, agentId: [1] },
        { program: LIVE_PROGRAM, agentId: 2 ** 53 },
        { program: LIVE_PROGRAM, agentId: '1', maker: '0xnot-an-address' },
        { program: LIVE_PROGRAM, agentId: '1', maker: null },
    ];
    for (const body of bodies) {
        const res = await request.post('/v1/mandate/explain', { data: body });
        expect(res.status(), JSON.stringify(body).slice(0, 80)).toBe(402);
        const [hbar, hts] = requirementOf(res).accepts;
        expect(hbar.amount, JSON.stringify(body).slice(0, 80)).toBe(priceFor(body).total);
        expect(BigInt(hbar.amount)).toBeLessThanOrEqual(ceiling);
        // The credit is one fixed price per answer, and the 402 and the manifest must agree on it.
        expect(hts).toMatchObject({ scheme: 'exact', network: 'hedera:testnet', asset: HTS_TOKEN, amount: HTS_PRICE, payTo: hbar.payTo });
    }
});

test('the instruction bill stops at the cap: 256, 257 and 4000 instructions cost the same', async () => {
    const at = (n) => Number(priceFor({ program: stream(n) }).total);
    expect(at(256) - at(255)).toBe(1_000);
    expect(at(257)).toBe(at(256));
    expect(at(4000)).toBe(at(256));
});

test('a requirement issued for a light body does not satisfy a heavy one', async ({ request }) => {
    const light = requirementOf(await request.post('/v1/mandate/explain', { data: { program: LIVE_PROGRAM } })).accepts[0];
    const heavyBody = { program: LIVE_PROGRAM, agentId: '10123' };
    const heavy = requirementOf(await request.post('/v1/mandate/explain', { data: heavyBody })).accepts[0];
    expect(BigInt(heavy.amount)).toBeGreaterThan(BigInt(light.amount));

    // An unsigned transaction is enough to see which gate refuses it: a light requirement is refused by
    // the matcher before the facilitator is asked, the heavy one reaches the facilitator and is
    // refused there for its transaction. Neither is served.
    const signature = (accepted) => Buffer.from(JSON.stringify({
        x402Version: 2, accepted, payload: { transaction: Buffer.from('unsigned').toString('base64') },
    })).toString('base64');
    const lightOnHeavy = await request.post('/v1/mandate/explain', { data: heavyBody, headers: { 'PAYMENT-SIGNATURE': signature(light) } });
    expect(lightOnHeavy.status()).toBe(402);
    expect(requirementOf(lightOnHeavy).error).toBe('No matching payment requirements');

    const heavyOnHeavy = await request.post('/v1/mandate/explain', { data: heavyBody, headers: { 'PAYMENT-SIGNATURE': signature(heavy) } });
    expect(heavyOnHeavy.status()).toBe(402);
    expect(requirementOf(heavyOnHeavy).error).not.toBe('No matching payment requirements');
});

test('the discovery manifest offers HBAR at the metered ceiling and the HTS credit after it', async ({ request }) => {
    const res = await request.get('/.well-known/x402');
    expect(res.status()).toBe(200);
    const [resource] = (await res.json()).resources;
    expect(resource.accepts).toEqual([
        { scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: resource.metered.max, payTo: expect.stringMatching(/^0\.0\.\d+$/) },
        { scheme: 'exact', network: 'hedera:testnet', asset: HTS_TOKEN, amount: HTS_PRICE, payTo: resource.accepts[0].payTo },
    ]);
});

test('the agent registration file is the on-chain one, readable from any origin, and proves the domain', async ({ request, baseURL }) => {
    const res = await request.get('/.well-known/agent-registration.json', { headers: { Origin: 'https://verifier.example' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['access-control-allow-origin']).toBe('*');
    expect(res.headers()['content-type']).toMatch(/application\/json/);
    const doc = await res.json();
    expect(doc.type).toBe('https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
    expect(doc.registrations).toContainEqual(expect.objectContaining({
        agentId: Number(AGENT_ID), agentRegistry: `eip155:11155111:${IDENTITY_REGISTRY}`,
    }));

    // The verifier reads the registration from chain and the file from this server: the whole proof,
    // with only the origin redirected to the service under test.
    const verdict = await verifyEndpointDomains(AGENT_ID, { originFor: () => baseURL });
    expect(verdict.registered).toBe(true);
    expect(verdict.domains.length).toBeGreaterThan(0);
    for (const d of verdict.domains) expect(d, d.domain).toMatchObject({ verified: true, reason: 'match' });
});

test('the agent card is readable from any origin and names the A2A interface and the x402 extension', async ({ request }) => {
    const res = await request.get('/.well-known/agent-card.json', { headers: { Origin: 'https://inspector.example' } });
    expect(res.status()).toBe(200);
    // A2A clients that run in a browser fetch the card cross-origin, exactly as ERC-8004 verifiers
    // fetch the registration file, which already allowed it.
    expect(res.headers()['access-control-allow-origin']).toBe('*');
    const card = await res.json();
    expect(card.url).toMatch(/\/a2a$/);
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.capabilities.extensions).toContainEqual(expect.objectContaining({ uri: 'https://github.com/google-a2a/a2a-x402/v0.1', required: true }));
    expect(card.skills.map((s) => s.id)).toEqual(expect.arrayContaining(['negotiate-fill', 'inspect-mandate']));
    // The price the card states is the one the A2A offer will request.
    const { extensions: [ext] } = card.capabilities;
    expect(ext.description).toMatch(/0\.001 HBAR on hedera:testnet/);
});

test('the name route answers the agent, the alias and a wildcard label under batas.eth', async ({ request }) => {
    test.setTimeout(120_000);
    const headers = caller('name-happy');
    const agent = await (await request.get('/v1/agent/name', { headers })).json();
    expect(agent.name).toBe('agent.batas.eth');
    expect(agent.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // Uppercase is the same name once normalised, and the answer names it normalised.
    const upper = await request.get('/v1/agent/name?name=AGENT.Batas.ETH', { headers });
    expect(upper.status()).toBe(200);
    expect((await upper.json()).name).toBe('agent.batas.eth');

    const alias = await request.get('/v1/agent/name?name=mandate.batas.eth', { headers });
    expect(alias.status()).toBe(200);
    expect((await alias.json()).address).toBe(agent.address);

    const wildcard = await request.get(`/v1/agent/name?name=never-registered-${Date.now()}.batas.eth`, { headers });
    expect(wildcard.status()).toBe(200);
    const w = await wildcard.json();
    expect(w.resolver).toBe(agent.resolver);
    expect(w.address).toBeNull();
});
