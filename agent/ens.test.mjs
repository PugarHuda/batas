// Tests for the ENSv2 role arithmetic behind the mandate name.
//
// Role bitmaps are the whole safety argument here: withhold the wrong bit and the grant becomes
// transferable, or the holder can erase the record of it. Getting a shift wrong is silent — the
// registration succeeds and the name simply permits more than intended — so the values are pinned
// against the specification rather than trusted.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ROLE, admin, ROLE_CAN_TRANSFER_ADMIN, holderRoles, grantorRootRoles, isSoulbound, labelId } from './ens.mjs';

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

test('label ids are stable and distinct', () => {
    assert.equal(labelId('agent'), labelId('agent'));
    assert.notEqual(labelId('agent'), labelId('agent2'));
    assert.equal(typeof labelId('agent'), 'bigint');
});
