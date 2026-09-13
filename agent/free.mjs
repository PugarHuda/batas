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
import { lookupMandate, lookupPayments } from './hcs.mjs';
import { mandateNameStatus, resolveName } from './ens.mjs';
import { verifyAgentLink } from './ens-hierarchy.mjs';
import { latestProgramOnChain, programFromStrategy } from './position.mjs';
import { readReputation } from './reputation.mjs';
import { parseAgentId } from './erc8004.mjs';
import { OWNER, ENS_REGISTRY, MANDATE_NAME, ENS_NAME, ENS_PARENT_LABEL, HCS_TOPIC, AGENT_ID, SEPOLIA_RPC } from './deployment.mjs';

const HEX = /^0x[0-9a-fA-F]*$/;

/**
 * An error that is the caller's, with the status that says so.
 *
 * The HTTP layer used to guess whose fault a failure was from the wording of its message, and the
 * guess missed every message nobody had thought to list: an agent id of "abc" and a program cut off
 * mid-instruction both went out as 502 with `upstream: true`, telling a caller to retry a request
 * that could never succeed. A status carried on the error is not a guess.
 */
const refused = (status, message) => Object.assign(new Error(message), { status });

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
    if (Date.now() - cached.at < TTL_MS) {
        if (cached.error) throw cached.error;
        if ('value' in cached && cached.value !== undefined) return cached.value;
    }
    // A miss is remembered for the same minute a hit is. Only hits were cached before, so the day
    // the last position aged out of the scan window every free request — and both of the page's
    // parallel loads — re-ran seven `eth_getLogs` calls against a public node to learn nothing.
    try {
        const found = await latestProgramOnChain();
        const value = found
            ? { program: programFromStrategy(found.strategy), strategyHash: found.strategyHash, docked: found.docked }
            : null;
        cached = { at: Date.now(), value };
        return value;
    } catch (error) {
        cached = { at: Date.now(), error };
        throw error;
    }
}

/** Only for tests that need the next call to actually go to the chain. */
export function forgetLiveProgram() {
    cached = { at: 0, value: null };
}

/** The program to talk about: the one given, or the live position. */
export async function resolveProgram(program) {
    if (program !== undefined && program !== null && program !== '') {
        if (typeof program !== 'string' || !HEX.test(program)) {
            throw refused(400, 'program must be a 0x hex string');
        }
        return { program, source: 'given' };
    }
    const live = await liveProgram();
    if (!live) throw new Error('no program given, and no mandate has been shipped to the live router yet');
    return { program: live.program, source: `live position ${live.strategyHash}`, docked: live.docked };
}

/**
 * A docked position still decodes; it just no longer holds anything. The bytes are the same and
 * the terms read the same, so without this the answer would describe a grant the maker has already
 * withdrawn as if it were standing. Said in the same `notes` the decoder uses, so a reader who only
 * looks there still sees it.
 */
const docking = (answer, docked) => (docked
    ? { ...answer, docked: true, notes: [...(answer.notes ?? []), 'the maker has docked this position; its terms are no longer on offer'] }
    : answer);

/** What these bytes permit. Arithmetic, and therefore free. */
export async function decodeAnswer(program) {
    const { program: p, source, docked } = await resolveProgram(program);
    let decoded;
    try {
        decoded = explain(p);
    } catch (e) {
        // Hex that is not a valid instruction stream is a real answer about the bytes, and the same
        // one the paid route gives them: 422, not a server fault. Only for bytes the caller handed
        // over; the live position failing to decode would be ours.
        if (source === 'given') throw refused(422, String(e.message ?? e));
        throw e;
    }
    return docking({ source, program: p, ...decoded }, docked);
}

/** When these exact bytes became public, from a mirror node that is not ours. */
export async function publicationAnswer(program) {
    const { program: p, source, docked } = await resolveProgram(program);
    return docking({ source, ...(await lookupMandate(HCS_TOPIC, p)) }, docked);
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
    // Checked before any chain read. A label given twice in a query string arrives as an array and
    // was looked up as "a,b"; a deadline of "abc" became NaN and was silently dropped, so the caller
    // was answered a question they had not asked.
    if (label !== undefined && typeof label !== 'string') throw refused(400, 'label must be a string');
    if (typeof grantedUntil === 'string' && /^[0-9]+$/.test(grantedUntil)) grantedUntil = Number(grantedUntil);
    if (grantedUntil !== undefined && !(Number.isSafeInteger(grantedUntil) && grantedUntil >= 0)) {
        throw refused(400, 'grantedUntil must be a non-negative integer of unix seconds');
    }

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
 * The agent's name as ENS clients see it: resolved through the UniversalResolver, with the ENSIP-25
 * link to its ERC-8004 identity checked in both directions.
 *
 * Limited to names under the project's own parent. A free route that resolved any name would be an
 * RPC relay for strangers, and the only names this service has anything to say about are its own —
 * which include the alias and the wildcard answers, so those stay askable.
 */
export async function nameAnswer({ name } = {}) {
    if (name !== undefined && typeof name !== 'string') throw refused(400, 'name must be a string');
    const asked = (name || ENS_NAME).toLowerCase();
    if (!asked.endsWith(`.${ENS_PARENT_LABEL}.eth`) || asked.length > 255) {
        throw refused(400, `name must be a name under ${ENS_PARENT_LABEL}.eth`);
    }
    const pub = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
    const [resolved, link] = await Promise.all([resolveName(pub, asked), verifyAgentLink(pub, { name: asked })]);
    return { name: asked, ...resolved, erc8004: link };
}

/**
 * What clients have said about the agent, from ERC-8004's reputation registry.
 *
 * Free like the other three, and for the same reason: a caller can read the registry themselves.
 * What it adds to the paid answer is that it arrives joined to everything else about the position
 * rather than as a separate errand.
 */
export async function reputationAnswer({ agentId } = {}) {
    if (agentId === undefined || agentId === '') return readReputation(AGENT_ID);
    const id = parseAgentId(agentId);
    if (id === null) throw refused(400, 'agentId must be a non-negative integer');
    return readReputation(String(id));
}

/** How many payment records one answer carries when not asked, and the most it will carry. */
export const PAYMENTS_DEFAULT = 20;
export const PAYMENTS_MAX = 100;
const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;
const trails = new Map();

/**
 * The x402 payment audit trail on the project's HCS topic, each record checked against the ledger.
 *
 * The same reader `node agent/hcs.mjs --payments` prints, so the CLI, this route and the MCP tool
 * cannot disagree about which records verified. Every record is still verified in topic order and
 * only then cut to the newest `limit`, because whether a record is a replay depends on the records
 * before it: `limit` bounds the answer, not the walk.
 *
 * Remembered for the same minute as the live position, per payer asked about. A record never changes
 * once it is on the topic, so a stale read can only be missing a payment settled in the last minute.
 */
export async function paymentsAnswer({ payer, limit } = {}) {
    // Checked before the mirror node is asked, for the reason authorityAnswer gives: a parameter given
    // twice arrives as an array, and "abc" must be refused rather than read as the default.
    if (payer !== undefined && payer !== '' && !(typeof payer === 'string' && ACCOUNT_ID.test(payer))) {
        throw refused(400, 'payer must be a shard.realm.num Hedera account id');
    }
    if (typeof limit === 'string' && /^[0-9]+$/.test(limit)) limit = Number(limit);
    if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1 && limit <= PAYMENTS_MAX)) {
        throw refused(400, `limit must be an integer from 1 to ${PAYMENTS_MAX}`);
    }

    const key = payer || '';
    let hit = trails.get(key);
    if (!hit || Date.now() - hit.at >= TTL_MS) {
        // ponytail: a miss verifies every record on the topic, one mirror read each; when the trail
        // grows past what one request can walk, lookupPayments needs an option to verify only the tail.
        hit = { at: Date.now(), trail: await lookupPayments(HCS_TOPIC, { payer: key || null }) };
        // Keys are validated account ids, so this only grows with distinct payers asked about.
        if (trails.size >= 1000) trails.clear();
        trails.set(key, hit);
    }

    const { payments, ...trail } = hit.trail;
    const kept = limit ?? PAYMENTS_DEFAULT;
    return {
        ...trail,
        total: payments.length,
        verifiedCount: payments.filter((p) => p.verified === true).length,
        limit: kept,
        payments: payments.slice(-kept),
    };
}
