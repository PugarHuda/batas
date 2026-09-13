// Tests for the ENSv2 role arithmetic behind the mandate name.
//
// Role bitmaps are the whole safety argument here: withhold the wrong bit and the grant becomes
// transferable, or the holder can erase the record of it. Getting a shift wrong is silent — the
// registration succeeds and the name simply permits more than intended — so the values are pinned
// against the specification rather than trusted.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ROLE, admin, ROLE_CAN_TRANSFER_ADMIN, holderRoles, grantorRootRoles, isSoulbound, labelId,
    classifyName, mandateNameStatus, ZERO, STATUS, decodeRoles, resolveName,
} from './ens.mjs';

const NOW = 1_800_000_000;
const HOLDER = '0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E';
const name = (over) => classifyName({
    label: 'agent', registry: '0xReg', holder: HOLDER, now: NOW, owner: HOLDER,
    expiry: NOW + 3600, ...over,
});

test('role bits match the ENSv2 Permissioned Registry', () => {
    assert.equal(ROLE.REGISTRAR, 1n << 0n);
    assert.equal(ROLE.REGISTER_RESERVED, 1n << 4n);
    assert.equal(ROLE.SET_PARENT, 1n << 8n);
    assert.equal(ROLE.UNREGISTER, 1n << 12n);
    assert.equal(ROLE.RENEW, 1n << 16n);
    assert.equal(ROLE.SET_SUBREGISTRY, 1n << 20n);
    assert.equal(ROLE.SET_RESOLVER, 1n << 24n);
    assert.equal(ROLE.SET_URI, 1n << 36n);
});

test('an admin role is its regular role shifted by 128', () => {
    for (const r of Object.values(ROLE)) assert.equal(admin(r), r << 128n);
});

test('ROLE_CAN_TRANSFER_ADMIN sits where the spec puts it, with no regular variant', () => {
    assert.equal(ROLE_CAN_TRANSFER_ADMIN, (1n << 28n) << 128n);
    // 1 << 28 is not one of the regular roles; transfer control exists only in the admin half.
    assert.ok(!Object.values(ROLE).includes(1n << 28n));
});

test('the holder gets records and nothing else', () => {
    const roles = holderRoles();
    assert.equal(roles, 0x1100000n, 'SET_RESOLVER | SET_SUBREGISTRY, matching what the chain reports');

    // The four that would break the grant if they leaked to the holder.
    assert.equal(roles & ROLE_CAN_TRANSFER_ADMIN, 0n, 'a transferable mandate is not a mandate');
    assert.equal(roles & ROLE.UNREGISTER, 0n, 'the holder must not be able to erase the grant');
    assert.equal(roles & ROLE.RENEW, 0n, 'the holder must not be able to extend its own authority');
    assert.equal(roles & ROLE.REGISTRAR, 0n, 'the holder must not be able to mint further names');
});

test('the grant is soulbound', () => {
    assert.equal(isSoulbound(holderRoles()), true);
    assert.equal(isSoulbound(holderRoles() | ROLE_CAN_TRANSFER_ADMIN), false);
});

test('the grantor keeps revocation and renewal', () => {
    const root = grantorRootRoles();
    assert.notEqual(root & ROLE.UNREGISTER, 0n, 'revocation is the point of keeping root');
    assert.notEqual(root & ROLE.RENEW, 0n);
    assert.notEqual(root & ROLE.REGISTRAR, 0n);
    assert.notEqual(root & admin(ROLE.UNREGISTER), 0n, 'and the admin right to delegate it');
});

test('grantor and holder rights do not overlap where it matters', () => {
    const overlap = grantorRootRoles() & holderRoles();
    // SET_RESOLVER is deliberately shared: both may point records. Nothing else is.
    assert.equal(overlap, ROLE.SET_RESOLVER);
});

test('label ids clear the low 32 bits the registry uses as a version counter', async () => {
    const { keccak256, toHex } = await import('viem');
    const raw = BigInt(keccak256(toHex('agent')));

    assert.equal(labelId('agent'), raw & ~0xffffffffn);
    assert.equal(labelId('agent') & 0xffffffffn, 0n, 'version bits must be clear');
    assert.notEqual(labelId('agent'), raw, 'a plain labelhash is not a token id');

    // This is not a nicety. Passing the unmasked hash to ownerOf asks about a token that does not
    // exist, and the zero address that comes back reads as "revoked" rather than as a wrong
    // question — which is exactly how it was misdiagnosed the first time.
    assert.notEqual(
        raw & 0xffffffffn,
        0n,
        'this label has non-zero low bits, so the two forms genuinely differ',
    );
});

test('label ids are stable and distinct', () => {
    assert.equal(labelId('agent'), labelId('agent'));
    assert.notEqual(labelId('agent'), labelId('agent2'));
    assert.equal(typeof labelId('agent'), 'bigint');
});


// --- what the registry's answers mean ----------------------------------------
//
// These read like bookkeeping and are not. The revocation branch was unreachable in the first
// version — it hung off a try/catch waiting for `ownerOf` to revert, and this registry answers a
// burned name with the zero address instead — so the one control the owner has over a running
// agent was reported as the name having quietly run out.

test('a held, unexpired name authorises the agent', () => {
    const s = name();
    assert.equal(s.valid, true);
    assert.equal(s.revoked, false);
    assert.equal(s.secondsLeft, 3600);
});

test('a name that was never registered is not the same as one that ended', () => {
    const s = name({ expiry: 0 });
    assert.equal(s.valid, false);
    assert.equal(s.revoked, false);
    assert.match(s.reason, /no mandate name/);
});

test('a name left to run out is reported as expired', () => {
    // Its term ended where the mandate's did: nobody intervened.
    const s = name({ expiry: NOW - 60, grantedUntil: NOW - 60 });
    assert.equal(s.valid, false);
    assert.equal(s.revoked, false);
    assert.match(s.reason, /expired at/);
});

test('a name cut short of its term is reported as revoked', () => {
    // The grant ran to NOW + 7200; the registry says it ended a minute ago. Someone ended it.
    const s = name({ expiry: NOW - 60, owner: ZERO, grantedUntil: NOW + 7200 });
    assert.equal(s.valid, false);
    assert.equal(s.revoked, true);
    assert.match(s.reason, /was revoked at .* ahead of its term/);
});

test('a burned name whose term is still running is revoked, with no mandate needed to say so', () => {
    const s = name({ owner: ZERO, expiry: NOW + 3600 });
    assert.equal(s.revoked, true);
    assert.match(s.reason, /was revoked/);
});

test('the zero address is treated as burned rather than as a holder', () => {
    // The bug this pins: falling through to the ownership check would have reported the name as
    // "held by 0x0000…", which is true and useless.
    const s = name({ owner: ZERO, expiry: NOW + 3600 });
    assert.ok(!/is held by/.test(s.reason), s.reason);
});

test('a cleared owner is a revocation even with no deadline to compare against', () => {
    // The registry clears the owner on unregister and keeps it through a lapse, so the owner field
    // alone is enough — this is the same signal the chain's own MandateName check reads.
    const s = name({ expiry: NOW - 60, owner: ZERO });
    assert.equal(s.valid, false);
    assert.equal(s.revoked, true);
    assert.match(s.reason, /was revoked/);
});

test('a lapsed name whose owner is still remembered simply expired', () => {
    const s = name({ expiry: NOW - 60 });
    assert.equal(s.valid, false);
    assert.equal(s.revoked, false);
    assert.match(s.reason, /expired at/);
});

test('the deadline is a second opinion: a name that ended before its term was cut short', () => {
    const s = name({ expiry: NOW - 60, grantedUntil: NOW + 7200 });
    assert.equal(s.revoked, true, 'the owner is still set, but the term says someone ended it early');
});

test('a reserved name is held by nobody, and that is not a revocation', () => {
    // Reserved and burned look the same from the owner field: an expiry and the zero address.
    // Only the status separates "nobody was granted it" from "the grantor took it back".
    const s = name({ status: 1, owner: ZERO, expiry: NOW + 3600 });
    assert.equal(s.valid, false);
    assert.equal(s.revoked, false);
    assert.match(s.reason, /reserved/);
});

test('a status no registry produces is a failed read, not a verdict', () => {
    assert.throws(() => name({ status: 7, owner: ZERO }), /not an ENSv2 registry's answer/);
});

test('role bitmaps decode to names, and bits without a name are kept rather than dropped', () => {
    const d = decodeRoles(holderRoles());
    assert.deepEqual(d.roles, ['SET_SUBREGISTRY', 'SET_RESOLVER']);
    assert.deepEqual(d.admin, []);
    assert.equal(d.transferable, false);
    assert.equal(d.unknown, null);

    // Bit 1 is the second bit of REGISTRAR's nybble and bit 32 sits between SET_RESOLVER's
    // nybble and SET_URI's. Neither is a role; a decoder that ignored them would under-report.
    const odd = decodeRoles(ROLE.REGISTRAR | 2n | (1n << 32n) | ROLE_CAN_TRANSFER_ADMIN);
    assert.deepEqual(odd.roles, ['REGISTRAR']);
    assert.deepEqual(odd.admin, ['CAN_TRANSFER']);
    assert.equal(odd.transferable, true);
    assert.equal(BigInt(odd.unknown), 2n | (1n << 32n));
});

// --- the live registry on Sepolia, read-only ---------------------------------
//
// The first `mandateNameStatus` test answered `getState` from a stub written to match the interface,
// which is how this project once shipped a struct in the wrong field order with every test green.
// These ask the deployed registry every live mandate names.

const live = async () => {
    const { createPublicClient, http } = await import('viem');
    const { sepolia } = await import('viem/chains');
    const { SEPOLIA_RPC, ENS_REGISTRY, OWNER, MANDATE_NAME } = await import('./deployment.mjs');
    return { pub: createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) }), ENS_REGISTRY, OWNER, MANDATE_NAME, sepolia, createPublicClient, http };
};

test('the live mandate name reads whole: state, token version, holder roles, pinned to a block', async () => {
    const { pub, ENS_REGISTRY, OWNER, MANDATE_NAME } = await live();
    const s = await mandateNameStatus(pub, ENS_REGISTRY, MANDATE_NAME, OWNER);

    assert.ok(STATUS.includes(s.state), `state ${s.state}`);
    assert.doesNotThrow(() => JSON.stringify(s), 'the answer is served as JSON, so no bigint may leak into it');

    // The token id is the base id with the registry's re-registration counter in its low bits.
    const tokenId = BigInt(s.tokenId);
    assert.equal(tokenId & ~0xffffffffn, labelId(MANDATE_NAME));
    assert.equal(BigInt(s.version), tokenId & 0xffffffffn);

    // "Now" is the chain's, not this machine's.
    assert.ok(Math.abs(s.checkedAt.timestamp - Date.now() / 1000) < 600, 'the pinned block is recent');

    if (s.valid) {
        assert.equal(s.state, 'REGISTERED');
        assert.equal(s.secondsLeft, s.expiry - s.checkedAt.timestamp);
        assert.equal(s.owner, OWNER);
        assert.deepEqual(s.holderRoles.roles, ['SET_SUBREGISTRY', 'SET_RESOLVER'], 'what grant() gives, and nothing else');
        assert.equal(s.holderRoles.unknown, null);
        assert.equal(s.soulbound, true);
    }
});

test('a label nobody registered reads as absent on the live registry, not as revoked', async () => {
    const { pub, ENS_REGISTRY, OWNER } = await live();
    const s = await mandateNameStatus(pub, ENS_REGISTRY, 'batas-never-registered-xyz', OWNER);
    assert.equal(s.state, 'AVAILABLE');
    assert.equal(s.valid, false);
    assert.equal(s.revoked, false);
    assert.match(s.reason, /no mandate name/);
    assert.equal(s.holderRoles.roles.length, 0);
});

test('the grantor holds exactly the root roles deploy() gave it, on the live registry', async () => {
    const { pub, ENS_REGISTRY, OWNER } = await live();
    const bitmap = await pub.readContract({
        address: ENS_REGISTRY, functionName: 'roles', args: [0n, OWNER],
        abi: [{ name: 'roles', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }],
    });
    assert.equal(bitmap, grantorRootRoles());
    const d = decodeRoles(bitmap);
    assert.ok(d.roles.includes('UNREGISTER'), 'the kill switch is in the grantor\'s hands');
    assert.equal(d.unknown, null);
});

test('an RPC that cannot be reached is an error, never a verdict about the name', async () => {
    const { ENS_REGISTRY, OWNER, sepolia, createPublicClient, http } = await live();
    // A real connection to a port nothing listens on: the transport fails the way a dead RPC does.
    const dead = createPublicClient({ chain: sepolia, transport: http('http://127.0.0.1:1', { retryCount: 0 }) });
    await assert.rejects(mandateNameStatus(dead, ENS_REGISTRY, 'agent', OWNER));
});

test('an address with no registry behind it is an error, never "no mandate name"', async () => {
    // The owner is an account with no code. Reading getState from it returns no data, and that must
    // not decode into expiry 0 and be reported as a name that was never granted.
    const { pub, OWNER } = await live();
    await assert.rejects(mandateNameStatus(pub, OWNER, 'agent', OWNER), /returned no data/);
});

test('resolveName reads the live mandate name through the UniversalResolver', async () => {
    const { pub, OWNER } = await live();
    const { ENS_NAME, ENS_RESOLVER } = await import('./deployment.mjs');
    const r = await resolveName(pub, ENS_NAME);
    assert.equal(r.name, 'agent.batas.eth');
    assert.equal(r.resolver, ENS_RESOLVER);
    assert.equal(r.address, OWNER);
    assert.match(r.text['agent-endpoint[mcp]'], /^https:\/\/.+\/mcp$/);
    assert.doesNotThrow(() => JSON.stringify(r));
});

test('resolveName over a dead RPC is an error, never a name with no records', async () => {
    const { sepolia, createPublicClient, http } = await live();
    const dead = createPublicClient({ chain: sepolia, transport: http('http://127.0.0.1:1', { retryCount: 0 }) });
    await assert.rejects(resolveName(dead, 'agent.batas.eth'));
});

test('a name held by somebody else does not authorise this agent', () => {
    const s = name({ owner: '0x0000000000000000000000000000000000000009' });
    assert.equal(s.valid, false);
    assert.match(s.reason, /is held by 0x0000000000000000000000000000000000000009/);
});
