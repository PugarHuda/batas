// Tests for the x402 payment audit trail on HCS.
//
// A payment record is only worth something if a reader cannot be fooled by it. The topic has no
// submit key, so anyone can post a record that names our accounts, a transaction that never paid,
// or an amount larger than the one that moved. Each of those must come back as unverified and still
// be listed, because a trail that hides the forgery looks the same as a trail with no forgery.
//
// Every ledger check here goes to the real public testnet mirror node. The forged records are
// served as topic rows, since posting forgeries to the live topic would leave them there for good,
// but the transactions they cite are real and are read from the real ledger.

import test from 'node:test';
import assert from 'node:assert/strict';

import { paymentMessage, parsePaymentMessage, lookupPayments, MESSAGE_VERSION } from './hcs.mjs';

// The first recorded payment: 0.001 HBAR from the agent to the inspection service, settled through
// Blocky402 on 2026-09-13 and recorded by the agent itself at topic 0.0.10394165 #16.
const TOPIC = '0.0.10394165';
const TX = '0.0.7162784@1789303433.642299625';
const AGENT = '0.0.10388401';
const SERVICE = '0.0.10388560';
const SEQUENCE = 16;

const DIGEST = '0x' + 'ab'.repeat(32);
const RECORD = {
    transaction: TX, payer: AGENT, payTo: SERVICE, amount: '100000', asset: '0.0.0', network: 'hedera:testnet',
    resource: 'https://batas-one.vercel.app/v1/mandate/explain', requestHash: DIGEST, responseHash: DIGEST,
};
const encode = (obj) => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64');

test('a payment record round-trips, and anything off-format parses as null', () => {
    const text = paymentMessage({ ...RECORD, transaction: '0.0.7162784-1789303433-642299625' });
    const parsed = parsePaymentMessage(encode(text));
    assert.equal(parsed.kind, 'batas.payment');
    assert.equal(parsed.v, MESSAGE_VERSION);
    assert.equal(parsed.transaction, TX, 'the mirror form of the id is stored in the SDK form');

    assert.equal(parsePaymentMessage(encode({ ...JSON.parse(text), v: MESSAGE_VERSION + 1 })), null, 'a future version is refused');
    assert.equal(parsePaymentMessage(encode({ ...JSON.parse(text), kind: 'batas.mandate' })), null);
    assert.equal(parsePaymentMessage(encode({ ...JSON.parse(text), amount: '-5' })), null);
    assert.equal(parsePaymentMessage(encode({ ...JSON.parse(text), requestHash: 'nope' })), null);
    assert.equal(parsePaymentMessage(encode('not json')), null);

    assert.throws(() => paymentMessage({ ...RECORD, transaction: 'x' }), /Hedera transaction id/);
    assert.throws(() => paymentMessage({ ...RECORD, payTo: '0xabc' }), /payTo/);
    assert.throws(() => paymentMessage({ ...RECORD, amount: 0 }), /tinybars/);
    assert.throws(() => paymentMessage({ ...RECORD, responseHash: '0x12' }), /responseHash/);
});

test('the recorded payment is on the live topic and verifies against the ledger', async () => {
    const { payments } = await lookupPayments(TOPIC, { payer: AGENT });
    const p = payments.find((r) => r.sequenceNumber === SEQUENCE);
    assert.ok(p, `record #${SEQUENCE} is on topic ${TOPIC}`);
    assert.equal(p.verified, true, p.reason);
    assert.equal(p.transaction, TX);
    assert.equal(p.hcsPayer, AGENT, 'published by the account that paid');
    assert.equal(p.payTo, SERVICE);
    assert.equal(p.amount, '100000');
    assert.equal(p.result, 'SUCCESS');
    assert.ok(p.paid >= 100000 && p.received >= 100000);
    assert.match(p.requestHash, /^0x[0-9a-f]{64}$/);
    assert.match(p.responseHash, /^0x[0-9a-f]{64}$/);
});

// A topic feed carrying chosen rows. Only topic pages are served from here; every transaction
// lookup the verifier makes goes out to the real mirror node.
function topicWith(rows) {
    return async (url, init) => {
        if (!String(url).includes('/topics/')) return fetch(url, init);
        const messages = rows.map(([record, payer], i) => ({
            sequence_number: i + 1, consensus_timestamp: `1789303500.00000000${i}`, payer_account_id: payer,
            message: encode(record), chunk_info: { number: 1, total: 1 },
        }));
        return { ok: true, status: 200, json: async () => ({ messages, links: {} }) };
    };
}

test('forged, inflated and replayed records are listed as unverified, never dropped', async () => {
    const real = JSON.parse(paymentMessage(RECORD));
    const fetchImpl = topicWith([
        // A stranger files the real payment under the agent's name, and the agent files an inflated
        // copy, both ahead of the true record. Neither may demote the true record to a duplicate.
        [real, '0.0.999999'],
        [{ ...real, amount: '100001' }, AGENT],
        // A real, successful transaction that is not a payment from this payer to this payee.
        [{ ...real, payTo: '0.0.7162784' }, AGENT],
        [{ ...real, asset: '0.0.456858' }, AGENT],
        [real, AGENT],
        [real, AGENT],
    ]);
    const { payments } = await lookupPayments('0.0.1', { fetchImpl, attempts: 1 });
    assert.equal(payments.length, 6, 'every record is reported');
    const [stranger, inflated, wrongPayee, token, genuine, replay] = payments;

    assert.equal(stranger.verified, false);
    assert.match(stranger.reason, /paid by 0\.0\.999999, not by the payer it names/);
    assert.equal(genuine.verified, true, genuine.reason);
    assert.equal(inflated.verified, false, 'the ledger moved 100000, not 100001');
    assert.match(inflated.reason, /less than the 100001 recorded/);
    assert.equal(replay.verified, false);
    assert.match(replay.reason, /already recorded at #5/);
    assert.equal(wrongPayee.verified, false);
    assert.match(wrongPayee.reason, /no HBAR reached 0\.0\.7162784/);
    assert.equal(token.verified, false);
    assert.match(token.reason, /only HBAR/);
});

test('a transaction the ledger has never seen is "could not check", not verified', async () => {
    const fetchImpl = topicWith([[{ ...JSON.parse(paymentMessage(RECORD)), transaction: `${AGENT}@1000000000.000000001` }, AGENT]]);
    const [p] = (await lookupPayments('0.0.1', { fetchImpl, attempts: 1 })).payments;
    assert.equal(p.verified, null);
    assert.match(p.reason, /has not seen/);
});
