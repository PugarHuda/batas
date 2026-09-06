// Tests for reading agent identities.
//
// The registry is the only place the system learns *who* stands behind a position, so the two ways
// it can quietly go wrong both matter: a registration file that is decoded loosely enough to accept
// something it should not, and a vouching check that says yes when the identity belongs to someone
// else. The second is the dangerous one — it turns an identity into a claim of authority.
//
// The live cases read agent #10123 from the real registry on Sepolia. Nothing here is stubbed: a
// vouching check tested against a fake registry proves only that the fake agrees with itself.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentURI, vouchesFor, resolveAgent, IDENTITY_REGISTRY } from './erc8004.mjs';

const AGENT_ID = 10123n;
const OWNER = '0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E';

test('an inline registration is decoded', () => {
    const doc = { type: 'https://eips.ethereum.org/EIPS/eip-8004', name: 'Batas' };
    const uri = 'data:application/json,' + encodeURIComponent(JSON.stringify(doc));
    const parsed = parseAgentURI(uri);
    assert.equal(parsed.kind, 'inline');
    assert.deepEqual(parsed.registration, doc);
});

test('a base64 inline registration is decoded too', () => {
    const doc = { name: 'Batas' };
    const uri = 'data:application/json;base64,' + Buffer.from(JSON.stringify(doc)).toString('base64');
    const parsed = parseAgentURI(uri);
    assert.equal(parsed.kind, 'inline');
    assert.deepEqual(parsed.registration, doc);
});

test('a hosted registration is reported, never fetched', () => {
    const parsed = parseAgentURI('https://example.invalid/agent.json');
    assert.equal(parsed.kind, 'hosted');
    assert.equal(parsed.uri, 'https://example.invalid/agent.json');
    // The deliberate omission: no `registration` key. This runs inside a paid request, so an
    // operator who controls the URI must not get to decide how long that request takes.
    assert.equal(parsed.registration, undefined);
});

test('a broken registration is refused rather than half-read', () => {
    assert.equal(parseAgentURI('data:application/json,{not json').kind, 'malformed');
    assert.equal(parseAgentURI('data:application/json').kind, 'malformed', 'no comma, no payload');
    assert.equal(parseAgentURI('').kind, 'missing');
    assert.equal(parseAgentURI(undefined).kind, 'missing');
});

test('vouching requires the identity to be held by the granting address', () => {
    const agent = { registered: true, agentId: '1', owner: OWNER };
    assert.equal(vouchesFor(agent, OWNER).vouched, true);
    assert.equal(vouchesFor(agent, OWNER.toLowerCase()).vouched, true, 'checksum casing must not matter');
});

test('an identity held by someone else does not vouch, and says whose it is', () => {
    const agent = { registered: true, agentId: '1', owner: OWNER };
    const stranger = '0x0000000000000000000000000000000000000001';
    const check = vouchesFor(agent, stranger);
    assert.equal(check.vouched, false);
    assert.match(check.reason, /did not grant this mandate/);
    assert.match(check.reason, new RegExp(OWNER), 'the caller should learn who actually holds it');
});

test('an unregistered identity vouches for nobody', () => {
    assert.equal(vouchesFor({ registered: false }, OWNER).vouched, false);
    assert.equal(vouchesFor(null, OWNER).vouched, false);
    assert.equal(vouchesFor({ registered: true, owner: OWNER }, undefined).vouched, false);
});

test('the registry address is the testnet deployment, not the mainnet one', () => {
    // The addresses that turn up first in a search are mainnet-only and read as empty on Sepolia,
    // which looks exactly like an unregistered agent. Pinning it stops that from recurring.
    assert.equal(IDENTITY_REGISTRY, '0x8004A818BFB912233c491871b3d84c89A494BD9e');
});

test('the live registration resolves off Sepolia', async () => {
    const agent = await resolveAgent(AGENT_ID);
    assert.equal(agent.registered, true);
    assert.equal(agent.agentId, '10123');
    assert.equal(agent.owner, OWNER);
    assert.equal(agent.uriKind, 'inline', 'the registration is stored on chain, not behind a URL');
    assert.equal(agent.registration.name, 'Batas');

    const services = agent.registration.services.map((s) => s.name);
    assert.ok(services.includes('x402'), 'the paid endpoint is advertised in the registration');
});

test('the live identity vouches for its own operator and for nobody else', async () => {
    const agent = await resolveAgent(AGENT_ID);
    assert.equal(vouchesFor(agent, agent.registration.operator).vouched, true);
    assert.equal(vouchesFor(agent, '0x0000000000000000000000000000000000000001').vouched, false);
});

test('an id that was never minted comes back unregistered, not empty', async () => {
    const agent = await resolveAgent(2n ** 200n);
    assert.equal(agent.registered, false);
    assert.equal(agent.owner, undefined, 'a zero address here would read as a revoked identity');
});
