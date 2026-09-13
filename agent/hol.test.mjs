// Tests for the Hashgraph Online directory entry.
//
// The first half checks the encodings against the spec text, offline, because a wrong canonical
// form or a sloppy HCS-1 reader fails silently: the id still looks like an id and the file still
// parses. The second half reads the real registration back from the public testnet mirror node,
// the only place it exists, and checks it says what this deployment says.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
    AGENT_ACCOUNT, NAME, VERSION, SKILLS, REGISTRY_TOPIC, X402_ENDPOINT, ERC8004_ID, A2A_ENDPOINT, A2A_CARD,
    base58, canonicalAgentData, uaid, batasUaids, batasProfile, validateProfile, livePrice, priceText,
    hcs1Encode, hcs1Decode, readProfile, findAgents, registryEntries,
} from './hol.mjs';
import { IDENTITY_REGISTRY, AGENT_ID, HCS_TOPIC, ENS_NAME } from './deployment.mjs';

const MIRROR = 'https://testnet.mirrornode.hedera.com/api/v1';
const EXPECTED_ERC8004 = `eip155:11155111:${IDENTITY_REGISTRY}/${AGENT_ID}`;

test('canonical agent data follows HCS-14: trimmed, lowercased, sorted skills, alphabetical keys', () => {
    const json = canonicalAgentData({ registry: ' HOL ', name: ' Support Agent ', version: '1.0.0', protocol: 'HCS-10', nativeId: 'hedera:testnet:0.0.123456', skills: [17, 0] });
    assert.equal(json, '{"name":"Support Agent","nativeId":"hedera:testnet:0.0.123456","protocol":"hcs-10","registry":"hol","skills":[0,17],"version":"1.0.0"}');
});

test('the UAID is base58 of a SHA-384 digest, with parameters in spec order', () => {
    const data = { registry: 'hol', name: 'Support Agent', version: '1.0.0', protocol: 'hcs-10', nativeId: 'hedera:testnet:0.0.123456', skills: [0, 17] };
    const id = uaid(data);
    const digest = createHash('sha384').update(canonicalAgentData(data)).digest();
    assert.equal(id, `uaid:aid:${base58(digest)};uid=0;registry=hol;proto=hcs-10;nativeId=hedera:testnet:0.0.123456`);
    assert.throws(() => uaid({ ...data, nativeId: ' ' }), /nativeId is required/);
});

test('base58 keeps leading zero bytes, which carry no numeric value', () => {
    assert.equal(base58(Buffer.from([0, 0, 1])), '112');
    assert.equal(base58(Buffer.from('hello world')), 'StV1DL6CwTryKyV');
});

test('an HCS-1 file survives chunking and reordering, and refuses anything that is not the file', () => {
    const body = Buffer.from(JSON.stringify({ filler: 'x'.repeat(5000), n: Math.PI }));
    const { memo, chunks } = hcs1Encode(body);
    assert.match(memo, /^[0-9a-f]{64}:zstd:base64$/);
    for (const c of chunks) assert.ok(Buffer.byteLength(c) <= 1024, 'an HCS message is capped at 1024 bytes');
    const parsed = chunks.map((c) => JSON.parse(c));
    assert.ok(parsed[0].c.startsWith('data:application/json;base64,'));
    assert.deepEqual(hcs1Decode(memo, [...parsed].reverse()), body);

    const other = hcs1Encode(Buffer.from('{"not":"the file"}'));
    assert.throws(() => hcs1Decode(memo, other.chunks.map((c) => JSON.parse(c))), /does not match the hash/);
    if (parsed.length > 1) assert.throws(() => hcs1Decode(memo, parsed.slice(1)), /missing/);
    assert.throws(() => hcs1Decode(memo, [...parsed, parsed[0]]), /repeated/);
});

test('the profile passes the reference HCS-11 schema and names this deployment', async () => {
    assert.throws(() => batasProfile({ inboundTopicId: '0.0.1', outboundTopicId: '0.0.2' }), /needs the live price/);
    // The price is read from the live manifest even here: a price typed into the test would be the
    // same stale copy the profile used to carry.
    const profile = await validateProfile(batasProfile({ inboundTopicId: '0.0.1', outboundTopicId: '0.0.2', price: await livePrice() }));
    assert.equal(profile.type, 1, 'AI agent');
    assert.equal(profile.properties.x402.endpoint, 'https://batas-one.vercel.app/v1/mandate/explain');
    assert.equal(profile.properties.a2a.endpoint, 'https://batas-one.vercel.app/a2a');
    assert.equal(profile.properties.ens.name, 'agent.batas.eth');
    assert.equal(profile.properties.erc8004.id, EXPECTED_ERC8004);
    assert.equal(profile.properties.hcs.mandateTopic, HCS_TOPIC);
    assert.equal(profile.uaid, batasUaids('0.0.1').hcs10);
});

// Everything below reads the live registration on testnet. One read is shared: the mirror node is
// public and rate limited, and asking it the same question six times tests nothing extra.
let live;
const readLive = () => (live ??= readProfile(AGENT_ACCOUNT));

test('the agent account memo points at an HCS-1 profile, as HCS-11 specifies', async () => {
    const { memo, profileTopic, profile } = await readLive();
    assert.match(memo, /^hcs-11:hcs:\/\/1\/\d+\.\d+\.\d+$/);
    assert.ok(profile, `profile at ${profileTopic} was not readable`);
    const topic = await (await fetch(`${MIRROR}/topics/${profileTopic}`)).json();
    assert.ok(topic.submit_key && !topic.admin_key, 'an HCS-1 file has a submit key and no admin key');
});

test('the live profile carries the endpoint and ERC-8004 identity in deployment.mjs', async () => {
    const { profile } = await readLive();
    assert.equal(profile.display_name, NAME);
    assert.equal(profile.properties.x402.endpoint, X402_ENDPOINT);
    assert.equal(profile.properties.erc8004.id, EXPECTED_ERC8004);
    assert.equal(ERC8004_ID, EXPECTED_ERC8004);
    assert.equal(profile.properties.hcs.mandateTopic, HCS_TOPIC);
    await validateProfile(profile);
});

test('the profile the live memo points at states the price the live x402 manifest states', async () => {
    const [{ profile, profileTopic }, price, card] = await Promise.all([readLive(), livePrice(), fetch(A2A_CARD).then((r) => r.json())]);
    assert.deepEqual(profile.properties.x402.price, price, `hcs://1/${profileTopic} states a price the manifest no longer does; run node agent/hol.mjs --update-profile`);
    assert.ok(profile.bio.includes(priceText(price)), 'the bio a person reads states the same price');
    assert.match(priceText(price), /^\d+\.\d+ to \d+\.\d+ HBAR per answer \(\d+ to \d+ tinybar/);
    assert.ok(BigInt(price.min) <= BigInt(price.max));
    assert.equal(profile.properties.a2a.endpoint, A2A_ENDPOINT);
    assert.equal(card.url, A2A_ENDPOINT, 'the A2A card served by the service names the endpoint the profile does');
    assert.equal(profile.properties.ens.name, ENS_NAME);
});

test('the live UAID recomputes from the published fields', async () => {
    const { profile } = await readLive();
    assert.deepEqual(profile.aiAgent.capabilities, SKILLS);
    const expected = uaid({ registry: 'hol', name: profile.display_name, version: VERSION, protocol: 'hcs-10', nativeId: `hedera:testnet:${AGENT_ACCOUNT}`, skills: profile.aiAgent.capabilities }, { uid: `${profile.inboundTopicId}@${AGENT_ACCOUNT}` });
    assert.equal(profile.uaid, expected);
    assert.equal(profile.properties.erc8004.uaid, batasUaids(profile.inboundTopicId).erc8004);
    assert.match(profile.properties.erc8004.uaid, new RegExp(`;uid=${AGENT_ID};registry=erc-8004;proto=erc-8004;nativeId=eip155:11155111:${IDENTITY_REGISTRY}$`));
});

test('the HCS-10 topics exist with the memos and keys the standard requires', async () => {
    const { profile } = await readLive();
    const inbound = await (await fetch(`${MIRROR}/topics/${profile.inboundTopicId}`)).json();
    const outbound = await (await fetch(`${MIRROR}/topics/${profile.outboundTopicId}`)).json();
    assert.equal(inbound.memo, `hcs-10:0:60:0:${AGENT_ACCOUNT}`);
    assert.equal(inbound.submit_key, null, 'inbound is public so any agent can request a connection');
    assert.equal(outbound.memo, 'hcs-10:0:60:1');
    assert.ok(outbound.submit_key, 'only the agent writes its outbound topic');
});

test('the registry holds a self-paid registration pointing at the same inbound topic and UAID', async () => {
    const { profile } = await readLive();
    const registry = await (await fetch(`${MIRROR}/topics/${REGISTRY_TOPIC}`)).json();
    assert.match(registry.memo, /^hcs-10:0:\d+:3/, 'the topic is an HCS-10 registry');
    const entries = await registryEntries(AGENT_ACCOUNT);
    assert.ok(entries.length >= 1, `no registration by ${AGENT_ACCOUNT} on ${REGISTRY_TOPIC}`);
    const { message } = entries.at(-1);
    assert.equal(message.t_id, profile.inboundTopicId);
    assert.equal(message.uaid, profile.uaid);
    assert.equal(message.m, NAME);
});

test('discovery from the registry alone reaches the x402 endpoint and the ERC-8004 id', async () => {
    const found = await findAgents(NAME);
    const batas = found.find((a) => a.account === AGENT_ACCOUNT);
    assert.ok(batas, `walking ${REGISTRY_TOPIC} did not reach ${AGENT_ACCOUNT}`);
    assert.equal(batas.profile.properties.x402.endpoint, X402_ENDPOINT);
    assert.equal(batas.profile.properties.erc8004.id, EXPECTED_ERC8004);
});
