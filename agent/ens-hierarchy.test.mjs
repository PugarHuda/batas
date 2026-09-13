// Tests for the mandate name's place in the ENS hierarchy.
//
// The encoders are pinned against the specifications' own examples, because a key that is one byte
// off is not an error anywhere: the record is written, the lookup is made, and the two never meet.
// Everything else is read from Sepolia. A resolution test against a stub would only show that the stub
// agrees with the code that was written to match it, and this project has shipped that mistake once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, keccak256, toHex } from 'viem';

import {
    erc7930, agentRegistrationKey, dnsEncode, desiredRecords, staleRecordCalls, killSwitchState, verifyAgentLink,
    publicClient, REGISTRY_ABI, AGENT_NAME, ALIAS_NAME, PARENT_NAME, DELEGATED_KEY, WITHHELD_KEY,
} from './ens-hierarchy.mjs';
import { resolveName, mandateNameStatus } from './ens.mjs';
import { ENS_REGISTRY, ENS_RESOLVER, ETH_REGISTRY, MANDATE_NAME, OWNER, ENS_PARENT_LABEL, ENS_NAME } from './deployment.mjs';

test('ERC-7930 matches ENSIP-25\'s own example, byte for byte', () => {
    assert.equal(erc7930(1, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'), '0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432');
});

test('a multi-byte chain id is written as its length and then its bytes', () => {
    // Sepolia is 11155111 = 0xaa36a7, three bytes. Writing it as one byte or padding it to eight
    // produces a well-formed key that names a different chain.
    assert.equal(erc7930(11155111, '0x8004A818BFB912233c491871b3d84c89A494BD9e'), '0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e');
});

test('the ENSIP-25 key names agent 10123 in the Sepolia identity registry', () => {
    assert.equal(agentRegistrationKey(10123), 'agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][10123]');
});

test('names are DNS-encoded the way ENSv2 contracts read them', () => {
    assert.equal(dnsEncode('agent.batas.eth'), '0x056167656e740562617461730365746800');
    assert.equal(AGENT_NAME, ENS_NAME);
    assert.equal(ALIAS_NAME, `mandate.${PARENT_NAME}`);
});

test('the published records advertise only this service\'s own routes', () => {
    const { text } = desiredRecords()[AGENT_NAME];
    for (const [key, value] of Object.entries(text)) {
        if (key.startsWith('agent-endpoint[')) assert.match(value, /^https:\/\/[^/]+(\/mcp|\/\.well-known\/x402)?$/, key);
    }
    assert.equal(text[agentRegistrationKey(10123)], '1', 'ENSIP-25 asks for "1"');
});

// --- Sepolia, read-only --------------------------------------------------------

test('batas.eth hangs the mandate registry, and the agent label answers through batas.eth\'s resolver', async () => {
    const pub = publicClient();
    const [subregistry, parentResolver, agentResolver] = await Promise.all([
        pub.readContract({ address: ETH_REGISTRY, abi: REGISTRY_ABI, functionName: 'getSubregistry', args: [ENS_PARENT_LABEL] }),
        pub.readContract({ address: ETH_REGISTRY, abi: REGISTRY_ABI, functionName: 'getResolver', args: [ENS_PARENT_LABEL] }),
        pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'getResolver', args: [MANDATE_NAME] }),
    ]);
    assert.equal(getAddress(subregistry), ENS_REGISTRY, 'the registry the settlement reads is the one ENS walks into');
    assert.equal(getAddress(parentResolver), ENS_RESOLVER);
    assert.equal(getAddress(agentResolver), ENS_RESOLVER);
});

test('joining the hierarchy left the kill switch alone', async () => {
    const pub = publicClient();
    const state = await killSwitchState(pub);
    const s = await mandateNameStatus(pub, ENS_REGISTRY, MANDATE_NAME, OWNER);
    assert.equal(state.status, 2, 'REGISTERED');
    assert.equal(s.owner ?? state.owner, OWNER);
    assert.equal(BigInt(state.tokenId) & ~0xffffffffn, BigInt(keccak256(toHex(MANDATE_NAME))) & ~0xffffffffn);
    if (s.valid) assert.deepEqual(s.holderRoles.roles, ['SET_SUBREGISTRY', 'SET_RESOLVER']);
});

test('agent.batas.eth resolves through the UniversalResolver to the records this repo publishes', async () => {
    const r = await resolveName(publicClient(), AGENT_NAME);
    const want = desiredRecords()[AGENT_NAME];
    assert.equal(r.resolver, ENS_RESOLVER);
    assert.equal(r.address, want.addr);
    for (const key of Object.keys(r.text)) assert.equal(r.text[key], want.text[key], key);
});

test('every record on chain already matches, so --records would send nothing', async () => {
    assert.deepEqual((await staleRecordCalls(publicClient())).map((c) => c.what), []);
});

test('an alias: mandate.batas.eth is registered nowhere and answers with agent.batas.eth\'s records', async () => {
    const pub = publicClient();
    const [alias, agent] = await Promise.all([resolveName(pub, ALIAS_NAME), resolveName(pub, AGENT_NAME)]);
    const status = await mandateNameStatus(pub, ENS_REGISTRY, 'mandate', OWNER);
    assert.equal(status.state, 'AVAILABLE', 'the alias is a resolver rewrite, not a second grant');
    assert.equal(alias.address, agent.address);
    assert.deepEqual(alias.text, agent.text);
});

test('a wildcard: an unregistered label under batas.eth resolves off the parent\'s resolver', async () => {
    const r = await resolveName(publicClient(), `never-registered-${Date.now()}.${PARENT_NAME}`);
    assert.equal(r.resolver, ENS_RESOLVER, 'the UniversalResolver fell back to the nearest ancestor with a resolver');
    assert.equal(r.address, null, 'and nothing was invented for it');
});

test('the registry refuses setParent, and says which role is missing', async () => {
    // Recorded rather than hidden: forward resolution works, the canonical back-link cannot be set on
    // this registry, and the reason is the registry's own answer.
    const pub = publicClient();
    await assert.rejects(
        pub.simulateContract({ account: OWNER, address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'setParent', args: [ETH_REGISTRY, ENS_PARENT_LABEL] }),
        /EACUnauthorizedAccountRoles/,
    );
});

test('ENSIP-25: agent.batas.eth and ERC-8004 agent 10123 name each other', async () => {
    const link = await verifyAgentLink(publicClient());
    assert.equal(link.ensRecord.value, '1');
    assert.equal(link.forward, true, 'the name carries the agent-registration record');
    assert.equal(link.reverse, true, `the registration lists the name; it lists ${JSON.stringify(link.registrationNames)}`);
    assert.equal(link.linked, true);
});

// --- Enhanced Access Control, on the live resolver -----------------------------
//
// The delegate is the counterparty account. It was granted ROLE_SET_TEXT on one key of one name, and
// wrote that key itself. What these pin is the boundary: the grant covers that key and nothing beside it.

const COUNTERPARTY = getAddress(process.env.BATAS_COUNTERPARTY_ADDRESS || '0x1437aF5722D5Dfe6BAEda25f3A7A39aeCA374614');
const TEXT_ABI = [
    { name: 'setText', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }, { type: 'string' }, { type: 'string' }], outputs: [] },
    { name: 'text', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'string' }], outputs: [{ type: 'string' }] },
    { type: 'error', name: 'EACUnauthorizedAccountRoles', inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }] },
];

test('the delegate wrote the one record it was granted', async () => {
    const { namehash } = await import('viem/ens');
    const value = await publicClient().readContract({ address: ENS_RESOLVER, abi: TEXT_ABI, functionName: 'text', args: [namehash(AGENT_NAME), DELEGATED_KEY] });
    assert.equal(getAddress(value), COUNTERPARTY);
});

test('the delegate may still write its key, and is refused every key beside it', async () => {
    const { namehash } = await import('viem/ens');
    const pub = publicClient();
    const call = (key) => ({ account: COUNTERPARTY, address: ENS_RESOLVER, abi: TEXT_ABI, functionName: 'setText', args: [namehash(AGENT_NAME), key, COUNTERPARTY] });
    await pub.simulateContract(call(DELEGATED_KEY));
    await assert.rejects(pub.simulateContract(call(WITHHELD_KEY)), /EACUnauthorizedAccountRoles/);
    await assert.rejects(pub.simulateContract(call('agent-endpoint[mcp]')), /EACUnauthorizedAccountRoles/, 'the endpoint records stay the maker\'s');
    // And the grant is scoped to the name as well as the key: the same key on batas.eth is refused.
    await assert.rejects(
        pub.simulateContract({ ...call(DELEGATED_KEY), args: [namehash(PARENT_NAME), DELEGATED_KEY, COUNTERPARTY] }),
        /EACUnauthorizedAccountRoles/,
    );
});

test('one direction is not a link: a name the registration does not claim fails verification', async () => {
    // mandate.batas.eth carries the forward record through its alias, and the registration does not
    // list it. That is exactly the case a one-sided check would pass.
    const link = await verifyAgentLink(publicClient(), { name: ALIAS_NAME });
    assert.equal(link.forward, true);
    assert.equal(link.reverse, false);
    assert.equal(link.linked, false);
});
