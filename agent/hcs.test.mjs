// Tests for the mandate publication record.
//
// What this ledger is worth depends entirely on two things being true: that a record cannot be
// confused with unrelated traffic on the same public topic, and that "published" means these exact
// bytes rather than something close to them. Both are silent failures — a loose parser and a loose
// match would both make the endpoint answer "yes, published" to a program nobody ever published.
//
// The lookups below hit the real mirror node against the real topic. There is nothing to stub: the
// value of the record is that a third party can read it without us, so testing it through a
// substitute would test the substitute.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mandateMessage, parseMandateMessage, consensusToISO, lookupMandate, MESSAGE_VERSION } from './hcs.mjs';

const TOPIC = process.env.BATAS_HCS_TOPIC;
// The mandate actually standing on Sepolia, published to the topic at sequence 1. Using the live
// grant rather than a made-up one keeps the ledger free of invented makers — a public record is a
// bad place to leave test data, because a reader has no way to tell it apart from a real grant.
const PUBLISHED = '0x2120000000000000000579a814e10a74000000000000000000001aaa51121b2314122005006a9d899a700300753050000208000000006a9d6d7a';
const MAKER = '0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e';

const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

test('a record carries the program itself, not only a digest', () => {
    const record = JSON.parse(mandateMessage({ program: '0xABCD', chainId: 11155111 }));
    assert.equal(record.program, '0xabcd', 'normalised, so casing cannot split one mandate into two records');
    assert.equal(record.kind, 'batas.mandate');
    assert.equal(record.v, MESSAGE_VERSION);
    assert.equal(record.chainId, 11155111);
});

test('optional fields are omitted rather than published as null', () => {
    const record = JSON.parse(mandateMessage({ program: '0x00' }));
    assert.deepEqual(Object.keys(record), ['v', 'kind', 'program']);
});

test('a record refuses to be built from something that is not a program', () => {
    assert.throws(() => mandateMessage({ program: 'not hex' }), /0x hex/);
    assert.throws(() => mandateMessage({ program: undefined }), /0x hex/);
    assert.throws(() => mandateMessage({ program: '0xZZ' }), /0x hex/);
});

test('a record survives the round trip through base64', () => {
    const message = mandateMessage({ program: '0x2120ff', maker: '0xAbC', chainId: 1 });
    const back = parseMandateMessage(Buffer.from(message).toString('base64'));
    assert.equal(back.program, '0x2120ff');
    assert.equal(back.maker, '0xabc');
});

test('foreign traffic on the topic is not mistaken for a mandate', () => {
    // A topic is public. Anything may land on it, and none of it may read as a grant.
    assert.equal(parseMandateMessage(encode({ hello: 'world' })), null);
    assert.equal(parseMandateMessage(encode({ kind: 'something.else', program: '0x00' })), null);
    assert.equal(parseMandateMessage(encode({ kind: 'batas.mandate' })), null, 'no program, no record');
    assert.equal(parseMandateMessage(Buffer.from('plain text').toString('base64')), null);
});

test('a record from a future format version is refused, not guessed at', () => {
    // Reading v2 fields with v1 assumptions would report limits that were never published.
    assert.equal(parseMandateMessage(encode({ v: MESSAGE_VERSION + 1, kind: 'batas.mandate', program: '0x00' })), null);
});

test('a consensus timestamp becomes a real instant', () => {
    assert.equal(consensusToISO('1788709059.587144270'), '2026-09-06T15:37:39.587Z');
    assert.equal(consensusToISO('0.000000000'), '1970-01-01T00:00:00.000Z');
    assert.equal(consensusToISO('1788709059'), '2026-09-06T15:37:39.000Z', 'nanos are optional');
});

test('the published mandate is found on the public mirror node', { skip: !TOPIC && 'BATAS_HCS_TOPIC not set' }, async () => {
    const record = await lookupMandate(null, PUBLISHED);
    assert.equal(record.published, true);
    assert.equal(record.topic, TOPIC);
    assert.equal(record.sequenceNumber, 1);
    assert.equal(record.chainId, 11155111);
    assert.equal(record.maker, MAKER, 'the record must name the address that actually granted it');
    assert.ok(Date.parse(record.publishedAt) > 0, 'a record without a readable time proves nothing');
    assert.match(record.mirror, /mirrornode\.hedera\.com/, 'the caller must be able to check it themselves');
});

test('casing in the query does not change the answer', { skip: !TOPIC && 'BATAS_HCS_TOPIC not set' }, async () => {
    const record = await lookupMandate(null, PUBLISHED.toUpperCase().replace('0X', '0x'));
    assert.equal(record.published, true);
    assert.equal(record.sequenceNumber, 1);
});

test('bytes that were never published are reported as such', { skip: !TOPIC && 'BATAS_HCS_TOPIC not set' }, async () => {
    const record = await lookupMandate(null, '0xdeadbeef');
    assert.equal(record.published, false);
    assert.match(record.reason, /not been published/);
});

test('a near miss is not a match', { skip: !TOPIC && 'BATAS_HCS_TOPIC not set' }, async () => {
    // One byte different: a mandate with a different salt, cap or floor is a different grant, and
    // a prefix or substring match would let one publication vouch for all of them.
    const nearby = PUBLISHED.slice(0, -1) + (PUBLISHED.endsWith('a') ? 'b' : 'a');
    assert.equal((await lookupMandate(null, nearby)).published, false);
    assert.equal((await lookupMandate(null, PUBLISHED.slice(0, 40))).published, false, 'a prefix is not the program');
});

test('no topic configured is stated, not silently treated as unpublished', async () => {
    // "false" and "we did not look" must not read the same to a caller deciding whether to trade.
    const saved = process.env.BATAS_HCS_TOPIC;
    delete process.env.BATAS_HCS_TOPIC;
    try {
        const record = await lookupMandate(null, PUBLISHED);
        assert.equal(record.published, false);
        assert.equal(record.reason, 'no topic configured');
        assert.equal(record.topic, null);
    } finally {
        if (saved !== undefined) process.env.BATAS_HCS_TOPIC = saved;
    }
});

test('a topic that does not exist is not reported as an unpublished mandate', async () => {
    // The mirror node answers 200 with an empty list for a topic id that has never existed, so
    // without the extra check these two arrive looking identical. They are not: one says nobody
    // vouched for these bytes, the other says the service asked a question of nothing at all —
    // a misconfiguration that would otherwise read as evidence against a perfectly good mandate.
    const missing = await lookupMandate('0.0.999999999', PUBLISHED);
    assert.equal(missing.published, false);
    assert.equal(missing.topicExists, false);
    assert.match(missing.reason, /does not exist/);
    assert.match(missing.reason, /nothing was actually checked/);
});

test('and a real topic that simply lacks these bytes says so instead', {
    skip: !TOPIC && 'BATAS_HCS_TOPIC not set',
}, async () => {
    const unpublished = await lookupMandate(null, '0xdeadbeef');
    assert.equal(unpublished.published, false);
    assert.equal(unpublished.topicExists, true, 'the configured topic is real');
    assert.match(unpublished.reason, /not been published/);
});

// --- the other half of the story ---------------------------------------------

test('a revocation record names the name, not the program', async () => {
    const { revocationMessage, parseRevocationMessage } = await import('./hcs.mjs');
    const msg = revocationMessage({
        label: 'agent',
        registry: '0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B',
        chainId: 11155111,
        at: 1789000000,
    });
    const back = parseRevocationMessage(Buffer.from(msg, 'utf8').toString('base64'));
    assert.equal(back.kind, 'batas.revocation');
    assert.equal(back.label, 'agent');
    // Lowercased, like every other address this project publishes, so a reader comparing two
    // records is not defeated by checksum casing.
    assert.equal(back.registry, '0x945800bd6cdd60521b64a12d7b3f12fc90916a6b');
});

test('the two kinds of record do not read as each other', async () => {
    const { revocationMessage, mandateMessage, parseRevocationMessage, parseMandateMessage } = await import('./hcs.mjs');
    const rev = Buffer.from(revocationMessage({ label: 'agent', registry: '0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B' }), 'utf8').toString('base64');
    const grant = Buffer.from(mandateMessage({ program: '0x2120' }), 'utf8').toString('base64');

    // A topic is public and writable by anyone holding its submit key, so foreign traffic is
    // expected. What must not happen is one of our own kinds being read as the other: a revocation
    // counted as a grant would say authority was given at the moment it was taken away.
    assert.equal(parseMandateMessage(rev), null);
    assert.equal(parseRevocationMessage(grant), null);
    assert.ok(parseRevocationMessage(rev));
    assert.ok(parseMandateMessage(grant));
});

test('a revocation refuses to be built without the two things that identify it', async () => {
    const { revocationMessage } = await import('./hcs.mjs');
    assert.throws(() => revocationMessage({ registry: '0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B' }), /label/);
    assert.throws(() => revocationMessage({ label: 'agent', registry: 'not-an-address' }), /registry/);
});

test('running out of pages is reported as not knowing, not as not published', async () => {
    const { lookupMandate } = await import('./hcs.mjs');
    // A mirror that always offers another page: the walk can never finish, which is exactly the
    // shape of a topic longer than maxPages.
    const endless = async (url) => ({
        ok: true,
        status: 200,
        json: async () => ({ messages: [], links: { next: '/topics/0.0.1/messages?page=next' } }),
    });
    const res = await lookupMandate('0.0.1', '0x2120', { fetchImpl: endless, maxPages: 3 });
    assert.equal(res.published, null, 'an unfinished walk must not answer false');
    assert.equal(res.searched, 'incomplete');
    assert.equal(res.pagesWalked, 3);
    assert.match(res.reason, /not a statement about whether these bytes were published/);
});

test('a finished walk that found nothing does say so', async () => {
    const { lookupMandate } = await import('./hcs.mjs');
    const empty = async (url) => (String(url).includes('/messages')
        ? { ok: true, status: 200, json: async () => ({ messages: [], links: {} }) }
        : { ok: true, status: 200, json: async () => ({}) });
    const res = await lookupMandate('0.0.1', '0x2120', { fetchImpl: empty, maxPages: 3 });
    assert.equal(res.published, false);
    assert.equal(res.searched, 'complete');
    assert.equal(res.topicExists, true);
});
