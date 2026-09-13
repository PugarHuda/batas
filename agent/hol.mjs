// Making Batas findable, on Hedera, by agents that have never heard of it.
//
// ERC-8004 already says who Batas is, but only to someone who knows to look up agent #10123 on
// Sepolia. The Hashgraph Online standards give the other half: a public directory an agent can walk
// with nothing but a mirror node, and a profile the directory points at.
//
//   HCS-10  an inbound and an outbound topic, and a `register` message on the public testnet
//           registry topic, so HCS-10 agents can list Batas and open a connection to it.
//   HCS-11  a profile (type AI agent) stored as an HCS-1 file and linked from the account memo as
//           `hcs-11:hcs://1/<topic>`. It carries the x402 endpoint and its metered price, the A2A
//           endpoint, the ENS name, the ERC-8004 identity and the mandate publication topic.
//   HCS-14  a Universal Agent ID, computed from the spec's canonical fields and recorded in the
//           profile, plus a second one that names the ERC-8004 registration as its native id.
//
//   node agent/hol.mjs --register         once: create the topics, inscribe the profile, set the memo, register
//   node agent/hol.mjs --update-profile   inscribe a new profile with the live price and move the memo to it
//   node agent/hol.mjs --status           what the account publishes right now
//   node agent/hol.mjs --find             walk the registry from scratch and follow it to the x402 endpoint

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { IDENTITY_REGISTRY, AGENT_ID, HCS_TOPIC, PUBLISHER, ENS_NAME } from './deployment.mjs';
import { MIRROR, mirrorGet } from './hcs.mjs';

export const NETWORK = 'testnet';
/**
 * The public HCS-10 registry on testnet.
 *
 * Its memo is `hcs-10:0:300:3` (an HCS-10 registry), it has no submit key, it is still receiving
 * registrations, and it is the topic the Hashgraph Online Registry Broker reports as the
 * `registryTopicId` of the agents it lists under `hashgraph-online`. The SDK's own guarded-registry
 * endpoint at moonscape.tech answers 404 today, so registration goes to the topic directly.
 */
export const REGISTRY_TOPIC = process.env.HOL_REGISTRY_TOPIC || '0.0.6913983';
/** The Hedera account that is Batas in the directory. Its memo is the pointer to the profile. */
export const AGENT_ACCOUNT = process.env.HEDERA_AGENT_ID || '0.0.10388401';
export const NAME = 'Batas';
/** The agent version that goes into the UAID hash. Bumping it changes the UAID, deliberately. */
export const VERSION = '1.0.0';
export const ORIGIN = 'https://batas-one.vercel.app';
export const X402_ENDPOINT = `${ORIGIN}/v1/mandate/explain`;
export const X402_MANIFEST = `${ORIGIN}/.well-known/x402`;
export const A2A_ENDPOINT = `${ORIGIN}/a2a`;
export const A2A_CARD = `${ORIGIN}/.well-known/agent-card.json`;
export const NAME_ENDPOINT = `${ORIGIN}/v1/agent/name`;
export const ERC8004_ID = `eip155:11155111:${IDENTITY_REGISTRY}/${AGENT_ID}`;
/**
 * HCS-11 capability numbers: Transaction Analytics (10), Smart Contract Audit (11) and API
 * Integration & Orchestration (17). Batas reads what SwapVM bytecode permits and sells the answer
 * over an API; it generates no text, so Text Generation (0) is not claimed.
 */
export const SKILLS = [10, 11, 17];

const ENTITY = /^\d+\.\d+\.\d+$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes) {
    let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
    let out = '';
    while (n > 0n) {
        out = BASE58[Number(n % 58n)] + out;
        n /= 58n;
    }
    // Leading zero bytes carry no numeric value, so base58 spells each one as a literal '1'.
    for (const b of bytes) {
        if (b !== 0) break;
        out = '1' + out;
    }
    return out;
}

/**
 * HCS-14 canonical JSON: only the six required fields, strings trimmed, registry and protocol
 * lowercased, skills sorted ascending, keys in alphabetical order.
 *
 * The spec's own example serialises with `JSON.stringify(canonical, Object.keys(canonical).sort())`,
 * and a replacer array fixes the output order, so the order is alphabetical. The standards SDK 0.1.186
 * orders the keys `skills, name, nativeId, protocol, registry, version` instead, which hashes to a
 * different id for the same agent; this follows the spec text.
 */
export function canonicalAgentData({ registry, name, version, protocol, nativeId, skills }) {
    for (const [k, v] of Object.entries({ registry, name, version, protocol, nativeId })) {
        if (typeof v !== 'string' || !v.trim()) throw new Error(`HCS-14: ${k} is required`);
    }
    if (!Array.isArray(skills) || !skills.every((s) => Number.isInteger(s) && s >= 0)) throw new Error('HCS-14: skills must be non-negative integers');
    const canonical = {
        name: name.trim(),
        nativeId: nativeId.trim(),
        protocol: protocol.trim().toLowerCase(),
        registry: registry.trim().toLowerCase(),
        skills: [...skills].sort((a, b) => a - b),
        version: version.trim(),
    };
    return JSON.stringify(canonical, Object.keys(canonical).sort());
}

/** `uaid:aid:<base58(sha384(canonical))>;uid=…;registry=…;proto=…;nativeId=…`, parameters in spec order. */
export function uaid(data, { uid = '0' } = {}) {
    const json = canonicalAgentData(data);
    const id = base58(createHash('sha384').update(json, 'utf8').digest());
    return `uaid:aid:${id};uid=${uid};registry=${data.registry.trim().toLowerCase()};proto=${data.protocol.trim().toLowerCase()};nativeId=${data.nativeId.trim()}`;
}

/**
 * Both ids for Batas.
 *
 * HCS-10 requires the native id to be the Hedera account in CAIP-10 form, and the `uid` is
 * `inbound@account`, the operator id HCS-10 agents address each other by. HCS-14 has one native id
 * per UAID, so the ERC-8004 registration gets its own: CAIP-10 for the registry contract, with the
 * agent number as the unique id inside that registry. Same name, version and skills, so the two are
 * the same agent described from each ledger.
 */
export function batasUaids(inboundTopicId, account = AGENT_ACCOUNT) {
    const base = { name: NAME, version: VERSION, skills: SKILLS };
    return {
        hcs10: uaid({ ...base, registry: 'hol', protocol: 'hcs-10', nativeId: `hedera:${NETWORK}:${account}` }, { uid: `${inboundTopicId}@${account}` }),
        erc8004: uaid({ ...base, registry: 'erc-8004', protocol: 'erc-8004', nativeId: `eip155:11155111:${IDENTITY_REGISTRY}` }, { uid: String(AGENT_ID) }),
    };
}

/**
 * The paid answer's price, read from the live x402 manifest rather than written here.
 *
 * The first profile said "0.001 HBAR" and was wrong the day the service became metered, because a
 * price copied into a file nobody can edit only stays true while nobody changes the service. Reading
 * it at inscription time, and testing the live profile against the live manifest, makes the next
 * drift a red test instead of a quiet lie. Token decimals and symbols come from the mirror node,
 * since the manifest states amounts in each asset's smallest unit.
 */
export async function livePrice(url = X402_MANIFEST) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const resource = (await res.json()).resources?.find((r) => r.url === X402_ENDPOINT && r.method === 'POST');
    const m = resource?.metered;
    if (m?.unit !== 'tinybar' || !/^\d+$/.test(m.min) || !/^\d+$/.test(m.max) || typeof m.formula !== 'string') throw new Error(`${url} states no metered tinybar price for ${X402_ENDPOINT}`);
    const accepts = [];
    for (const { network, asset, amount } of resource.accepts ?? []) {
        if (!ENTITY.test(asset) || !/^\d+$/.test(amount)) throw new Error(`${url} accepts a malformed asset ${asset} / amount ${amount}`);
        const token = asset === '0.0.0' ? { symbol: 'HBAR', decimals: 8 } : await getJSON(`/tokens/${asset}`);
        accepts.push({ network, asset, symbol: token.symbol, decimals: Number(token.decimals), amount });
    }
    return { unit: m.unit, min: m.min, max: m.max, formula: m.formula, accepts };
}

/** One sentence a person can read: the HBAR range, and each other asset's fixed amount. */
export function priceText({ unit, min, max, accepts }) {
    const hbar = (tinybar) => String(Number(tinybar) / 1e8);
    const tokens = accepts.filter((a) => a.asset !== '0.0.0').map((a) => `${(Number(a.amount) / 10 ** a.decimals).toFixed(a.decimals)} ${a.symbol} (HTS ${a.asset})`);
    return `${hbar(min)} to ${hbar(max)} HBAR per answer (${min} to ${max} ${unit}, the exact amount stated in each 402)${tokens.length ? `, or ${tokens.join(' or ')}` : ''}`;
}

export function batasProfile({ inboundTopicId, outboundTopicId, account = AGENT_ACCOUNT, price }) {
    if (!price) throw new Error('batasProfile needs the live price from livePrice()');
    const ids = batasUaids(inboundTopicId, account);
    return {
        version: '1.0',
        type: 1,
        display_name: NAME,
        alias: 'batas',
        uaid: ids.hcs10,
        bio: `Inspects 1inch Aqua market-making mandates written as SwapVM bytecode: what the terms permit, when they were published to HCS, and whether ${ENS_NAME} still holds authority. The full answer is sold over x402 on Hedera testnet, metered: ${priceText(price)}. Also served over A2A at ${A2A_ENDPOINT}.`,
        inboundTopicId,
        outboundTopicId,
        properties: {
            url: ORIGIN,
            x402: { endpoint: X402_ENDPOINT, method: 'POST', network: 'hedera:testnet', payTo: PUBLISHER, facilitator: 'Blocky402', manifest: X402_MANIFEST, price },
            a2a: { endpoint: A2A_ENDPOINT, agentCard: A2A_CARD },
            ens: { name: ENS_NAME, resolve: NAME_ENDPOINT },
            erc8004: { id: ERC8004_ID, uaid: ids.erc8004 },
            hcs: { mandateTopic: HCS_TOPIC },
        },
        aiAgent: {
            type: 1,
            capabilities: SKILLS,
            model: 'none: a deterministic SwapVM bytecode decoder, no language model',
            creator: 'Batas',
        },
    };
}

/** Refuses a profile the reference schema would refuse, before any HBAR is spent on it. */
export async function validateProfile(profile) {
    const { HCS11ProfileSchema } = await import('@hashgraphonline/standards-sdk');
    const r = HCS11ProfileSchema.safeParse(profile);
    if (!r.success) throw new Error(`HCS-11 profile invalid: ${r.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
    return profile;
}

// HCS-1 caps a message at 1024 bytes; 1000 characters of content leaves room for `{"o":NN,"c":""}`.
const HCS1_CHUNK = 1000;

/**
 * An HCS-1 file: the topic memo is `sha256(file):zstd:base64`, the content is zstd-compressed,
 * base64-encoded behind a data URI prefix, and split into `{"o": index, "c": chunk}` messages.
 */
export function hcs1Encode(bytes, mime = 'application/json') {
    const file = Buffer.from(bytes);
    const data = `data:${mime};base64,${zstdCompressSync(file).toString('base64')}`;
    const chunks = [];
    for (let o = 0; o * HCS1_CHUNK < data.length; o++) chunks.push(JSON.stringify({ o, c: data.slice(o * HCS1_CHUNK, (o + 1) * HCS1_CHUNK) }));
    return { memo: `${createHash('sha256').update(file).digest('hex')}:zstd:base64`, chunks };
}

/**
 * Reassemble an HCS-1 file and prove it is the file the memo names.
 *
 * Chunks are placed by `o`, not by arrival, and every index from 0 up must appear exactly once: a
 * gap or a repeat means the bytes cannot be the file, and guessing which repeat was meant would be
 * choosing the content.
 */
export function hcs1Decode(memo, chunks) {
    const [hash, algo, encoding] = String(memo).split(':');
    if (!/^[0-9a-f]{64}$/.test(hash) || algo !== 'zstd' || encoding !== 'base64') throw new Error(`not an HCS-1 zstd/base64 memo: ${memo}`);
    const byIndex = new Map();
    for (const { o, c } of chunks) {
        if (!Number.isInteger(o) || typeof c !== 'string' || byIndex.has(o)) throw new Error(`HCS-1 chunk ${o} is malformed or repeated`);
        byIndex.set(o, c);
    }
    const parts = [];
    for (let o = 0; o < byIndex.size; o++) {
        if (!byIndex.has(o)) throw new Error(`HCS-1 chunk ${o} is missing`);
        parts.push(byIndex.get(o));
    }
    const data = parts.join('').replace(/^data:[^,]*,/, '');
    const file = zstdDecompressSync(Buffer.from(data, 'base64'));
    if (createHash('sha256').update(file).digest('hex') !== hash) throw new Error('HCS-1 file does not match the hash in its topic memo');
    return file;
}

async function getJSON(path) {
    const res = await mirrorGet(MIRROR + path.replace(/^\/api\/v1/, ''));
    if (!res.ok) throw new Error(`mirror node ${res.status} for ${path}`);
    return res.json();
}

/**
 * Every message on a topic, in consensus order, from every payer.
 *
 * Running out of pages before the topic runs out is thrown rather than returned as a short list,
 * because "Batas is not in the registry" and "we did not read the whole registry" are different
 * answers.
 */
async function* topicMessages(topicId, { maxPages = 200 } = {}) {
    if (!ENTITY.test(topicId)) throw new Error(`topic id must be shard.realm.num, not ${topicId}`);
    let next = `/topics/${topicId}/messages?limit=100&order=asc`;
    for (let page = 0; next; page++) {
        if (page === maxPages) throw new Error(`topic ${topicId} is longer than ${maxPages} pages; not read to the end`);
        const body = await getJSON(next);
        yield* body.messages ?? [];
        next = body.links?.next ?? null;
    }
}

const decode = (row) => {
    try {
        return JSON.parse(Buffer.from(row.message, 'base64').toString('utf8'));
    } catch {
        return null;
    }
};

/**
 * Follow an account memo to its HCS-11 profile, reading only the mirror node.
 *
 * The HCS-1 validity rules are checked, not assumed: the file topic must have a submit key (so only
 * its owner could write the chunks) and no admin key (so it cannot be deleted or rewritten later).
 */
export async function readProfile(account) {
    if (!ENTITY.test(account)) throw new Error(`account id must be shard.realm.num, not ${account}`);
    const { memo = '' } = await getJSON(`/accounts/${account}?transactions=false`);
    const ref = /^hcs-11:hcs:\/\/1\/(\d+\.\d+\.\d+)$/.exec(memo);
    if (!ref) return { account, memo, profileTopic: null, profile: null };
    const profileTopic = ref[1];
    const profile = JSON.parse((await readHcs1(profileTopic)).toString('utf8'));
    return { account, memo, profileTopic, profile };
}

export async function readHcs1(topicId) {
    const topic = await getJSON(`/topics/${topicId}`);
    if (!topic.submit_key || topic.admin_key) throw new Error(`hcs://1/${topicId} is not a valid HCS-1 file: it needs a submit key and no admin key`);
    const chunks = [];
    for await (const row of topicMessages(topicId)) chunks.push(decode(row) ?? {});
    return hcs1Decode(topic.memo, chunks);
}

/**
 * Registry entries an account made for itself.
 *
 * The registry topic has no submit key, so anyone can post `register` naming any account. An entry
 * counts only when the account it names paid for it, which the mirror node reports on every row.
 */
function selfRegistration(row) {
    const msg = decode(row);
    if (msg?.p !== 'hcs-10' || msg.op !== 'register' || !ENTITY.test(String(msg.account_id))) return null;
    return msg.account_id === row.payer_account_id ? msg : null;
}

/**
 * Discovery from the directory alone: walk the registry, keep self-registrations listed under
 * `name`, and follow each to its profile. Every candidate is returned; the directory cannot say which
 * of two agents that chose the same name is the one you meant, and it is not this function's place to
 * pretend it can.
 */
export async function findAgents(name = NAME, { registry = REGISTRY_TOPIC } = {}) {
    const listed = [];
    for await (const row of topicMessages(registry)) {
        const msg = selfRegistration(row);
        if (msg?.m === name) listed.push({ msg, row });
    }
    const found = [];
    for (const { msg, row } of listed) {
        let resolved;
        try {
            resolved = await readProfile(msg.account_id);
        } catch (e) {
            resolved = { account: msg.account_id, profile: null, error: e.message };
        }
        found.push({ registry, sequence: row.sequence_number, registeredAt: row.consensus_timestamp, registeredUaid: msg.uaid ?? null, ...resolved });
    }
    return found.filter((f) => f.error || f.profile?.display_name === name);
}

export async function registryEntries(account = AGENT_ACCOUNT, { registry = REGISTRY_TOPIC } = {}) {
    const out = [];
    for await (const row of topicMessages(registry)) {
        const msg = selfRegistration(row);
        if (msg?.account_id === account) out.push({ sequence: row.sequence_number, consensusTimestamp: row.consensus_timestamp, message: msg });
    }
    return out;
}

/**
 * One-time registration, written by the agent account itself.
 *
 * It refuses to run when the account already carries a memo: the memo is the only pointer to the
 * profile, and a second run would silently replace a registration other agents may already hold.
 */
export async function register({ log = console.log } = {}) {
    const id = process.env.HEDERA_AGENT_ID;
    const key = process.env.HEDERA_AGENT_KEY;
    if (!id || !key) throw new Error('HEDERA_AGENT_ID and HEDERA_AGENT_KEY are required to register');
    const existing = await getJSON(`/accounts/${id}?transactions=false`);
    if (existing.memo) throw new Error(`account ${id} already carries memo "${existing.memo}"; registration is one-time, use --update-profile`);

    const price = await livePrice();
    const { sdk, priv, client, run, txs } = await agentClient(id, key, log);
    try {
        // Inbound is public: any agent may ask for a connection. Outbound carries a submit key, since
        // HCS-10 says only the agent writes its own outbound record.
        const inboundTopicId = (await run('inbound topic', new sdk.TopicCreateTransaction().setTopicMemo(`hcs-10:0:60:0:${id}`).setAdminKey(priv.publicKey))).topicId.toString();
        const outboundTopicId = (await run('outbound topic', new sdk.TopicCreateTransaction().setTopicMemo('hcs-10:0:60:1').setAdminKey(priv.publicKey).setSubmitKey(priv.publicKey))).topicId.toString();

        const profile = await validateProfile(batasProfile({ inboundTopicId, outboundTopicId, account: id, price }));
        const file = hcs1Encode(JSON.stringify(profile));
        // No admin key: an HCS-1 file with one could be deleted, and HCS-1 readers treat it as invalid.
        const profileTopicId = (await run('profile file', new sdk.TopicCreateTransaction().setTopicMemo(file.memo).setSubmitKey(priv.publicKey))).topicId.toString();
        for (const [i, chunk] of file.chunks.entries()) await run(`profile chunk ${i}`, new sdk.TopicMessageSubmitTransaction().setTopicId(profileTopicId).setMessage(chunk));
        await run('account memo', new sdk.AccountUpdateTransaction().setAccountId(id).setAccountMemo(`hcs-11:hcs://1/${profileTopicId}`));

        // `account_id` and `m` are the HCS-10 register fields. `inbound_topic_id` is what the standards
        // SDK writes; `t_id` and `uaid` are what the registrations currently arriving on this topic
        // carry. Writing all of them costs nothing and lets each reader find the field it looks for.
        const entry = { p: 'hcs-10', op: 'register', account_id: id, uaid: profile.uaid, t_id: inboundTopicId, inbound_topic_id: inboundTopicId, m: NAME };
        await run('registry entry', new sdk.TopicMessageSubmitTransaction().setTopicId(REGISTRY_TOPIC).setTransactionMemo('hcs-10:op:0:0').setMessage(JSON.stringify(entry)));
        return { account: id, inboundTopicId, outboundTopicId, profileTopicId, registry: REGISTRY_TOPIC, uaid: profile.uaid, erc8004Uaid: profile.properties.erc8004.uaid, transactions: txs };
    } finally {
        client.close();
    }
}

/** The agent account as a transaction signer, with each transaction waited on and logged by label. */
async function agentClient(id, key, log) {
    const sdk = await import('@hiero-ledger/sdk');
    const priv = key.startsWith('302') ? sdk.PrivateKey.fromStringDer(key) : sdk.PrivateKey.fromStringECDSA(key);
    const client = sdk.Client.forTestnet().setOperator(sdk.AccountId.fromString(id), priv);
    const txs = {};
    const run = async (label, tx) => {
        const response = await tx.execute(client);
        const receipt = await response.getReceipt(client);
        txs[label] = response.transactionId.toString();
        log(`  ${label.padEnd(18)} ${txs[label]}${receipt.topicId ? `  topic ${receipt.topicId}` : ''}`);
        return receipt;
    };
    return { sdk, priv, client, run, txs };
}

/**
 * A new profile for an agent already in the directory.
 *
 * An HCS-1 file has no admin key, so the old profile cannot be rewritten: the update is a new file
 * and a memo that points at it. The inbound and outbound topics are carried over from the profile
 * being replaced, which keeps both UAIDs, so the registry entry and any connection opened on those
 * topics stay valid.
 *
 * Nothing is sent to the registry. HCS-10 defines `register`, `delete` and `migrate` for a registry
 * topic and no update: the entry names the account, inbound topic and UAID, none of which change, and
 * every reader reaches the profile through the account memo.
 */
export async function updateProfile({ log = console.log } = {}) {
    const id = process.env.HEDERA_AGENT_ID;
    const key = process.env.HEDERA_AGENT_KEY;
    if (!id || !key) throw new Error('HEDERA_AGENT_ID and HEDERA_AGENT_KEY are required to update the profile');
    const current = await readProfile(id);
    if (!current.profile) throw new Error(`account ${id} has no HCS-11 profile to update (memo "${current.memo}"); use --register`);

    const { inboundTopicId, outboundTopicId } = current.profile;
    const profile = await validateProfile(batasProfile({ inboundTopicId, outboundTopicId, account: id, price: await livePrice() }));
    if (profile.uaid !== current.profile.uaid || profile.properties.erc8004.uaid !== current.profile.properties?.erc8004?.uaid) {
        throw new Error('the new profile would change a UAID the registry entry or the ERC-8004 link names; refusing');
    }
    const body = JSON.stringify(profile);
    // Each run costs HBAR and adds a topic, so a profile identical to the live one is not inscribed again.
    if (body === JSON.stringify(current.profile)) {
        log(`  profile already current at hcs://1/${current.profileTopic}; nothing sent`);
        return { account: id, profileTopicId: current.profileTopic, unchanged: true };
    }

    const { sdk, priv, client, run, txs } = await agentClient(id, key, log);
    try {
        const file = hcs1Encode(body);
        const profileTopicId = (await run('profile file', new sdk.TopicCreateTransaction().setTopicMemo(file.memo).setSubmitKey(priv.publicKey))).topicId.toString();
        for (const [i, chunk] of file.chunks.entries()) await run(`profile chunk ${i}`, new sdk.TopicMessageSubmitTransaction().setTopicId(profileTopicId).setMessage(chunk));

        // The memo is the only pointer to the profile, so it moves only once the mirror node serves
        // the new file whole. Pointing it at a file readers cannot assemble yet would unlist Batas for
        // as long as the mirror lags. hcs1Decode checks the sha256 in the memo, which was taken over
        // these exact bytes, so a successful read is the file.
        let lastError;
        for (let attempt = 0; ; attempt++) {
            try {
                await readHcs1(profileTopicId);
                break;
            } catch (e) {
                lastError = e;
                if (attempt === 20) throw new Error(`hcs://1/${profileTopicId} was not readable from the mirror node after a minute (${lastError.message}); the memo was not moved`);
                await sleep(3000);
            }
        }
        await run('account memo', new sdk.AccountUpdateTransaction().setAccountId(id).setAccountMemo(`hcs-11:hcs://1/${profileTopicId}`));
        log(`  registry           ${REGISTRY_TOPIC} unchanged: HCS-10 has no update message, and the entry's inbound topic and UAID are the same`);
        return { account: id, previousProfileTopicId: current.profileTopic, profileTopicId, uaid: profile.uaid, erc8004Uaid: profile.properties.erc8004.uaid, price: profile.properties.x402.price, transactions: txs };
    } finally {
        client.close();
    }
}

function printAgent(a) {
    const p = a.profile;
    console.log(`  account      ${a.account}`);
    if (a.error) return console.log(`  profile      unreadable: ${a.error}`);
    console.log(`  profile      ${a.memo}   (${MIRROR}/topics/${a.profileTopic}/messages)`);
    console.log(`  uaid         ${p.uaid}`);
    console.log(`  inbound      ${p.inboundTopicId}   outbound ${p.outboundTopicId}`);
    console.log(`  x402         ${p.properties?.x402?.endpoint ?? '(none)'}`);
    console.log(`  price        ${p.properties?.x402?.price ? priceText(p.properties.x402.price) : '(not stated: a profile from before metering)'}`);
    console.log(`  a2a          ${p.properties?.a2a?.endpoint ?? '(none)'}`);
    console.log(`  ens          ${p.properties?.ens?.name ?? '(none)'}`);
    console.log(`  erc-8004     ${p.properties?.erc8004?.id ?? '(none)'}`);
    console.log(`  erc-8004 id  ${p.properties?.erc8004?.uaid ?? '(none)'}`);
    console.log(`  mandates     ${p.properties?.hcs?.mandateTopic ?? '(none)'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [cmd, arg] = process.argv.slice(2);
    try {
        if (cmd === '--register') {
            console.log(`registering ${NAME} on Hedera ${NETWORK}, registry ${REGISTRY_TOPIC}`);
            console.log(JSON.stringify(await register(), null, 2));
        } else if (cmd === '--update-profile') {
            console.log(`updating the HCS-11 profile of ${NAME} on Hedera ${NETWORK} from ${X402_MANIFEST}`);
            console.log(JSON.stringify(await updateProfile(), null, 2));
        } else if (cmd === '--status') {
            const account = arg || AGENT_ACCOUNT;
            const a = await readProfile(account);
            if (!a.profile) {
                console.log(`${account} has no HCS-11 profile (memo: "${a.memo}")`);
            } else {
                printAgent(a);
                for (const t of [a.profile.inboundTopicId, a.profile.outboundTopicId]) console.log(`  topic memo   ${t}  ${(await getJSON(`/topics/${t}`)).memo}`);
            }
            const entries = await registryEntries(account);
            for (const e of entries) console.log(`  registered   ${REGISTRY_TOPIC} #${e.sequence} at ${e.consensusTimestamp}`);
            if (!entries.length) console.log(`  registered   not in ${REGISTRY_TOPIC}`);
        } else if (cmd === '--find') {
            const name = arg || NAME;
            console.log(`walking HCS-10 registry ${REGISTRY_TOPIC} on the ${NETWORK} mirror node for "${name}"`);
            const found = await findAgents(name);
            if (!found.length) console.log('  not listed');
            for (const a of found) {
                console.log(`\n  listed       ${a.registry} #${a.sequence} at ${a.registeredAt}`);
                printAgent(a);
            }
        } else {
            console.log('usage: node agent/hol.mjs --register | --update-profile | --status [account] | --find [name]');
            process.exitCode = 2;
        }
    } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}
