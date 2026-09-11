// The three questions that cost nothing, in one place.
//
// They were already free over MCP. This module exists because they are now also free over HTTP —
// the web page at `GET /` asks them — and answering the same question twice in two files is
// exactly the shape of drift this project has already been bitten by once, when two encoders for
// one format disagreed about whether a mandate carried a deadline.
//
// So MCP and HTTP both call these. Whatever the assistant is told, the browser is told, and a
// change to either is a change to both.
//
// What stays paid is unchanged and is not here: the whole answer assembled in one place, with the
// ERC-8004 identity and whether it vouches for the address that granted the mandate.

import { createPublicClient, http, getAddress } from 'viem';
import { sepolia } from 'viem/chains';

import { explain, decodeProgram, readMandate } from './swapvm.mjs';
import { lookupMandate } from './hcs.mjs';
import { mandateNameStatus } from './ens.mjs';
import { latestProgramOnChain, programFromStrategy } from './inspect.mjs';
import { readReputation } from './reputation.mjs';
import { OWNER, ENS_REGISTRY, MANDATE_NAME, HCS_TOPIC, AGENT_ID, SEPOLIA_RPC } from './deployment.mjs';

const HEX = /^0x[0-9a-fA-F]*$/;

/**
 * The live position, remembered briefly.
 *
 * Finding it means scanning up to 60,000 blocks of Aqua's `Shipped` logs, because the event indexes
 * nothing and a node cannot filter it. One page load asks three questions that all need it, so
 * without this the browser pays for that scan three times over.
 *
 * Sixty seconds, which is the honest trade: a mandate shipped in the last minute may not appear
 * yet. Nothing here decides anything — a stale read makes an answer late, never wrong — and a
 * caller who cannot accept that can pass the program bytes explicitly, which skips this entirely.
 */
const TTL_MS = 60_000;
let cached = { at: 0, value: null };

export async function liveProgram() {
    if (cached.value && Date.now() - cached.at < TTL_MS) return cached.value;
    const found = await latestProgramOnChain();
    if (!found) return null;
    const value = { program: programFromStrategy(found.strategy), strategyHash: found.strategyHash };
    cached = { at: Date.now(), value };
    return value;
}

/** Only for tests that need the next call to actually go to the chain. */
export function forgetLiveProgram() {
    cached = { at: 0, value: null };
}

/** The program to talk about: the one given, or the live position. */
export async function resolveProgram(program) {
    if (program !== undefined && program !== null && program !== '') {
        if (typeof program !== 'string' || !HEX.test(program)) {
            throw new Error('program must be a 0x hex string');
        }
        return { program, source: 'given' };
    }
    const live = await liveProgram();
    if (!live) throw new Error('no program given, and no mandate has been shipped to the live router yet');
    return { program: live.program, source: `live position ${live.strategyHash}` };
}

/** What these bytes permit. Arithmetic, and therefore free. */
export async function decodeAnswer(program) {
    const { program: p, source } = await resolveProgram(program);
    return { source, program: p, ...explain(p) };
}

/** When these exact bytes became public, from a mirror node that is not ours. */
export async function publicationAnswer(program) {
    const { program: p, source } = await resolveProgram(program);
    return { source, ...(await lookupMandate(HCS_TOPIC, p)) };
}

/**
 * Whether the agent may still act.
 *
 * `grantedUntil` is what separates a name the owner pulled from one that simply ran out, and
 * without it both read as "expired" — the report the README calls out for telling the operator of a
 * stopped agent the wrong reason. A caller who does not supply it gets it filled in from the live
 * mandate's own deadline rather than going without.
 */
export async function authorityAnswer({ label, grantedUntil } = {}) {
    const pub = createPublicClient({
        chain: sepolia,
        transport: http(SEPOLIA_RPC),
    });

    let until = grantedUntil;
    if (until === undefined) {
        const live = await liveProgram().catch(() => null);
        if (live) until = readMandate(decodeProgram(live.program)).expiry ?? undefined;
    }

    const name = label || MANDATE_NAME;
    const status = await mandateNameStatus(pub, getAddress(ENS_REGISTRY), name, getAddress(OWNER), {
        grantedUntil: until,
    });
    return { label: name, registry: getAddress(ENS_REGISTRY), ...status };
}

/**
 * What clients have said about the agent, from ERC-8004's reputation registry.
 *
 * Free like the other three, and for the same reason: a caller can read the registry themselves.
 * What it adds to the paid answer is that it arrives joined to everything else about the position
 * rather than as a separate errand.
 */
export async function reputationAnswer({ agentId } = {}) {
    return readReputation(agentId || AGENT_ID);
}
