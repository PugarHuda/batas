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
    classifyName, ZERO,
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

test('without the mandate deadline the report is still correct, only less specific', () => {
    const s = name({ expiry: NOW - 60, owner: ZERO });
    assert.equal(s.valid, false);
    assert.equal(s.revoked, false, 'nothing on chain distinguishes the two without the term');
    assert.match(s.reason, /expired at/);
});

test('a name held by somebody else does not authorise this agent', () => {
    const s = name({ owner: '0x0000000000000000000000000000000000000009' });
    assert.equal(s.valid, false);
    assert.match(s.reason, /is held by 0x0000000000000000000000000000000000000009/);
});
