// The serving side of ERC-8004 endpoint-domain verification.
//
// The spec lets an agent prove it controls an HTTPS endpoint domain by publishing
// https://{domain}/.well-known/agent-registration.json with a `registrations` entry naming its
// on-chain id. Batas's agentURI is a data: URI, so nothing on chain proves batas-one.vercel.app is
// really its domain; this file is that proof.
//
// The document is read from the registry at request time rather than written out here. The
// registration builder in identity.mjs is not exported, and a second hand-written copy would
// drift silently the first time someone ran `identity.mjs --update`. Serving what the chain holds
// means the file can only ever say what the token says.

import { resolveAgent } from './erc8004.mjs';
import { AGENT_ID } from './deployment.mjs';

// ponytail: one cached entry per instance; a registration changes a few times a year and a minute
// of staleness after an update is harmless, while an RPC read on every crawl is not free.
const TTL_MS = 60_000;
let cached = null;

/**
 * The registration file agent #AGENT_ID holds on chain, exactly as the registry returns it.
 *
 * Throws rather than returning something partial: a file that fails to name the agent would
 * publish a claim of control that verifiers then reject, which is worse than answering "try later".
 */
export async function agentRegistration({ agentId = AGENT_ID, now = Date.now() } = {}) {
    if (cached && cached.agentId === String(agentId) && now - cached.at < TTL_MS) return cached.doc;
    const agent = await resolveAgent(agentId);
    if (!agent.registered) throw new Error(`agent #${agentId} is not registered`);
    if (agent.uriKind !== 'inline') throw new Error(`agent #${agentId} registration is ${agent.uriKind}, not an inline data: URI`);
    if (!agent.registrationCheck?.bound) throw new Error(`agent #${agentId} registration does not name itself in registrations`);
    cached = { agentId: String(agentId), at: now, doc: agent.registration };
    return agent.registration;
}

/** Express handler for GET /.well-known/agent-registration.json. */
export async function agentRegistrationRoute(_req, res) {
    // Verifiers are other people's software, often running in a browser, so the file is readable
    // from any origin; it holds nothing that is not already public on chain.
    res.set('Access-Control-Allow-Origin', '*');
    try {
        const doc = await agentRegistration();
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/json').json(doc);
    } catch (e) {
        // "We could not read the chain" is not "there is no registration", so it is a 503 that says
        // why, never an empty document.
        res.set('Cache-Control', 'no-store');
        res.status(503).json({ error: `registration unavailable: ${String(e?.shortMessage ?? e?.message ?? e)}` });
    }
}
