// Agents as namespaces under batas.eth, each with its own identity and its own permissions.
//
//   node agent/namespaces.mjs --status     every agent namespace: holder, expiry, roles, records, ERC-8004 link (read-only)
//   node agent/namespaces.mjs --grant      maker key: grant counterparty.batas.eth to the counterparty and let it write its records
//   node agent/namespaces.mjs --identity   counterparty key: mint its own ERC-8004 identity and publish it on its own name
//
// Batas runs two agents. One is the maker's, which runs the position under agent.batas.eth. The other is
// agent/counterparty.mjs, which arrives at that position, decides whether to trust it, pays for an
// inspection when it has doubts, trades, and writes reputation. It always had its own key and its own
// money. Until now it had no name and no identity, so "each agent is a namespace" was true of exactly one.
//
// The two namespaces follow one model and differ only in who holds them. The grantor registers the label
// in the mandate registry with an expiry, gives the holder SET_RESOLVER and SET_SUBREGISTRY, and withholds
// ROLE_CAN_TRANSFER_ADMIN, which makes the name soulbound. UNREGISTER and RENEW stay with the grantor
// on the registry's root. On the resolver, the holder gets SET_TEXT scoped to its own name and nothing
// else. It writes its own ENSIP-26 context and ENSIP-25 link, and the same resolver refuses it on the
// maker's name.

import { createWalletClient, http, getAddress, keccak256, toHex, parseAbi, parseEventLogs, encodeFunctionData, zeroAddress, BaseError, ContractFunctionRevertedError } from 'viem';
import { namehash } from 'viem/ens';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import 'dotenv/config';

import {
    OWNER, AGENT_ID, MANDATE_NAME, ENS_REGISTRY, ENS_RESOLVER, IDENTITY_REGISTRY, SEPOLIA_RPC,
    COUNTERPARTY, COUNTERPARTY_LABEL, COUNTERPARTY_NAME, COUNTERPARTY_AGENT_ID,
} from './deployment.mjs';
import { holderRoles, mandateNameStatus, resolveName } from './ens.mjs';
import {
    REGISTRY_ABI, PARENT_NAME, AGENT_NAME, RESOLVER_ROLE, publicClient, dnsEncode, agentRegistrationKey, killSwitchState, verifyAgentLink,
} from './ens-hierarchy.mjs';
import { REGISTRATION_TYPE, checkRegistration } from './erc8004.mjs';

const DAY = 24n * 60n * 60n;
/** How long the counterparty's name lasts. It has no mandate deadline to match, so it gets a quarter. */
export const COUNTERPARTY_TERM = 90n * DAY;

/**
 * Every agent namespace under batas.eth.
 *
 * ponytail: a list rather than a scan of the registry's events. Only the grantor holds ROLE_REGISTRAR, so
 * no name appears under batas.eth unless the grantor registers it, and whoever does that updates this
 * list. If the registrar role is ever shared, replace the list with a scan of the registry's events.
 */
export const NAMESPACES = [
    { label: MANDATE_NAME, role: 'maker', holder: OWNER, agentId: AGENT_ID },
    { label: COUNTERPARTY_LABEL, role: 'counterparty', holder: COUNTERPARTY, agentId: COUNTERPARTY_AGENT_ID },
].map((n) => ({ ...n, name: `${n.label}.${PARENT_NAME}` }));

/** The ERC-8004 id a name under batas.eth stands for, or undefined when it is not an agent namespace. */
export const agentIdForName = (name) => NAMESPACES.find((n) => n.name === String(name).toLowerCase())?.agentId;

/** The records worth reading for an agent namespace: ENSIP-26's, and the ENSIP-25 key for its own id. */
export const recordKeys = (agentId) => [
    'agent-context', 'agent-endpoint[web]', 'agent-endpoint[mcp]', 'agent-endpoint[x402]', 'url',
    ...(agentId ? [agentRegistrationKey(agentId)] : []),
];

const REGISTRY_WRITE_ABI = parseAbi([
    'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
    'function setResolver(uint256 anyId, address resolver)',
    'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
]);
const RESOLVER_ABI = parseAbi([
    'function multicall(bytes[] calls) returns (bytes[])',
    'function authorizeNameRoles(bytes name, uint256 roleBitmap, address account, bool grant) returns (bool)',
    'function setAddr(bytes32 node, address a)',
    'function setText(bytes32 node, string key, string value)',
    'function addr(bytes32 node) view returns (address)',
    'function text(bytes32 node, string key) view returns (string)',
    'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
    'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
]);
const IDENTITY_ABI = parseAbi([
    'function register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) returns (uint256)',
    'function setAgentURI(uint256 agentId, string newURI)',
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

function signer(envKey, expected) {
    if (!process.env[envKey]) throw new Error(`${envKey} missing; copy .env.example to .env`);
    const account = privateKeyToAccount(process.env[envKey]);
    if (account.address !== expected) throw new Error(`${envKey} is ${account.address}, not ${expected}`);
    return { account, wallet: createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) }) };
}

/**
 * Simulate, send, and wait for the receipt before returning.
 *
 * The same discipline as ens-hierarchy.mjs, repeated here because that helper is not exported. Each key
 * sends one transaction at a time: the maker's key also runs the live position, and two transactions in
 * flight from one account race for the nonce.
 */
async function send(pub, account, wallet, call, label) {
    const { request, result } = await pub.simulateContract({ account, ...call });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${label} reverted in ${hash}`);
    console.log(`${label.padEnd(30)} https://sepolia.etherscan.io/tx/${hash}`);
    return { hash, result, receipt };
}

const revertName = (e) => {
    const inner = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    return inner?.data ? `${inner.data.errorName}(${inner.data.args.map(String).join(', ')})` : String(e.shortMessage || e.message);
};

/**
 * The maker's namespace as the settlement and the grant see it.
 *
 * A before-and-after comparison of this is how --grant shows that adding a second agent did not move the
 * first one's kill switch, roles or resolver.
 */
export async function makerSnapshot(pub) {
    const [state, status, resolver] = await Promise.all([
        killSwitchState(pub),
        mandateNameStatus(pub, ENS_REGISTRY, MANDATE_NAME, OWNER),
        pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'getResolver', args: [MANDATE_NAME] }),
    ]);
    return { ...state, roles: status.holderRoles.bitmap, resolver: getAddress(resolver) };
}

/**
 * Can `account` write `key` on `name`? The resolver answers in a simulation, so asking costs nothing.
 *
 * A write that would revert is reported by the resolver's error name. That error is the evidence that
 * the permission is scoped, so it is returned rather than swallowed.
 */
export async function canSetText(pub, account, name, key) {
    try {
        await pub.simulateContract({
            account, address: ENS_RESOLVER, abi: RESOLVER_ABI, functionName: 'setText', args: [namehash(name), key, 'batas.namespaces probe'],
        });
        return { name, key, allowed: true };
    } catch (e) {
        // Only the contract refusing counts. An endpoint that failed to answer is not evidence of a
        // scoped permission, and reporting it as one would make the proof pass on a network error.
        const reverted = e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError);
        if (!reverted) throw e;
        return { name, key, allowed: false, refusal: revertName(e) };
    }
}

/** The maker's records the counterparty must not be able to write. */
export const makerRecordsHeldBack = () => ['agent-context', agentRegistrationKey(AGENT_ID)];

/**
 * The registration file for the counterparty's own ERC-8004 identity.
 *
 * It describes what agent/counterparty.mjs does and nothing it does not. The counterparty serves no
 * endpoint, so it lists none. It lists its source, and the ENS name that carries the other half of the
 * ENSIP-25 link. identity.mjs builds the maker's file and does not export its builder, so the shape is
 * written again here and checked with erc8004.mjs's `checkRegistration` before anything is sent.
 */
export function counterpartyRegistration(operator, agentId) {
    return {
        type: REGISTRATION_TYPE,
        name: 'Batas counterparty',
        description:
            'The taker side of Batas, an agent with its own key and its own rules. It finds the maker agent '
            + `(ERC-8004 #${AGENT_ID}, ${AGENT_NAME}) through this registry. It reads the position's SwapVM mandate `
            + 'for free, and pays for an x402 inspection on Hedera testnet only when that evidence leaves doubt. '
            + 'It declines terms that could be widened or that nobody can revoke, trades on 1inch Aqua, and writes '
            + 'ERC-8004 reputation about the maker from the fill it received.',
        active: true,
        services: [
            { name: 'ENS', endpoint: COUNTERPARTY_NAME, version: 'v1' },
            { name: 'source', endpoint: 'https://github.com/PugarHuda/batas/blob/master/agent/counterparty.mjs', version: '1' },
        ],
        operator,
        registrations: [{ agentId: Number(agentId), agentRegistry: `eip155:${sepolia.id}:${IDENTITY_REGISTRY}` }],
    };
}

/** The counterparty's ENSIP-26 context and ENSIP-25 link, as its own name should carry them. */
export function counterpartyRecords(agentId) {
    return {
        'agent-context': [
            'Batas counterparty: the taker that decides whether to trust a Batas position, pays for an x402 inspection when in doubt, trades on 1inch Aqua, and rates the maker in ERC-8004.',
            `Its own agent, ERC-8004 #${agentId} in eip155:${sepolia.id}:${IDENTITY_REGISTRY}, trading from ${COUNTERPARTY}.`,
            `This name was granted by ${PARENT_NAME}'s grantor: soulbound, expiring, revocable. It writes its own records here and cannot write ${AGENT_NAME}'s.`,
        ].join('\n'),
        [agentRegistrationKey(agentId)]: '1',
    };
}

const toDataUri = (obj) => `data:application/json;base64,${Buffer.from(JSON.stringify(obj)).toString('base64')}`;

/**
 * Maker key. Register counterparty.batas.eth to the counterparty and hand it its own text records.
 *
 * Every step reads first and writes only what is missing, so running it twice sends nothing the second
 * time. The maker's namespace is read before and after, and any difference is an error.
 */
async function grant() {
    const pub = publicClient();
    const { account, wallet } = signer('SEPOLIA_PRIVATE_KEY', OWNER);
    const before = await makerSnapshot(pub);
    console.log(`${MANDATE_NAME} before  ${JSON.stringify(before)}`);

    const id = BigInt(keccak256(toHex(COUNTERPARTY_LABEL)));
    const [status, , latestOwner] = await pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'getState', args: [id] });
    if (Number(status) !== 2) {
        // The resolver is set in the same call rather than by a setResolver afterwards. That leaves no
        // block in which the name exists and resolves through the wrong contract.
        const { timestamp } = await pub.getBlock();
        await send(pub, account, wallet, {
            address: ENS_REGISTRY, abi: REGISTRY_WRITE_ABI, functionName: 'register',
            args: [COUNTERPARTY_LABEL, COUNTERPARTY, zeroAddress, ENS_RESOLVER, holderRoles(), timestamp + COUNTERPARTY_TERM],
        }, `register ${COUNTERPARTY_LABEL}`);
    } else if (getAddress(latestOwner) !== COUNTERPARTY) {
        throw new Error(`${COUNTERPARTY_NAME} is held by ${latestOwner}, not the counterparty ${COUNTERPARTY}`);
    } else {
        console.log(`${COUNTERPARTY_NAME} already granted to ${COUNTERPARTY}`);
    }

    const resolver = await pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'getResolver', args: [COUNTERPARTY_LABEL] });
    if (getAddress(resolver) !== ENS_RESOLVER) {
        const tokenId = await pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'findTokenId', args: [COUNTERPARTY_LABEL] });
        await send(pub, account, wallet, {
            address: ENS_REGISTRY, abi: REGISTRY_WRITE_ABI, functionName: 'setResolver', args: [tokenId, ENS_RESOLVER],
        }, `resolver of ${COUNTERPARTY_LABEL}`);
    }

    // SET_TEXT on the name as a resource, which covers every key under counterparty.batas.eth and nothing
    // under any other name. The address record is the grantor's statement of who holds the name, so the
    // grantor writes it, in the same multicall.
    const node = namehash(COUNTERPARTY_NAME);
    const [probe, addr] = await Promise.all([
        canSetText(pub, COUNTERPARTY, COUNTERPARTY_NAME, 'agent-context'),
        pub.readContract({ address: ENS_RESOLVER, abi: RESOLVER_ABI, functionName: 'addr', args: [node] }),
    ]);
    const calls = [];
    if (!probe.allowed) calls.push(encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'authorizeNameRoles', args: [dnsEncode(COUNTERPARTY_NAME), RESOLVER_ROLE.SET_TEXT, COUNTERPARTY, true] }));
    if (getAddress(addr) !== COUNTERPARTY) calls.push(encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setAddr', args: [node, COUNTERPARTY] }));
    if (calls.length) {
        await send(pub, account, wallet, { address: ENS_RESOLVER, abi: RESOLVER_ABI, functionName: 'multicall', args: [calls] }, `text roles + addr (${calls.length})`);
    } else {
        console.log('resolver grant and address already in place');
    }

    const after = await makerSnapshot(pub);
    console.log(`${MANDATE_NAME} after   ${JSON.stringify(after)}`);
    for (const k of Object.keys(before)) {
        if (String(before[k]) !== String(after[k])) throw new Error(`the maker's namespace moved: ${k} ${before[k]} -> ${after[k]}`);
    }
}

/**
 * Counterparty key. Its own ERC-8004 identity, then its own records on its own name.
 *
 * It refuses to mint a second identity. Once COUNTERPARTY_AGENT_ID is known it only brings the records
 * up to date. It also refuses when the key already holds an identity that nobody configured, because
 * minting again would leave two identities describing one agent.
 */
async function identity() {
    const pub = publicClient();
    const { account, wallet } = signer('BATAS_COUNTERPARTY_KEY', COUNTERPARTY);
    let agentId = COUNTERPARTY_AGENT_ID;

    if (!agentId) {
        const held = await pub.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: 'balanceOf', args: [COUNTERPARTY] });
        if (held > 0n) throw new Error(`${COUNTERPARTY} already holds ${held} ERC-8004 identity; set BATAS_COUNTERPARTY_AGENT_ID instead of minting again`);

        // The file names its own id, which is only known once minted. The simulation predicts it. If
        // someone else mints in between, the receipt says so and the URI is corrected in place.
        const { result: predicted } = await pub.simulateContract({
            account, address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: 'register', args: [toDataUri(counterpartyRegistration(COUNTERPARTY, 0)), []],
        });
        const file = counterpartyRegistration(COUNTERPARTY, predicted);
        const check = checkRegistration(file, predicted);
        if (!check.valid || !check.bound) throw new Error(`registration file does not pass checkRegistration: ${check.issues.join('; ')}`);
        console.log(`would mint agent #${predicted}  uri ${toDataUri(file).length} chars`);

        const { receipt } = await send(pub, account, wallet, {
            address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: 'register', args: [toDataUri(file), []],
        }, 'ERC-8004 register');
        const minted = parseEventLogs({ abi: IDENTITY_ABI, eventName: 'Transfer', logs: receipt.logs })
            .find((l) => getAddress(l.address) === IDENTITY_REGISTRY && l.args.from === zeroAddress && getAddress(l.args.to) === COUNTERPARTY);
        agentId = minted.args.tokenId;
        if (agentId !== predicted) {
            await send(pub, account, wallet, {
                address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: 'setAgentURI', args: [agentId, toDataUri(counterpartyRegistration(COUNTERPARTY, agentId))],
            }, `ERC-8004 uri for #${agentId}`);
        }
        console.log(`\nminted agent #${agentId}. Append it to deployment.mjs as COUNTERPARTY_AGENT_ID.`);
    }

    // Only the records that differ, in one multicall, from the counterparty's own key.
    const node = namehash(COUNTERPARTY_NAME);
    const stale = [];
    for (const [key, value] of Object.entries(counterpartyRecords(agentId))) {
        const onChain = await pub.readContract({ address: ENS_RESOLVER, abi: RESOLVER_ABI, functionName: 'text', args: [node, key] });
        if (onChain !== value) stale.push(encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setText', args: [node, key, value] }));
    }
    if (stale.length) {
        await send(pub, account, wallet, { address: ENS_RESOLVER, abi: RESOLVER_ABI, functionName: 'multicall', args: [stale] }, `own records (${stale.length})`);
    } else {
        console.log(`${COUNTERPARTY_NAME} records already current`);
    }

    // The limit, proven against the deployed resolver. It is simulated rather than sent, because a
    // transaction that reverts proves nothing a simulation does not, and it would cost gas.
    for (const key of makerRecordsHeldBack()) {
        const r = await canSetText(pub, account, AGENT_NAME, key);
        if (r.allowed) throw new Error(`the counterparty could write ${AGENT_NAME} ${key}; its grant is wider than its own name`);
        console.log(`refused on ${AGENT_NAME} ${key}  ${r.refusal}`);
    }
}

/** One namespace, everything a stranger would check about it, read from Sepolia. */
export async function namespaceStatus(pub, ns) {
    const id = BigInt(keccak256(toHex(ns.label)));
    const [[state, , latestOwner], resolver] = await Promise.all([
        pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'getState', args: [id] }),
        pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'getResolver', args: [ns.label] }),
    ]);
    const holder = getAddress(latestOwner);
    const [status, records, link] = await Promise.all([
        mandateNameStatus(pub, ENS_REGISTRY, ns.label, holder),
        resolveName(pub, ns.name, recordKeys(ns.agentId)),
        ns.agentId ? verifyAgentLink(pub, { name: ns.name, agentId: ns.agentId }) : null,
    ]);
    return {
        name: ns.name,
        role: ns.role,
        state: Number(state),
        holder,
        expectedHolder: ns.holder,
        valid: status.valid,
        expiry: status.expiry ? new Date(status.expiry * 1000).toISOString() : null,
        soulbound: status.soulbound,
        roles: status.holderRoles.roles,
        resolver: getAddress(resolver),
        address: records.address,
        records: Object.fromEntries(Object.entries(records.text).filter(([, v]) => v !== null)),
        erc8004: { agentId: ns.agentId ?? null, linked: link?.linked ?? false, forward: link?.forward ?? false, reverse: link?.reverse ?? false },
    };
}

async function status() {
    const pub = publicClient();
    for (const ns of NAMESPACES) {
        const s = await namespaceStatus(pub, ns);
        console.log(`\n${s.name}  (${s.role})`);
        console.log(`  holder     ${s.holder}${s.holder === s.expectedHolder ? '' : `  expected ${s.expectedHolder}`}`);
        console.log(`  state      ${s.valid ? 'held and unexpired' : 'not valid'}  expires ${s.expiry}`);
        console.log(`  soulbound  ${s.soulbound}  roles ${s.roles.join(' | ') || 'none'}`);
        console.log(`  resolver   ${s.resolver}  addr ${s.address}`);
        for (const [key, value] of Object.entries(s.records)) console.log(`  ${key}\n    ${value.replaceAll('\n', '\n    ')}`);
        console.log(`  ERC-8004   #${s.erc8004.agentId}  linked ${s.erc8004.linked}  (forward ${s.erc8004.forward}, reverse ${s.erc8004.reverse})`);
    }
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--grant')) return grant();
    if (argv.includes('--identity')) return identity();
    if (argv.includes('--status')) return status();
    console.log('usage: --status | --grant | --identity');
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage || e.message || e));
        process.exit(1);
    });
}
