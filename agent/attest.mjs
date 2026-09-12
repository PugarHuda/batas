// A signature on the paid answer, so it can be carried somewhere else and still mean something.
//
// The service already tells a caller what a program permits and when it was published. What it
// could not do is let that caller show the answer to a third party: a JSON body forwarded in a
// message is a claim about what this service said, and nothing in it says the service said it.
// An EIP-712 signature over the body, from a key this service holds, closes that gap. Anyone
// holding the answer and the program can recover the signer without asking us — and if the body
// was edited on the way, the hash no longer matches and the recovery names nobody.
//
// The key is `BATAS_ATTEST_KEY`, and only that. When it is unset the answer simply has no
// `attestation` field; nothing else in the environment is a substitute, because a signature from
// the agent's trading key or the Hedera service key would be a different claim than "the
// inspection service said this".

import { keccak256, stringToHex, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { ROUTER } from './deployment.mjs';

export const DOMAIN = { name: 'Batas', version: '1', chainId: sepolia.id, verifyingContract: ROUTER };

/**
 * The signed struct.
 *
 * `programHash` rather than Aqua's `strategyHash`: the strategy hash is struck over the whole order
 * — maker, traits, tokens, program — and the paid answer is about the program alone. The service
 * never sees the maker or traits, so naming the field after a hash it cannot compute would invite a
 * verifier to compare it against the `Shipped` event and conclude the signature is wrong.
 */
export const TYPES = {
    MandateAttestation: [
        { name: 'programHash', type: 'bytes32' },
        { name: 'answerHash', type: 'bytes32' },
        { name: 'issuedAt', type: 'uint64' },
    ],
};
const PRIMARY = 'MandateAttestation';

/**
 * One byte sequence per value. `JSON.stringify` keeps insertion order, and the paid answer is
 * assembled in an order that depends on which optional reads ran; two equal answers must hash the
 * same, so keys are sorted at every level. Undefined values are dropped, as JSON does.
 */
export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** The hash a signature commits to: everything in the body except the attestation itself. */
export function answerHash(body) {
    const { attestation: _omitted, ...rest } = body;
    return keccak256(stringToHex(canonical(rest)));
}

export const programHash = (program) => keccak256(program);

/**
 * Sign an answer. Returns the field to attach, not the body — the caller decides where it goes,
 * and the hash is over the body as it stands when this is called.
 */
export async function attest(answer, { privateKey, program, chainId = DOMAIN.chainId, verifyingContract = DOMAIN.verifyingContract, now = Date.now() }) {
    const account = privateKeyToAccount(privateKey);
    const domain = { ...DOMAIN, chainId, verifyingContract };
    const message = {
        programHash: programHash(program),
        answerHash: answerHash(answer),
        issuedAt: Math.floor(now / 1000),
    };
    const signature = await account.signTypedData({ domain, types: TYPES, primaryType: PRIMARY, message });
    return { signer: account.address, domain, types: TYPES, message, signature };
}

/**
 * Who signed this body, and whether it is still the body they signed.
 *
 * The recovered address is a fact; whether it is the address a caller expected is their check to
 * make, against the service description or the ERC-8004 registration, not ours to assert.
 */
export async function verifyAttestation(body, { program } = {}) {
    const a = body?.attestation;
    if (!a?.signature || !a.message || !a.domain) return { valid: false, reason: 'no attestation on this body' };
    if (a.message.answerHash !== answerHash(body)) {
        return { valid: false, reason: 'the body is not the one that was signed' };
    }
    if (program !== undefined && a.message.programHash !== programHash(program)) {
        return { valid: false, reason: 'the attestation is about a different program' };
    }
    let signer;
    try {
        signer = await recoverTypedDataAddress({
            domain: a.domain, types: TYPES, primaryType: PRIMARY, message: a.message, signature: a.signature,
        });
    } catch (e) {
        return { valid: false, reason: `signature does not recover: ${e.shortMessage ?? e.message}` };
    }
    if (a.signer && signer.toLowerCase() !== a.signer.toLowerCase()) {
        return { valid: false, signer, reason: `signed by ${signer}, which is not the ${a.signer} it claims` };
    }
    return { valid: true, signer, issuedAt: a.message.issuedAt };
}
