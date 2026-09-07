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

import 'dotenv/config';

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
 * Read a mirror-node message back into a record.
 *
 * Anything that is not one of ours comes back as null rather than as a half-parsed object: a topic
 * is public and writable by anyone holding its submit key, so foreign traffic on it is expected and
 * must not be mistaken for a mandate.
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
    const id = topicId || process.env.BATAS_HCS_TOPIC;
    if (!id) throw new Error('no topic: set BATAS_HCS_TOPIC or pass one');
    const message = mandateMessage(record);
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
 * Find the earliest publication of exactly these bytes.
 *
 * Earliest rather than latest on purpose: republishing the same program must not let anyone claim a
 * later date, and the first appearance is the one that bounds when the terms became public.
 *
 * The mirror node cannot filter on message content, so this walks the topic. `maxPages` caps that
 * walk — at 100 messages a page a hackathon-scale topic is one or two requests, and a topic large
 * enough to exceed the cap needs an index rather than a longer loop.
 */
export async function lookupMandate(topicId, program, { fetchImpl = fetch, maxPages = 10 } = {}) {
    const id = topicId || process.env.BATAS_HCS_TOPIC;
    if (!id) return { topic: null, published: false, reason: 'no topic configured' };
    const wanted = String(program).toLowerCase();

    // Ascending, so the first content match is also the earliest.
    let next = `/topics/${id}/messages?limit=100&order=asc`;
    for (let page = 0; page < maxPages && next; page++) {
        const res = await fetchImpl(next.startsWith('http') ? next : MIRROR + next.replace(/^\/api\/v1/, ''));
        if (!res.ok) throw new Error(`mirror node ${res.status}`);
        const body = await res.json();
        for (const m of body.messages ?? []) {
            const record = parseMandateMessage(m.message);
            if (record?.program === wanted) {
                return {
                    topic: String(id),
                    published: true,
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
    // Nothing matched. Before saying so, find out whether the topic is even real.
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
            reason: `topic ${id} does not exist on this network; nothing was actually checked`,
        };
    }
    return {
        topic: String(id),
        published: false,
        topicExists: true,
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
    if (flag === '--publish' && value) {
        const out = await publishMandate(null, { program: value, chainId: 11155111 });
        console.log(out);
        return;
    }
    if (flag === '--lookup' && value) {
        console.log(await lookupMandate(null, value));
        return;
    }
    console.log('usage: node agent/hcs.mjs [--create-topic | --publish 0x… | --lookup 0x…]');
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.message || e));
        process.exit(1);
    });
}
