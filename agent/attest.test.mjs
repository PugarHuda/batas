// The attestation, round trip and tampered. No network: a key generated here, a body written here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { privateKeyToAccount } from 'viem/accounts';

import { attest, verifyAttestation, canonical, answerHash, DOMAIN } from './attest.mjs';

const KEY = `0x${randomBytes(32).toString('hex')}`;
const PROGRAM = '0x2121000000000000000063';
const ANSWER = {
    guarded: true,
    mandate: { maxAmountIn: '7162902849964033514', minRateE18: '1941043832593008104', expiry: 1789420934 },
    publication: { published: true, sequenceNumber: 4 },
    notes: [],
};

test('canonical form does not depend on key order', () => {
    assert.equal(canonical({ b: 1, a: [{ y: null, x: 'z' }] }), canonical({ a: [{ x: 'z', y: null }], b: 1 }));
    assert.equal(canonical({ a: undefined, b: 2 }), '{"b":2}');
    assert.equal(canonical([undefined]), '[null]');
});

test('an attested answer verifies, and names the key that signed it', async () => {
    const attestation = await attest(ANSWER, { privateKey: KEY, program: PROGRAM });
    assert.equal(attestation.signer, privateKeyToAccount(KEY).address);
    assert.equal(attestation.domain.name, 'Batas');
    assert.equal(attestation.domain.chainId, 11155111);
    assert.equal(attestation.domain.verifyingContract, DOMAIN.verifyingContract);
    assert.equal(typeof attestation.message.issuedAt, 'number');

    const body = { ...ANSWER, attestation };
    // The hash excludes the field it lives in, or attaching it would invalidate it.
    assert.equal(attestation.message.answerHash, answerHash(body));

    const verdict = await verifyAttestation(body, { program: PROGRAM });
    assert.equal(verdict.valid, true, verdict.reason);
    assert.equal(verdict.signer, attestation.signer);

    // Reordered on the way — a proxy that re-serialised it — is still the same answer.
    const reordered = { attestation, notes: [], publication: ANSWER.publication, mandate: ANSWER.mandate, guarded: true };
    assert.equal((await verifyAttestation(reordered)).valid, true);
});

test('a body edited after signing does not verify', async () => {
    const attestation = await attest(ANSWER, { privateKey: KEY, program: PROGRAM });
    const edited = { ...ANSWER, mandate: { ...ANSWER.mandate, maxAmountIn: '999' }, attestation };
    const verdict = await verifyAttestation(edited);
    assert.equal(verdict.valid, false);
    assert.match(verdict.reason, /not the one that was signed/);
});

test('a signature moved onto another program, or forged for another signer, does not verify', async () => {
    const attestation = await attest(ANSWER, { privateKey: KEY, program: PROGRAM });
    const other = await verifyAttestation({ ...ANSWER, attestation }, { program: '0x00' });
    assert.equal(other.valid, false);
    assert.match(other.reason, /different program/);

    // Same body, same message, but the signature came from somebody else: the recovered address
    // is a real one and is not the one the field claims.
    const forged = await attest(ANSWER, { privateKey: `0x${randomBytes(32).toString('hex')}`, program: PROGRAM });
    const impostor = { ...ANSWER, attestation: { ...forged, signer: attestation.signer } };
    const verdict = await verifyAttestation(impostor);
    assert.equal(verdict.valid, false);
    assert.match(verdict.reason, /is not the .* it claims/);

    assert.equal((await verifyAttestation(ANSWER)).valid, false);
});

test('a signature made for another domain does not verify as this service\'s', async () => {
    // Same key, same struct, a different verifying contract: a real signature, about something else.
    const elsewhere = await attest(ANSWER, { privateKey: KEY, program: PROGRAM, verifyingContract: '0x0000000000000000000000000000000000000001' });
    const moved = await verifyAttestation({ ...ANSWER, attestation: elsewhere }, { program: PROGRAM });
    assert.equal(moved.valid, false);
    assert.match(moved.reason, /signed for the domain/);

    const otherChain = await attest(ANSWER, { privateKey: KEY, program: PROGRAM, chainId: 1 });
    assert.equal((await verifyAttestation({ ...ANSWER, attestation: otherChain })).valid, false);

    // A domain relabelled on the way to match ours no longer recovers to the key that signed it.
    const relabelled = { ...elsewhere, domain: { ...DOMAIN } };
    const verdict = await verifyAttestation({ ...ANSWER, attestation: relabelled });
    assert.equal(verdict.valid, false);
    assert.match(verdict.reason, /is not the .* it claims/);

    // A domain with a field ours does not have is a different domain, whatever the rest says.
    const own = await attest(ANSWER, { privateKey: KEY, program: PROGRAM });
    const salted = { ...own, domain: { ...own.domain, salt: `0x${'00'.repeat(32)}` } };
    assert.equal((await verifyAttestation({ ...ANSWER, attestation: salted })).valid, false);

    // The caller who names the domain it expects gets it checked against that one instead.
    const named = await verifyAttestation({ ...ANSWER, attestation: elsewhere }, { domain: elsewhere.domain });
    assert.equal(named.valid, true, named.reason);
});

test('a caller who knows the service key refuses a body signed by any other', async () => {
    const attestation = await attest(ANSWER, { privateKey: KEY, program: PROGRAM });
    const body = { ...ANSWER, attestation };
    assert.equal((await verifyAttestation(body, { signer: attestation.signer.toLowerCase() })).valid, true);

    // Without `signer` on the body at all, recovery alone names somebody; only the expectation
    // turns that into a refusal.
    const { signer: _dropped, ...unnamed } = await attest(ANSWER, { privateKey: `0x${randomBytes(32).toString('hex')}`, program: PROGRAM });
    const verdict = await verifyAttestation({ ...ANSWER, attestation: unnamed }, { signer: attestation.signer });
    assert.equal(verdict.valid, false);
    assert.match(verdict.reason, /not by/);
});
