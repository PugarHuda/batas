// ERC-8004 endpoint-domain verification, both sides, against real chain state.
//
// The served file comes from the real service reading the real registry on Sepolia, and the
// verifier resolves real agents. The only redirection is the origin mapping, which sends the
// fetch for one domain to this machine instead of the deployment. That is what lets the test prove
// the served file verifies before it has been deployed.

import test from 'node:test';
import assert from 'node:assert/strict';

import app from './service.mjs';
import { verifyEndpointDomains } from './domain-verify.mjs';
import { IDENTITY_REGISTRY } from './erc8004.mjs';

const PORT = 4290;
const LOCAL = `http://localhost:${PORT}`;
const REASONS = new Set(['match', 'serves-agentURI', 'unreachable', 'no-registrations', 'mismatch']);

let server;
test.before(() => new Promise((resolve) => { server = app.listen(PORT, resolve); }));
test.after(() => { server.closeAllConnections(); server.close(); });

test('the service publishes the on-chain registration at the well-known path', async () => {
    const res = await fetch(`${LOCAL}/.well-known/agent-registration.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('cache-control'), /max-age=300/);
    const doc = await res.json();
    assert.deepEqual(doc.registrations, [{ agentId: 10123, agentRegistry: `eip155:11155111:${IDENTITY_REGISTRY}` }]);
});

test('a domain serving the file is verified for agent #10123', async () => {
    const r = await verifyEndpointDomains(10123, {
        originFor: (d) => (d === 'batas-one.vercel.app' ? LOCAL : `https://${d}`),
    });
    const batas = r.domains.find((d) => d.domain === 'batas-one.vercel.app');
    assert.equal(batas.verified, true, batas.detail);
    assert.equal(batas.reason, 'match');
    // GitHub is listed as the source but cannot prove anything about this agent, and must say so.
    assert.equal(r.domains.find((d) => d.domain === 'github.com').verified, false);
});

test('the same file does not verify a different on-chain agent', async () => {
    // Agent #10120 is real, lists https://github.com/... as its only endpoint, and is not the agent
    // the served file names. Sending its domain to the local service must come back as a mismatch,
    // not as verified because some registrations list was present.
    const r = await verifyEndpointDomains(10120, { originFor: () => LOCAL });
    assert.equal(r.registered, true);
    assert.equal(r.domains.length, 1);
    const [gh] = r.domains;
    assert.equal(gh.domain, 'github.com');
    assert.equal(gh.verified, false);
    assert.equal(gh.reason, 'mismatch');
    assert.match(gh.detail, /#10123/);
});

test('live: agent #10123 domains read from chain and fetched over HTTPS', async () => {
    const r = await verifyEndpointDomains(10123);
    assert.equal(r.registered, true);
    assert.equal(r.uriKind, 'inline');
    assert.deepEqual(r.domains.map((d) => d.domain).sort(), ['batas-one.vercel.app', 'github.com', 'testnet.mirrornode.hedera.com']);
    for (const d of r.domains) {
        assert.ok(REASONS.has(d.reason), `${d.domain}: ${d.reason}`);
        // A data: URI serves from no domain, so the only way to be verified is a matching file.
        assert.equal(d.verified, d.reason === 'match', `${d.domain}: ${d.detail}`);
    }
    // Neither of these hosts is ours; neither may ever come out verified.
    assert.equal(r.domains.find((d) => d.domain === 'github.com').verified, false);
    assert.equal(r.domains.find((d) => d.domain === 'testnet.mirrornode.hedera.com').verified, false);
});

test('a non-integer id is refused as bad input, not reported as unverified', async () => {
    await assert.rejects(verifyEndpointDomains('abc'), /non-negative integer/);
});
