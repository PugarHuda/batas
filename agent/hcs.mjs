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
//   node agent/hcs.mjs --payments [0.0.x]  every x402 payment recorded, checked against the ledger

import 'dotenv/config';
import { createPublicClient, http, keccak256, toHex } from 'viem';
import { sepolia } from 'viem/chains';
import { PUBLISHER, ENS_REGISTRY, SEPOLIA_RPC, HCS_TOPIC } from './deployment.mjs';

// Mirror nodes are public and unauthenticated: anyone verifying a mandate reads the record without
// an account, a key, or our permission. That is the property that makes this worth doing.
export const MIRROR = process.env.HEDERA_MIRROR_URL || 'https://testnet.mirrornode.hedera.com/api/v1';

export const MESSAGE_VERSION = 1;

// A topic id goes straight into a URL path. Anything that is not `shard.realm.num` is refused
// before it can turn into a different path on the mirror node.
const TOPIC_ID = /^\d+\.\d+\.\d+$/;

/**
 * One GET against the mirror node, with a deadline and a second chance.
 *
 * The public mirror node is shared, rate limited and occasionally slow, and a fetch without a
 * deadline hangs the paid answer for as long as the socket does. A 429, a 5xx, a timeout or a
 * dropped connection is the mirror not answering, which is worth two more tries with a short
 * backoff. Anything else — a 404 included — is an answer, and goes back to the caller to read.
 * If every try fails with a status, the last response is returned so the caller's own error names
 * it; if every try failed to connect, that is thrown.
 */
export async function mirrorGet(url, { fetchImpl = fetch, attempts = 3, timeoutMs = 8000, backoffMs = 400 } = {}) {
    let last;
    for (let i = 0; i < attempts; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (i - 1)));
        try {
            last = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
            last = new Error(`mirror node unreachable: ${e.message || e}`);
            continue;
        }
        if (last.status !== 429 && last.status < 500) return last;
    }
    if (last instanceof Error) throw last;
    return last;
}

// The mirror's `links.next` is a path under its own `/api/v1`. It is followed only on the mirror
// that was asked: a page that pointed somewhere else would be a page we did not ask for.
function mirrorURL(path) {
    if (/^https?:/.test(path)) {
        if (new URL(path).origin !== new URL(MIRROR).origin) throw new Error(`mirror node pointed away from itself: ${path}`);
        return path;
    }
    return MIRROR + path.replace(/^\/api\/v1/, '');
}

/**
 * Put a chunked message back together.
 *
 * HCS caps a message at 1024 bytes, and the SDK splits anything longer into chunks that share the
 * initial transaction id and carry their number and total. The mirror node stores every chunk as
 * its own row with its own sequence number, and nothing obliges them to reach consensus in chunk
 * order — on testnet, topic 0.0.7399332 has three-chunk messages whose chunks landed as 1, 3, 2.
 * Reading rows one at a time would never see a long record at all, and concatenating them in
 * sequence order would see a corrupted one.
 *
 * The whole message is dated by the chunk that completed it: before that consensus timestamp the
 * record did not exist in readable form, so an earlier date would overstate how long it has stood.
 * A group that repeats a chunk number or changes its total is dropped whole, because either half
 * could be the one that was meant.
 */
function assemble(pending, m) {
    const info = m.chunk_info;
    const whole = (message, chunks) => ({
        message,
        chunks,
        payer: m.payer_account_id,
        consensusTimestamp: m.consensus_timestamp,
        sequenceNumber: m.sequence_number,
    });
    if (!info || !(info.total > 1)) return whole(m.message, [m.sequence_number]);

    const t = info.initial_transaction_id ?? {};
    // The payer is part of the key so that, on a walk that reads every account, one payer's chunk
    // can never be counted into another payer's message.
    const key = `${m.payer_account_id}|${t.account_id}@${t.transaction_valid_start}/${t.nonce ?? 0}/${t.scheduled ? 1 : 0}`;
    const group = pending.get(key) ?? { total: info.total, parts: new Map() };
    pending.set(key, group);
    if (group.broken) return null;
    if (group.total !== info.total || group.parts.has(info.number) || !(info.number >= 1 && info.number <= info.total)) {
        group.broken = true;
        group.parts.clear();
        return null;
    }
    group.parts.set(info.number, m);
    if (group.parts.size < group.total) return null;

    pending.delete(key);
    const ordered = [...group.parts.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
    const bytes = Buffer.concat(ordered.map((row) => Buffer.from(row.message, 'base64')));
    return whole(bytes.toString('base64'), ordered.map((row) => row.sequence_number));
}

/**
 * Every whole message one account put on a topic, in consensus order.
 *
 * `onMessage` receives each message once it is readable — reassembled when it came in chunks —
 * and returns true to stop. The result says how the walk ended: `stopped` when the caller had what
 * it wanted, `complete` when the topic ran out, `incomplete` when `maxPages` did first.
 *
 * Rows from any other payer are discarded before they reach reassembly. The topic has no submit
 * key, so a stranger can post a chunk that claims one of our initial transaction ids; filtering
 * first means such a chunk can neither complete one of our messages nor poison it.
 *
 * `publisher: null` reads every payer instead, for records whose author is checked per record
 * rather than assumed. Chunk groups are keyed by payer, so the same guarantee holds there.
 *
 * Ascending order is an assumption every caller builds on — "earliest" and "newest" both mean
 * position in this walk — so it is checked rather than trusted: a mirror that hands back a
 * sequence number at or below one it already gave is refused, not read.
 */
export async function readTopic(topicId, { fetchImpl = fetch, maxPages = 10, publisher = PUBLISHER, afterSequence = 0 } = {}, onMessage = () => false) {
    if (!TOPIC_ID.test(String(topicId))) throw new Error(`topic id must be shard.realm.num, not ${topicId}`);
    const pending = new Map();
    let last = Number(afterSequence);
    let next = `/topics/${topicId}/messages?limit=100&order=asc${last > 0 ? `&sequencenumber=gt:${last}` : ''}`;
    let pagesWalked = 0;
    while (next && pagesWalked < maxPages) {
        pagesWalked++;
        const res = await mirrorGet(mirrorURL(next), { fetchImpl });
        if (!res.ok) throw new Error(`mirror node ${res.status}`);
        const body = await res.json();
        for (const m of body.messages ?? []) {
            if (!(m.sequence_number > last)) {
                throw new Error(`mirror node returned topic ${topicId} out of order: #${m.sequence_number} after #${last}`);
            }
            last = m.sequence_number;
            if (publisher !== null && m.payer_account_id !== publisher) continue;
            const message = assemble(pending, m);
            if (message && onMessage(message) === true) return { searched: 'stopped', pagesWalked, lastSequence: last };
        }
        next = body.links?.next ?? null;
    }
    return { searched: next ? 'incomplete' : 'complete', pagesWalked, lastSequence: last };
}

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

// --- payments ----------------------------------------------------------------

const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;
const TRANSACTION_ID = /^(\d+\.\d+\.\d+)[@-](\d+)[.-](\d+)$/;
const DIGEST = /^0x[0-9a-f]{64}$/;
const TINYBARS = /^[1-9]\d*$/;

/**
 * An audit record of one settled x402 payment, published by the account that paid.
 *
 * The x402 settlement is already a public Hedera transaction, but the transaction says only that
 * HBAR moved. It does not say what was bought. This record ties the two together: the transaction
 * id, who paid whom and how much, the resource that was called, and a keccak256 of the exact bytes
 * sent and received. Either party holding the bodies can then show that this payment bought that
 * answer, at a consensus time neither of them controls.
 *
 * The payer publishes it, not the service. The payer already holds a Hedera key, so recording its
 * own payment needs no new secret on the paid service's deployment.
 */
export function paymentMessage({ transaction, payer, payTo, amount, asset, network, resource, requestHash, responseHash }) {
    const tx = TRANSACTION_ID.exec(String(transaction ?? ''));
    if (!tx) throw new Error(`transaction must be a Hedera transaction id, not ${transaction}`);
    for (const [name, value] of [['payer', payer], ['payTo', payTo]]) {
        if (!ACCOUNT_ID.test(String(value))) throw new Error(`${name} must be a shard.realm.num account id`);
    }
    if (!TINYBARS.test(String(amount))) throw new Error('amount must be a positive whole number of tinybars');
    for (const [name, value] of [['requestHash', requestHash], ['responseHash', responseHash]]) {
        if (!DIGEST.test(String(value).toLowerCase())) throw new Error(`${name} must be a 0x-prefixed 32-byte digest`);
    }
    if (typeof asset !== 'string' || !asset || typeof network !== 'string' || !network) throw new Error('asset and network are required');
    if (!/^https?:\/\//.test(String(resource))) throw new Error('resource must be an http(s) URL');
    return JSON.stringify({
        v: MESSAGE_VERSION,
        kind: 'batas.payment',
        transaction: `${tx[1]}@${tx[2]}.${tx[3]}`,
        payer,
        payTo,
        amount: String(amount),
        asset,
        network,
        resource,
        requestHash: requestHash.toLowerCase(),
        responseHash: responseHash.toLowerCase(),
    });
}

/**
 * A payment record, or null. Every field the ledger check reads has to be present and well formed,
 * because a record that cannot be checked is not a record of anything.
 */
export function parsePaymentMessage(base64) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    } catch {
        return null;
    }
    if (parsed?.kind !== 'batas.payment' || parsed.v !== MESSAGE_VERSION) return null;
    if (!TRANSACTION_ID.test(String(parsed.transaction)) || !ACCOUNT_ID.test(String(parsed.payer)) || !ACCOUNT_ID.test(String(parsed.payTo))) return null;
    if (!TINYBARS.test(String(parsed.amount)) || typeof parsed.asset !== 'string' || typeof parsed.network !== 'string') return null;
    if (typeof parsed.resource !== 'string' || !DIGEST.test(String(parsed.requestHash)) || !DIGEST.test(String(parsed.responseHash))) return null;
    return parsed;
}

/** Publish a payment record, signed and paid for by `operator` ({ id, key }), normally the payer. */
export async function publishPayment(topicId, record, operator) {
    return publishMessage(topicId || HCS_TOPIC, paymentMessage(record), operator);
}

/**
 * Check one payment record against the ledger.
 *
 * The record is a claim, and the topic has no submit key, so anyone can make one. It is verified
 * only when all of this holds: the HCS message was paid for by the account the record names as
 * payer (so nobody can file a payment in someone else's name), no earlier record already claimed
 * the same transaction, and the mirror node shows that transaction succeeded and moved at least the
 * stated HBAR out of the payer and into the payee. `verified` is null when the mirror could not
 * answer, which is not the same as false.
 */
export async function verifyPayment(record, { hcsPayer, claimedBy, fetchImpl = fetch, attempts = 2, delayMs = 1000 } = {}) {
    if (hcsPayer !== record.payer) {
        return { verified: false, reason: `the HCS message was paid by ${hcsPayer}, not by the payer it names (${record.payer})` };
    }
    if (claimedBy !== undefined) {
        return { verified: false, reason: `transaction ${record.transaction} was already recorded at #${claimedBy}` };
    }
    if (record.asset !== '0.0.0') return { verified: false, reason: `only HBAR (0.0.0) settlements can be checked, not ${record.asset}` };
    if (record.network !== 'hedera:testnet') return { verified: false, reason: `this mirror node is hedera:testnet, the record says ${record.network}` };

    // Loaded here: inspect.mjs imports this file, so a static import would be a cycle.
    const { confirmSettlement } = await import('./inspect.mjs');
    const ledger = await confirmSettlement(record.transaction, { payer: record.payer, payTo: record.payTo, fetchImpl, attempts, delayMs });
    const facts = {
        result: ledger.result ?? null,
        paid: ledger.paid ?? null,
        received: ledger.received ?? null,
        settledAt: ledger.settledAt ?? null,
        ledger: ledger.mirror ?? null,
    };
    if (ledger.confirmed !== true) return { verified: ledger.confirmed, reason: ledger.reason, ...facts };
    const amount = Number(record.amount);
    if (ledger.paid < amount) return { verified: false, reason: `${ledger.paid} tinybar left ${record.payer}, less than the ${amount} recorded`, ...facts };
    if (ledger.received < amount) return { verified: false, reason: `${ledger.received} tinybar reached ${record.payTo}, less than the ${amount} recorded`, ...facts };
    return { verified: true, ...facts };
}

/**
 * The payment trail on a topic, oldest first, each record checked against the ledger.
 *
 * Every payment record is returned, verified or not. Dropping the ones that fail would make a
 * forged record indistinguishable from no record, and a reader auditing the trail needs to see the
 * forgery. `payer` narrows the walk to one account; without it every account's records are read,
 * and the per-record payer check is what keeps a stranger's record from counting as a payment.
 */
export async function lookupPayments(topicId, { payer = null, fetchImpl = fetch, maxPages = 10, attempts } = {}) {
    const id = topicId || HCS_TOPIC;
    const found = [];
    const walk = await readTopic(id, { fetchImpl, maxPages, publisher: payer }, (m) => {
        const record = parsePaymentMessage(m.message);
        if (record) found.push({ record, m });
    });
    // Only a record that verified can claim a transaction. A stranger's copy, or an inflated one,
    // filed first must not turn the true record into the duplicate.
    const firstClaim = new Map();
    const payments = [];
    for (const { record, m } of found) {
        const claimedBy = firstClaim.get(record.transaction);
        const check = await verifyPayment(record, { hcsPayer: m.payer, claimedBy, fetchImpl, ...(attempts ? { attempts } : {}) });
        if (check.verified === true) firstClaim.set(record.transaction, m.sequenceNumber);
        payments.push({
            ...record,
            hcsPayer: m.payer,
            sequenceNumber: m.sequenceNumber,
            consensusTimestamp: m.consensusTimestamp,
            recordedAt: consensusToISO(m.consensusTimestamp),
            mirror: `${MIRROR}/topics/${id}/messages/${m.sequenceNumber}`,
            ...check,
        });
    }
    return {
        topic: String(id),
        payments,
        searched: walk.searched,
        ...(walk.searched === 'incomplete' ? { reason: `stopped after ${maxPages} pages with more to read` } : {}),
    };
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
// The service account signs mandates and names; a payment record is signed by whoever paid, so
// the account is a parameter rather than always the service's.
async function client({ id = process.env.HEDERA_SERVICE_ID, key = process.env.HEDERA_SERVICE_KEY } = {}) {
    if (!id || !key) throw new Error('a Hedera account id and key are required to publish (HEDERA_SERVICE_ID and HEDERA_SERVICE_KEY by default)');
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

async function publishMessage(topicId, message, operator) {
    const id = topicId || process.env.BATAS_HCS_TOPIC;
    if (!id) throw new Error('no topic: set BATAS_HCS_TOPIC or pass one');
    const { TopicMessageSubmitTransaction } = await import('@hiero-ledger/sdk');
    const c = await client(operator);
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
    const walk = await readTopic(id, { fetchImpl, maxPages, publisher }, (m) => {
        const record = parse(m.message);
        if (record?.label === label) {
            found.push({
                ...record,
                payer: m.payer,
                consensusTimestamp: m.consensusTimestamp,
                [stamp]: consensusToISO(m.consensusTimestamp),
                sequenceNumber: m.sequenceNumber,
                ...(m.chunks.length > 1 ? { chunks: m.chunks } : {}),
                mirror: `${MIRROR}/topics/${id}/messages/${m.sequenceNumber}`,
            });
        }
    });
    // Same rule as below: an unfinished walk is not a finding. A caller told "no revocations" by a
    // loop that ran out of pages has been told the comfortable half of "I do not know".
    return {
        topic: String(id),
        found,
        searched: walk.searched,
        ...(walk.searched === 'incomplete' ? { reason: `stopped after ${maxPages} pages with more to read` } : {}),
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

    // Ascending, so the first content match is also the earliest. Ours only: the topic has no
    // submit key, so a message on it proves that somebody paid a fraction of a cent, not that this
    // project said anything. The payer is the signature, and `readTopic` checks it on every chunk.
    let found = null;
    const { searched, pagesWalked } = await readTopic(id, { fetchImpl, maxPages, publisher }, (m) => {
        const record = parseMandateMessage(m.message);
        if (record?.program !== wanted) return false;
        found = {
            topic: String(id),
            published: true,
            payer: m.payer,
            consensusTimestamp: m.consensusTimestamp,
            publishedAt: consensusToISO(m.consensusTimestamp),
            sequenceNumber: m.sequenceNumber,
            ...(m.chunks.length > 1 ? { chunks: m.chunks } : {}),
            maker: record.maker ?? null,
            app: record.app ?? null,
            chainId: record.chainId ?? null,
            mirror: `${MIRROR}/topics/${id}/messages/${m.sequenceNumber}`,
        };
        return true;
    });
    if (found) return found;
    const next = searched === 'incomplete';
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
    //
    // Only a 404 is evidence that the topic is absent. A mirror that answered 429 or 503 through
    // every retry has said nothing about the topic, and reading that as "it exists" would turn the
    // mirror's bad minute into "these bytes have not been published".
    const info = await mirrorGet(`${MIRROR}/topics/${id}`, { fetchImpl });
    if (!info.ok && info.status !== 404) throw new Error(`mirror node ${info.status}`);
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

    if (flag === '--payments') {
        const { topic, payments, searched } = await lookupPayments(undefined, { payer: value || null });
        const ok = payments.filter((p) => p.verified === true).length;
        console.log(`topic ${topic}: ${payments.length} payment record(s), ${ok} verified against the ledger${searched === 'incomplete' ? ' (walk incomplete)' : ''}`);
        for (const p of payments) {
            const state = p.verified === true ? 'VERIFIED' : p.verified === false ? 'UNVERIFIED' : 'UNCHECKED';
            console.log(`  #${p.sequenceNumber}  ${p.recordedAt}  ${state}  ${Number(p.amount) / 1e8} HBAR  ${p.payer} -> ${p.payTo}`);
            console.log(`     tx        ${p.transaction}  ${p.verified === true ? `${p.result}, settled ${p.settledAt}` : p.reason}`);
            console.log(`     resource  ${p.resource}`);
            console.log(`     request   ${p.requestHash}`);
            console.log(`     response  ${p.responseHash}`);
            console.log(`     record    ${p.mirror}`);
            if (p.ledger) console.log(`     ledger    ${p.ledger}`);
        }
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
    console.log('usage: node agent/hcs.mjs [--create-topic | --publish 0x… | --lookup 0x… | --revocations <label> | --name-grants <label> | --publish-name-grant <label> | --payments [account]]');
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.message || e));
        process.exit(1);
    });
}
