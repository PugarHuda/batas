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

import { parseAgentURI, vouchesFor, resolveAgent, parseAgentId, checkRegistration, IDENTITY_REGISTRY, REGISTRATION_TYPE } from './erc8004.mjs';

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

    const services = Object.fromEntries(agent.registration.services.map((s) => [s.name, s.endpoint]));
    assert.ok(services.x402, 'the paid endpoint is advertised in the registration');
    // The identity has to lead somewhere a reader can check without trusting us. The mirror node
    // is public and unauthenticated, so this entry is what makes the registration self-sufficient
    // rather than a pointer back to our own service.
    assert.match(services.mandates, /mirrornode\.hedera\.com\/api\/v1\/topics\/0\.0\.\d+\/messages$/);
});

const wellFormed = (over = {}) => ({
    type: REGISTRATION_TYPE,
    name: 'Batas',
    active: true,
    services: [{ name: 'web', endpoint: 'https://batas-one.vercel.app' }],
    registrations: [{ agentId: 10123, agentRegistry: `eip155:11155111:${IDENTITY_REGISTRY}` }],
    ...over,
});

test('a registration that names its own token is bound to it', () => {
    assert.deepEqual(checkRegistration(wellFormed(), 10123n), { valid: true, bound: true, issues: [] });
    const lower = wellFormed({ registrations: [{ agentId: '10123', agentRegistry: `eip155:11155111:${IDENTITY_REGISTRY.toLowerCase()}` }] });
    assert.equal(checkRegistration(lower, 10123n).bound, true, 'a string id and a lowercase address are the same claim');
});

test('a registration copied from another agent is not bound to this one', () => {
    // Decoding proved only that the file was JSON. Pointed at a different token, a perfect
    // description of somebody else reads as this agent's identity unless the binding is checked.
    assert.equal(checkRegistration(wellFormed(), 10124n).bound, false);
    const mainnet = wellFormed({ registrations: [{ agentId: 10123, agentRegistry: `eip155:1:${IDENTITY_REGISTRY}` }] });
    assert.equal(checkRegistration(mainnet, 10123n).bound, false, 'the same id in another chain is another identity');
    const none = checkRegistration(wellFormed({ registrations: undefined }), 10123n);
    assert.equal(none.valid, false);
    assert.match(none.issues.join('\n'), /does not name agent #10123/);
    assert.equal(checkRegistration(wellFormed({ registrations: [{ agentId: [], agentRegistry: `eip155:11155111:${IDENTITY_REGISTRY}` }] }), 0n).bound,
        false, 'an empty array is not agent #0');
});

test('a registration that is not the spec shape says what is wrong with it', () => {
    const issues = checkRegistration(wellFormed({
        type: 'agent', name: '', active: 'yes', supportedTrust: 'reputation',
        services: [{ name: 'x402' }, { endpoint: 'vitalik.eth' }],
    }), 10123n).issues.join('\n');
    assert.match(issues, /type is "agent"/);
    assert.match(issues, /no name/);
    assert.match(issues, /active is not a boolean/);
    assert.match(issues, /supportedTrust is not a list/);
    assert.match(issues, /service x402 has no endpoint/);
    assert.match(issues, /service 1 has no name/);
    assert.doesNotMatch(issues, /vitalik/, 'an ENS name is a legitimate endpoint, not a malformed URL');
    for (const bad of [null, [], 'Batas', 42]) assert.equal(checkRegistration(bad, 10123n).valid, false);
});

test('the live registration is the spec shape and bound to its own token', async () => {
    const agent = await resolveAgent(AGENT_ID);
    assert.deepEqual(agent.registrationCheck, { valid: true, bound: true, issues: [] });
});

test('the live agent wallet is read, and is the address that proved control of it', async () => {
    // Set to the owner at mint and cleared on transfer, so on an identity that never changed hands
    // it has to be the owner. Anything else would mean the read is looking at the wrong slot.
    const agent = await resolveAgent(AGENT_ID);
    assert.equal(agent.agentWallet, OWNER);
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


test('an agent id is parsed strictly, because BigInt is not', () => {
    // BigInt([]) is 0n. An empty array therefore asked the registry about agent #0 and got a real
    // answer back, which the caller would read as an identity that exists.
    assert.equal(parseAgentId([]), null);
    assert.equal(parseAgentId({}), null);
    assert.equal(parseAgentId(null), null);
    assert.equal(parseAgentId(undefined), null);
    assert.equal(parseAgentId('abc'), null);
    assert.equal(parseAgentId('1e999'), null, 'exponent notation is not an id');
    assert.equal(parseAgentId('0x10'), null, 'nor is hex');
    assert.equal(parseAgentId(-1), null);
    assert.equal(parseAgentId(1.5), null);
    assert.equal(parseAgentId(Number.MAX_SAFE_INTEGER + 2), null, 'past safe integers a number is a guess');

    assert.equal(parseAgentId('10123'), 10123n);
    assert.equal(parseAgentId(' 10123 '), 10123n, 'whitespace from a form field is not a malformed id');
    assert.equal(parseAgentId(10123), 10123n);
    assert.equal(parseAgentId(10123n), 10123n);
    assert.equal(parseAgentId(0), 0n, 'zero is a real id, and must not be confused with a rejection');
});

test('resolveAgent refuses an id it cannot trust rather than coercing one', async () => {
    await assert.rejects(() => resolveAgent([]), /non-negative integer/);
    await assert.rejects(() => resolveAgent('abc'), /non-negative integer/);
});

test('a maker that is not an address does not throw out of the vouching check', () => {
    // It used to, and the service caught that as "registered: false" — a statement about a third
    // party produced by our own bad argument handling.
    const agent = { registered: true, agentId: '1', owner: OWNER };
    for (const bad of [{}, [], 42, null, undefined, '0x', 'not-an-address']) {
        const check = vouchesFor(agent, bad);
        assert.equal(check.vouched, false);
        assert.match(check.reason, /no maker address/);
    }
});
