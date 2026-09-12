// Publishing mandates to a clock nobody in the trade operates.
//
// A mandate already exists on Sepolia: Aqua emits `Shipped` with the full strategy in its data, so
// the terms are public and the hash is fixed. What that does not give you is an independent answer
// to *when*. The timestamp belongs to a block, the block belongs to a chain, and a counterparty
// checking the grant has to take some RPC's word for both.
//
// Hedera Consensus Service is an ordering service and nothing else. A message submitted to a topic
// gets a consensus timestamp agreed by the network and a sequence number that cannot be reordered
// afterwards. Publishing the mandate there costs a fraction of a cent and produces a record that
// the maker cannot backdate, the agent cannot forge, and the counterparty can read for free from a
// public mirror node.
//
// That is what the paid inspection endpoint sells alongside the decoded limits: not only "these
// bytes permit X", but "these exact bytes were published at this consensus time, or never were".
//
//   node agent/hcs.mjs --create-topic     once, to make the topic
//   node agent/hcs.mjs --publish 0x…      publish a program
//   node agent/hcs.mjs --lookup 0x…       find its publication record
//   node agent/hcs.mjs --revocations agent  every time that name was taken back
//   node agent/hcs.mjs --name-grants agent  every time it was granted, or granted again
//   node agent/hcs.mjs --publish-name-grant agent  record the grant the registry holds right now

import 'dotenv/config';
import { createPublicClient, http, keccak256, toHex } from 'viem';
import { sepolia } from 'viem/chains';
import { PUBLISHER, ENS_REGISTRY, SEPOLIA_RPC } from './deployment.mjs';

// Mirror nodes are public and unauthenticated: anyone verifying a mandate reads the record without
// an account, a key, or our permission. That is the property that makes this worth doing.
export const MIRROR = process.env.HEDERA_MIRROR_URL || 'https://testnet.mirrornode.hedera.com/api/v1';

export const MESSAGE_VERSION = 1;

/**
 * The record itself.
 *
 * The full program goes in rather than only its hash. A hash proves nothing to someone who does
 * not already hold the bytes, and the whole point is that a stranger can arrive with a program and
 * ask whether it was ever published. Matching on the bytes answers that; matching on a hash would
 * require them to trust our hashing.
 */
export function mandateMessage({ program, maker, app, chainId, strategyHash }) {
    if (typeof program !== 'string' || !/^0x[0-9a-fA-F]*$/.test(program)) {
        throw new Error('program must be a 0x hex string');
    }
    return JSON.stringify({
        v: MESSAGE_VERSION,
        kind: 'batas.mandate',
        program: program.toLowerCase(),
        ...(maker ? { maker: maker.toLowerCase() } : {}),
        ...(app ? { app: app.toLowerCase() } : {}),
        ...(chainId ? { chainId: Number(chainId) } : {}),
        ...(strategyHash ? { strategyHash: strategyHash.toLowerCase() } : {}),
    });
}

/**
 * A revocation, recorded on the same ledger as the grant.
 *
 * A publication trail that carries only grants tells half a story: it says when authority was
 * given and never when it was taken back, so a reader arriving after a withdrawal sees a standing
 * mandate. The chain has the truth either way — the name is burned and the settlement refuses —
 * but the ledger a stranger reads without an account should not be the optimistic half.
 *
 * The label and registry rather than the program, because revocation is an act against a *name*,
 * and one name may gate more than one position. The program it was gating is carried when it is
 * known, so a reader can join the two.
 */
export function revocationMessage({ label, registry, program, chainId, at }) {
    if (typeof label !== 'string' || label.length === 0) throw new Error('label is required');
    if (typeof registry !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(registry)) {
        throw new Error('registry must be a 0x-prefixed 20-byte address');
    }
    return JSON.stringify({
        v: MESSAGE_VERSION,
        kind: 'batas.revocation',
        label,
        registry: registry.toLowerCase(),
        ...(program ? { program: String(program).toLowerCase() } : {}),
        ...(chainId ? { chainId: Number(chainId) } : {}),
        ...(at ? { at: Number(at) } : {}),
    });
}

/**
 * A grant of the name, recorded on the same ledger as its revocation.
 *
 * Revocations alone are the pessimistic half. A name that was taken back and then granted again —
 * which is exactly what the kill-switch proof does, twice a demo — left the ledger's last word as
 * "revoked" while the chain said "held", and the health report called that a disagreement because
 * it was one. This is the other half: who holds the name, until when, written the moment it is
 * granted, so the newest record about a label agrees with the registry.
 */
export function nameGrantMessage({ label, holder, registry, expiry, tx, chainId }) {
    if (typeof label !== 'string' || label.length === 0) throw new Error('label is required');
    for (const [name, value] of [['holder', holder], ['registry', registry]]) {
        if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
            throw new Error(`${name} must be a 0x-prefixed 20-byte address`);
        }
    }
    if (!Number.isInteger(Number(expiry)) || Number(expiry) <= 0) throw new Error('expiry must be a unix timestamp');
    return JSON.stringify({
        v: MESSAGE_VERSION,
        kind: 'batas.name-grant',
        label,
        holder: holder.toLowerCase(),
        registry: registry.toLowerCase(),
        expiry: Number(expiry),
        ...(tx ? { tx: String(tx).toLowerCase() } : {}),
        ...(chainId ? { chainId: Number(chainId) } : {}),
    });
}

/**
 * Read a mirror-node message back into a record.
 *
 * Anything that is not one of ours comes back as null rather than as a half-parsed object. The
 * topic has no submit key at all — an earlier version of this comment said it did — so foreign
 * traffic is not merely expected, it is free to send, and the parse is only half the filter. The
 * other half is the payer check in the walkers: a well-formed record from an account that is not
 * ours is somebody else's claim, however good it looks.
 */
export function parseMandateMessage(base64) {
    let text;
    try {
        text = Buffer.from(base64, 'base64').toString('utf8');
    } catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (parsed?.kind !== 'batas.mandate' || typeof parsed.program !== 'string') return null;
    if (parsed.v !== MESSAGE_VERSION) return null;
    return parsed;
}

/** The same discipline for the other kind: anything that is not ours comes back as null. */
export function parseRevocationMessage(base64) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    } catch {
        return null;
    }
    if (parsed?.kind !== 'batas.revocation' || typeof parsed.label !== 'string') return null;
    if (parsed.v !== MESSAGE_VERSION) return null;
    return parsed;
}

/** And for a grant. A grant without a holder is not a grant of anything. */
export function parseNameGrantMessage(base64) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    } catch {
        return null;
    }
    if (parsed?.kind !== 'batas.name-grant' || typeof parsed.label !== 'string' || typeof parsed.holder !== 'string') return null;
    if (parsed.v !== MESSAGE_VERSION) return null;
    return parsed;
}

/** A Hedera consensus timestamp is `seconds.nanos`; ISO is what a reader actually wants. */
export function consensusToISO(consensusTimestamp) {
    const [seconds, nanos = '0'] = String(consensusTimestamp).split('.');
    const ms = Number(seconds) * 1000 + Math.floor(Number(nanos.padEnd(9, '0')) / 1e6);
    return new Date(ms).toISOString();
}

// The Hedera SDK is loaded only on the write path. Reading a publication needs nothing but fetch
// and a topic id, and the inspection service only ever reads — dragging a signing SDK into its
// cold start would cost every caller time for a code path they never reach.
async function client() {
    const id = process.env.HEDERA_SERVICE_ID;
    const key = process.env.HEDERA_SERVICE_KEY;
    if (!id || !key) throw new Error('HEDERA_SERVICE_ID and HEDERA_SERVICE_KEY are required to publish');
    const { Client, PrivateKey, AccountId } = await import('@hiero-ledger/sdk');
    // Portal accounts hand out ECDSA keys as DER or as raw hex; accept what the operator has
    // rather than making them convert it.
    const priv = key.startsWith('302') ? PrivateKey.fromStringDer(key) : PrivateKey.fromStringECDSA(key);
    return Client.forTestnet().setOperator(AccountId.fromString(id), priv);
}

/** One-time. Prints the topic id to put in .env as BATAS_HCS_TOPIC. */
export async function createTopic(memo = 'Batas mandate publications') {
    const { TopicCreateTransaction } = await import('@hiero-ledger/sdk');
    const c = await client();
    try {
        const receipt = await (await new TopicCreateTransaction().setTopicMemo(memo).execute(c)).getReceipt(c);
        return receipt.topicId.toString();
    } finally {
        c.close();
    }
}

/**
 * Publish a mandate. Returns what the network agreed, not what we sent.
 *
 * The sequence number comes from the receipt; the consensus timestamp is only observable once the
 * mirror node has the message, so it is left to `lookupMandate` rather than guessed here.
 */
export async function publishMandate(topicId, record) {
    return publishMessage(topicId, mandateMessage(record));
}

/** The same, for a revocation. One topic, both halves of the story. */
export async function publishRevocation(topicId, record) {
    return publishMessage(topicId, revocationMessage(record));
}

/** And for a grant of the name, so a re-grant is not left as the ledger's unsaid half. */
export async function publishNameGrant(topicId, record) {
    return publishMessage(topicId, nameGrantMessage(record));
}

async function publishMessage(topicId, message) {
    const id = topicId || process.env.BATAS_HCS_TOPIC;
    if (!id) throw new Error('no topic: set BATAS_HCS_TOPIC or pass one');
    const { TopicMessageSubmitTransaction } = await import('@hiero-ledger/sdk');
    const c = await client();
    try {
        const submit = new TopicMessageSubmitTransaction().setTopicId(id).setMessage(message);
        const response = await submit.execute(c);
        const receipt = await response.getReceipt(c);
        return {
            topicId: String(id),
            sequenceNumber: Number(receipt.topicSequenceNumber),
            transactionId: response.transactionId.toString(),
            bytes: Buffer.byteLength(message, 'utf8'),
        };
    } finally {
        c.close();
    }
}

/**
 * Every revocation recorded for a name, oldest first.
 *
 * Unlike a grant, a revocation is not matched on bytes: the question is "has this name been taken
 * back", and a name can be granted and pulled more than once. All of them are returned rather than
 * the latest, because a name that was revoked, re-granted and revoked again has a history that a
 * single row would misrepresent.
 */
export async function lookupRevocations(topicId, label, options = {}) {
    const walk = await walkTopic(topicId, label, { ...options, parse: parseRevocationMessage, stamp: 'revokedAt' });
    if (!walk) return { topic: null, revocations: [], reason: 'no topic configured' };
    const { found, ...rest } = walk;
    return { ...rest, revocations: found };
}

/** Every grant recorded for a name, oldest first. The same shape, for the same reason. */
export async function lookupNameGrants(topicId, label, options = {}) {
    const walk = await walkTopic(topicId, label, { ...options, parse: parseNameGrantMessage, stamp: 'grantedAt' });
    if (!walk) return { topic: null, nameGrants: [], reason: 'no topic configured' };
    const { found, ...rest } = walk;
    return { ...rest, nameGrants: found };
}

/** Our records about one name, of one kind, oldest first. Null when there is no topic to ask. */
async function walkTopic(topicId, label, { fetchImpl = fetch, maxPages = 10, publisher = PUBLISHER, parse, stamp }) {
    const id = topicId || process.env.BATAS_HCS_TOPIC;
    if (!id) return null;

    const found = [];
    let next = `/topics/${id}/messages?limit=100&order=asc`;
    for (let page = 0; page < maxPages && next; page++) {
        const res = await fetchImpl(next.startsWith('http') ? next : MIRROR + next.replace(/^\/api\/v1/, ''));
        if (!res.ok) throw new Error(`mirror node ${res.status}`);
        const body = await res.json();
        for (const m of body.messages ?? []) {
            if (m.payer_account_id !== publisher) continue;
            const record = parse(m.message);
            if (record?.label === label) {
                found.push({
                    ...record,
                    payer: m.payer_account_id,
                    consensusTimestamp: m.consensus_timestamp,
                    [stamp]: consensusToISO(m.consensus_timestamp),
                    sequenceNumber: m.sequence_number,
                    mirror: `${MIRROR}/topics/${id}/messages/${m.sequence_number}`,
                });
            }
        }
        next = body.links?.next ?? null;
    }
    // Same rule as below: an unfinished walk is not a finding. A caller told "no revocations" by a
    // loop that ran out of pages has been told the comfortable half of "I do not know".
    return {
        topic: String(id),
        found,
        searched: next ? 'incomplete' : 'complete',
        ...(next ? { reason: `stopped after ${maxPages} pages with more to read` } : {}),
    };
}

/**
 * What the registry says about a name right now, in the shape a grant record wants.
 *
 * For the grant that happened before this record existed: the chain has held the name since
 * then, and the ledger has only ever said it was taken away. Refuses when the name is not held,
 * because a "grant" of a burned name is the exact lie this record exists to prevent.
 */
export async function currentNameGrant(label, { registry = ENS_REGISTRY, rpc = SEPOLIA_RPC } = {}) {
    const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
    const [, expiry, holder] = await pub.readContract({
        address: registry,
        abi: [{
            name: 'getState', type: 'function', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }],
            outputs: [
                { name: 'status', type: 'uint8' }, { name: 'expiry', type: 'uint64' }, { name: 'latestOwner', type: 'address' },
                { name: 'tokenId', type: 'uint256' }, { name: 'resource', type: 'uint256' },
            ],
        }],
        functionName: 'getState',
        args: [BigInt(keccak256(toHex(label)))],
    });
    if (Number(expiry) === 0 || /^0x0{40}$/.test(holder)) throw new Error(`"${label}" is not held in ${registry}; nothing to record`);
    return { label, holder, registry, expiry: Number(expiry), chainId: 11155111 };
}

/**
 * Find the earliest publication of exactly these bytes.
 *
 * Earliest rather than latest on purpose: republishing the same program must not let anyone claim a
 * later date, and the first appearance is the one that bounds when the terms became public.
 *
 * The mirror node cannot filter on message content, so this walks the topic. `maxPages` caps that
 * walk — at 100 messages a page a hackathon-scale topic is one or two requests, and a topic large
 * enough to exceed the cap needs an index rather than a longer loop.
 */
export async function lookupMandate(topicId, program, { fetchImpl = fetch, maxPages = 10, publisher = PUBLISHER } = {}) {
    const id = topicId || process.env.BATAS_HCS_TOPIC;
    if (!id) return { topic: null, published: false, reason: 'no topic configured' };
    const wanted = String(program).toLowerCase();

    // Ascending, so the first content match is also the earliest.
    let next = `/topics/${id}/messages?limit=100&order=asc`;
    let pagesWalked = 0;
    for (let page = 0; page < maxPages && next; page++) {
        pagesWalked = page + 1;
        const res = await fetchImpl(next.startsWith('http') ? next : MIRROR + next.replace(/^\/api\/v1/, ''));
        if (!res.ok) throw new Error(`mirror node ${res.status}`);
        const body = await res.json();
        for (const m of body.messages ?? []) {
            // Ours only. The topic has no submit key, so a message on it proves that somebody
            // paid a fraction of a cent, not that this project said anything. The payer is the
            // signature.
            if (m.payer_account_id !== publisher) continue;
            const record = parseMandateMessage(m.message);
            if (record?.program === wanted) {
                return {
                    topic: String(id),
                    published: true,
                    payer: m.payer_account_id,
                    consensusTimestamp: m.consensus_timestamp,
                    publishedAt: consensusToISO(m.consensus_timestamp),
                    sequenceNumber: m.sequence_number,
                    maker: record.maker ?? null,
                    app: record.app ?? null,
                    chainId: record.chainId ?? null,
                    mirror: `${MIRROR}/topics/${id}/messages/${m.sequence_number}`,
                };
            }
        }
        next = body.links?.next ?? null;
    }
    // Nothing matched — but "nothing matched" is only an answer if the walk actually finished.
    //
    // The loop stops at `maxPages`, and until now a topic longer than that produced exactly the
    // same negative as an empty one: `published: false`, no record, nothing to distinguish them.
    // That is the mistake this function already fixed once at the other end, where a topic that
    // never existed and a topic with no matching message arrived looking identical. Running out of
    // pages is us giving up, and giving up is not a fact about the mandate.
    if (next) {
        return {
            topic: String(id),
            published: null,
            searched: 'incomplete',
            pagesWalked,
            reason: `stopped after ${pagesWalked} pages of this topic with more to read;`
                + ' this is not a statement about whether these bytes were published',
        };
    }

    // Before saying so, find out whether the topic is even real.
    //
    // The messages endpoint answers 200 with an empty list for a topic id that has never existed,
    // so "nobody published this" and "we asked a topic that is not there" arrive looking identical
    // — and the second one means the service is misconfigured, not that the mandate is unvouched.
    // The topic endpoint does return 404, so one extra request in the negative case separates them.
    const info = await fetchImpl(`${MIRROR}/topics/${id}`);
    if (info.status === 404) {
        return {
            topic: String(id),
            published: false,
            topicExists: false,
            searched: 'complete',
            reason: `topic ${id} does not exist on this network; nothing was actually checked`,
        };
    }
    return {
        topic: String(id),
        published: false,
        topicExists: true,
        searched: 'complete',
        pagesWalked,
        reason: 'these bytes have not been published to this topic',
    };
}

// --- cli ---------------------------------------------------------------------

async function main() {
    const [flag, value] = process.argv.slice(2);
    if (flag === '--create-topic') {
        const id = await createTopic();
        console.log(`topic ${id}`);
        console.log(`\nadd to .env:\nBATAS_HCS_TOPIC=${id}`);
        return;
    }
    if (flag === '--revocations') {
        const label = value || 'agent';
        const { revocations, topic } = await lookupRevocations(undefined, label);
        if (revocations.length === 0) {
            console.log(`no revocation of "${label}" recorded on topic ${topic}`);
            return;
        }
        console.log(`"${label}" on topic ${topic}: ${revocations.length} revocation(s)`);
        for (const r of revocations) {
            console.log(`  #${r.sequenceNumber}  ${r.revokedAt}  registry ${r.registry}`);
            console.log(`     ${r.mirror}`);
        }
        return;
    }

    if (flag === '--name-grants') {
        const label = value || 'agent';
        const { nameGrants, topic } = await lookupNameGrants(undefined, label);
        if (nameGrants.length === 0) {
            console.log(`no grant of "${label}" recorded on topic ${topic}`);
            return;
        }
        console.log(`"${label}" on topic ${topic}: ${nameGrants.length} grant(s)`);
        for (const g of nameGrants) {
            console.log(`  #${g.sequenceNumber}  ${g.grantedAt}  to ${g.holder} until ${new Date(g.expiry * 1000).toISOString()}`);
            console.log(`     ${g.mirror}`);
        }
        return;
    }
    if (flag === '--publish-name-grant') {
        const label = value || 'agent';
        const grant = await currentNameGrant(label);
        console.log(`"${label}" is held by ${grant.holder} until ${new Date(grant.expiry * 1000).toISOString()}`);
        console.log(await publishNameGrant(null, grant));
        return;
    }

    if (flag === '--publish' && value) {
        const out = await publishMandate(null, { program: value, chainId: 11155111 });
        console.log(out);
        return;
    }
    if (flag === '--lookup' && value) {
        console.log(await lookupMandate(null, value));
        return;
    }
    console.log('usage: node agent/hcs.mjs [--create-topic | --publish 0x… | --lookup 0x… | --revocations <label> | --name-grants <label> | --publish-name-grant <label>]');
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.message || e));
        process.exit(1);
    });
}
