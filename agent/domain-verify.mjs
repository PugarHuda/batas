// The verifying side of ERC-8004 endpoint-domain verification.
//
//   node agent/domain-verify.mjs 10123
//
// A registration can list any URL as a service endpoint; listing a domain is not the same as
// controlling it. EIP-8004 gives the check: the domain proves control by serving
// /.well-known/agent-registration.json with a `registrations` entry whose agentRegistry and agentId
// match the on-chain agent. A domain that serves the agentURI itself needs no second proof, because
// the registry already points at it.

import { resolveAgent, checkRegistration, parseAgentId } from './erc8004.mjs';

const WELL_KNOWN = '/.well-known/agent-registration.json';

// Read a URL as JSON or say why not, without ever throwing: every failure here is an answer about
// the domain, not a crash of the verifier.
async function fetchJson(url, { fetchImpl, timeoutMs }) {
    let res;
    try {
        // Redirects are not followed. The spec asks for the file on the endpoint domain itself, and
        // a redirect elsewhere would let a different host answer for it.
        res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch (e) {
        return { reason: 'unreachable', detail: String(e?.cause?.code ?? e?.message ?? e) };
    }
    if (res.status >= 300 && res.status < 400) {
        return { reason: 'unreachable', detail: `HTTP ${res.status} redirect to ${res.headers.get('location')}; the file must be served by the domain itself` };
    }
    if (!res.ok) return { reason: 'unreachable', detail: `HTTP ${res.status}` };
    try {
        return { json: await res.json() };
    } catch {
        return { reason: 'no-registrations', detail: 'the response is not JSON' };
    }
}

// Every distinct hostname among the registration's HTTPS service endpoints. `endpoints` is the
// field's name in earlier drafts of the spec, and registrations written against those still exist.
function httpsDomains(registration) {
    const services = registration?.services ?? registration?.endpoints;
    const domains = new Set();
    for (const s of Array.isArray(services) ? services : []) {
        try {
            const u = new URL(s?.endpoint);
            if (u.protocol === 'https:') domains.add(u.hostname.toLowerCase());
        } catch { /* ENS names, DIDs and CAIP-10 accounts are valid endpoints but not domains. */ }
    }
    return [...domains];
}

/**
 * Resolve an agent on chain and check every HTTPS endpoint domain its registration names.
 *
 * `originFor` maps a domain to the origin actually fetched. It defaults to https://{domain}; tests
 * point it at a local service, which is the only reason it is injectable.
 */
export async function verifyEndpointDomains(agentId, { originFor = (d) => `https://${d}`, fetchImpl = fetch, timeoutMs = 10_000, client, rpcUrl } = {}) {
    const id = parseAgentId(agentId);
    if (id === null) throw new Error('agentId must be a non-negative integer');
    const agent = await resolveAgent(id, { client, rpcUrl });
    const base = { agentId: id.toString(), registry: agent.registry, registered: agent.registered };
    if (!agent.registered) return { ...base, domains: [] };

    let registration = agent.registration;
    let agentURIDomain = null;
    if (agent.uriKind === 'hosted') {
        const u = URL.canParse(agent.registrationURI) ? new URL(agent.registrationURI) : null;
        if (u?.protocol !== 'https:') {
            return { ...base, registrationError: `agentURI ${agent.registrationURI} is not an HTTPS URL this verifier can read`, domains: [] };
        }
        agentURIDomain = u.hostname.toLowerCase();
        const got = await fetchJson(u.href, { fetchImpl, timeoutMs });
        if (!got.json) return { ...base, agentURI: u.href, registrationError: `${got.reason}: ${got.detail}`, domains: [] };
        registration = got.json;
    }
    if (!registration) return { ...base, registrationError: `agentURI is ${agent.uriKind}`, domains: [] };

    const domains = await Promise.all(httpsDomains(registration).map(async (domain) => {
        if (domain === agentURIDomain) {
            return { domain, verified: true, reason: 'serves-agentURI', detail: 'this domain serves the agentURI, so the registry already points at it' };
        }
        const url = `${originFor(domain)}${WELL_KNOWN}`;
        const got = await fetchJson(url, { fetchImpl, timeoutMs });
        if (!got.json) return { domain, url, verified: false, reason: got.reason, detail: got.detail };
        const regs = got.json?.registrations;
        if (!Array.isArray(regs) || regs.length === 0) {
            return { domain, url, verified: false, reason: 'no-registrations', detail: 'the file has no registrations list' };
        }
        // The same match the registry reader applies to the agent's own file: agent id and CAIP-10
        // registry both, since an id alone could belong to any registry on any chain.
        if (checkRegistration(got.json, id).bound) {
            return { domain, url, verified: true, reason: 'match', detail: `registrations names agent #${id} in this registry` };
        }
        const named = regs.map((r) => `#${r?.agentId} in ${r?.agentRegistry}`).join(', ');
        return { domain, url, verified: false, reason: 'mismatch', detail: `registrations names ${named}, not agent #${id}` };
    }));
    return { ...base, uriKind: agent.uriKind, ...(agentURIDomain ? { agentURIDomain } : {}), domains };
}

if (import.meta.filename === process.argv[1]) {
    const arg = process.argv[2] ?? (await import('./deployment.mjs')).AGENT_ID;
    try {
        const r = await verifyEndpointDomains(arg);
        console.log(`agent #${r.agentId} in ${r.registry}`);
        if (!r.registered) console.log('  not registered');
        if (r.registrationError) console.log(`  registration unreadable: ${r.registrationError}`);
        else if (r.registered && r.domains.length === 0) console.log('  the registration lists no HTTPS service endpoints');
        for (const d of r.domains) {
            console.log(`  ${d.verified ? 'verified    ' : 'not verified'}  ${d.domain.padEnd(32)} ${d.reason}: ${d.detail}`);
        }
        process.exit(r.registered && !r.registrationError ? 0 : 1);
    } catch (e) {
        console.error(String(e?.shortMessage ?? e?.message ?? e));
        process.exit(1);
    }
}
