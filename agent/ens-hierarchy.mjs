// The mandate name, inside the ENS hierarchy rather than beside it.
//
//   node agent/ens-hierarchy.mjs --status    how agent.batas.eth resolves right now (read-only)
//   node agent/ens-hierarchy.mjs --setup     register batas.eth, deploy its resolver, hang the mandate registry under it
//   node agent/ens-hierarchy.mjs --records   write whatever records differ from the ones below, and the alias
//   node agent/ens-hierarchy.mjs --delegate  grant one text record to a second account and prove the limit on chain
//
// The mandate registry at ENS_REGISTRY was deployed on its own, holding the label "agent" that the live
// SwapVM program's MandateName instruction reads on every settlement. A registry nobody can reach from
// the root is a kill switch with no name: ENS clients could not find it, and nothing about it said who
// it belonged to. This file puts it under batas.eth, so `agent.batas.eth` resolves through ENS's own
// UniversalResolver like any other name, and the records a stranger's agent needs sit where it looks.
//
// What this file never does is touch the "agent" label's token, roles or expiry. Those are the kill
// switch. The only write to the mandate registry is pointing the label's resolver at batas.eth's
// resolver, and `--setup` reads getState before and after to show the switch did not move.

import {
    createPublicClient, createWalletClient, http, getAddress, encodeFunctionData, encodeAbiParameters,
    keccak256, toHex, stringToHex, parseAbi, erc20Abi, BaseError, ContractFunctionRevertedError,
} from 'viem';
import { namehash, normalize, packetToBytes } from 'viem/ens';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import 'dotenv/config';

import {
    OWNER, ENS_REGISTRY, MANDATE_NAME, IDENTITY_REGISTRY, AGENT_ID, SEPOLIA_RPC,
    ENS_PARENT_LABEL, ENS_RESOLVER, ETH_REGISTRY, ETH_REGISTRAR,
} from './deployment.mjs';

// ENSv2 beta on Sepolia, from docs.ens.domains/learn/deployments and checked for code before use.
const VERIFIABLE_FACTORY = getAddress('0x10Dc6333cDfe1FCEF624c6E0A8221b91804cD7ef');
const PERMISSIONED_RESOLVER_IMPL = getAddress('0x9EAE5c2730a7dd16bDD1dEE6421A1b91e3b0365e');
// The registrar charges in a mock stablecoin on the beta. Its mint is public, which is the beta's
// faucet rather than a shortcut of ours: the registrar still takes the payment through transferFrom.
const MOCK_USDC = getAddress('0x768f42455a2d082e23ceef7d51e5787c82d67a39');

const SERVICE_ORIGIN = process.env.BATAS_PUBLIC_ORIGIN || 'https://batas-one.vercel.app';
const YEAR = 365n * 24n * 60n * 60n;

export const PARENT_NAME = `${ENS_PARENT_LABEL}.eth`;
export const AGENT_NAME = `${MANDATE_NAME}.${PARENT_NAME}`;
// Not registered anywhere. It resolves only because batas.eth's resolver answers for every name
// under it that has no resolver of its own, and it answers with agent's records because of an alias.
export const ALIAS_NAME = `mandate.${PARENT_NAME}`;

// PermissionedResolverLib, from the verified source of the implementation above.
export const RESOLVER_ROLE = {
    SET_ADDR: 1n << 0n,
    SET_TEXT: 1n << 4n,
    SET_CONTENTHASH: 1n << 8n,
    SET_PUBKEY: 1n << 12n,
    SET_ABI: 1n << 16n,
    SET_INTERFACE: 1n << 20n,
    SET_NAME: 1n << 24n,
    SET_ALIAS: 1n << 28n,
    CLEAR: 1n << 32n,
    SET_DATA: 1n << 36n,
    UPGRADE: 1n << 124n,
};
const everyRole = Object.values(RESOLVER_ROLE).reduce((all, bit) => all | bit | (bit << 128n), 0n);

/** A name as the DNS wire format ENSv2 contracts take. */
export const dnsEncode = (name) => toHex(packetToBytes(name));

/**
 * An ERC-7930 interoperable address for an EVM account.
 *
 * Version 1, chain type 0x0000 (eip155), the chain id as its shortest big-endian bytes, then the
 * 20-byte address. ENSIP-25 builds its record key from this rather than from CAIP-10 text, so a
 * one-byte slip here produces a key no verifier will ever look up — which is why it is pinned against
 * the specification's own mainnet example in the tests.
 */
export function erc7930(chainId, address) {
    let ref = BigInt(chainId).toString(16);
    if (ref.length % 2) ref = `0${ref}`;
    const refLen = (ref.length / 2).toString(16).padStart(2, '0');
    return `0x00010000${refLen}${ref}14${getAddress(address).slice(2).toLowerCase()}`;
}

/** ENSIP-25's key for "this name is agent `agentId` in `registry`". */
export const agentRegistrationKey = (agentId, { chainId = sepolia.id, registry = IDENTITY_REGISTRY } = {}) =>
    `agent-registration[${erc7930(chainId, registry)}][${agentId}]`;

/**
 * Every record this project publishes, as the resolver should hold it.
 *
 * Only endpoints this repository actually serves are listed, for the same reason the ERC-8004
 * registration lists nothing else: a name that points at dead links is worse than a name with none.
 */
export function desiredRecords({ holder = OWNER, agentId = AGENT_ID } = {}) {
    return {
        [AGENT_NAME]: {
            addr: getAddress(holder),
            text: {
                // ENSIP-26.
                'agent-context': [
                    'Batas: an autonomous market maker on 1inch Aqua bound by a mandate the settlement enforces.',
                    `This name is the kill switch: the SwapVM program reads "${MANDATE_NAME}" in ${ENS_REGISTRY} on every settlement and refuses to trade once it is revoked or expired.`,
                    `ERC-8004 agent #${agentId} in eip155:${sepolia.id}:${IDENTITY_REGISTRY}.`,
                    `Paid x402 answers are described at ${SERVICE_ORIGIN}/.well-known/x402; tools at ${SERVICE_ORIGIN}/mcp.`,
                ].join('\n'),
                'agent-endpoint[web]': SERVICE_ORIGIN,
                'agent-endpoint[mcp]': `${SERVICE_ORIGIN}/mcp`,
                'agent-endpoint[x402]': `${SERVICE_ORIGIN}/.well-known/x402`,
                // ENSIP-25: the ENS half of the two-way link. The registration file carries the other half.
                [agentRegistrationKey(agentId)]: '1',
                url: SERVICE_ORIGIN,
            },
        },
        [PARENT_NAME]: {
            addr: getAddress(holder),
            text: {
                url: SERVICE_ORIGIN,
                description: `Batas mandates. ${AGENT_NAME} is the live agent's kill switch.`,
            },
        },
    };
}

const RESOLVER_ABI = parseAbi([
    'function initialize(address admin, uint256 roleBitmap, bytes[] setters)',
    'function multicall(bytes[] calls) returns (bytes[])',
    'function setAddr(bytes32 node, address a)',
    'function setText(bytes32 node, string key, string value)',
    'function setAlias(bytes fromName, bytes toName)',
    'function authorizeTextRoles(bytes toName, string key, address account, bool grant) returns (bool)',
    'function addr(bytes32 node) view returns (address)',
    'function text(bytes32 node, string key) view returns (string)',
    'function getAlias(bytes fromName) view returns (bytes)',
    'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
    'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
]);
const FACTORY_ABI = parseAbi(['function deployProxy(address implementation, uint256 salt, bytes data) returns (address)']);
const REGISTRAR_ABI = parseAbi([
    'function isAvailable(string label) view returns (bool)',
    'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
    'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)',
    'function commitmentAt(bytes32) view returns (uint64)',
    'function MIN_COMMITMENT_AGE() view returns (uint64)',
    'function commit(bytes32 commitment)',
    'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
]);
export const REGISTRY_ABI = parseAbi([
    'function getSubregistry(string label) view returns (address)',
    'function getResolver(string label) view returns (address)',
    'function getParent() view returns (address, string)',
    'function findTokenId(string label) view returns (uint256)',
    'function getState(uint256 id) view returns (uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource)',
    'function setResolver(uint256 anyId, address resolver)',
    'function setParent(address parent, string label)',
    'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
]);

export const publicClient = () => createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

function signer(envKey = 'SEPOLIA_PRIVATE_KEY') {
    if (!process.env[envKey]) throw new Error(`${envKey} missing; copy .env.example to .env`);
    const account = privateKeyToAccount(process.env[envKey]);
    return { account, wallet: createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) }) };
}

async function requireCode(pub, entries) {
    for (const [name, address] of entries) {
        const code = await pub.getCode({ address });
        if (!code || code === '0x') throw new Error(`${name} has no code at ${address}; the ENSv2 beta may have moved`);
    }
}

/**
 * Simulate, send, and wait for the receipt before returning.
 *
 * One transaction at a time from the maker key, always: the maker also runs the live position, and
 * two in flight from one account race each other for the nonce.
 */
async function send(pub, account, wallet, call, label) {
    const { request, result } = await pub.simulateContract({ account, ...call });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${label} reverted in ${hash}`);
    console.log(`${label.padEnd(28)} ${hash}  block ${receipt.blockNumber}`);
    return { hash, result, receipt };
}

const revertName = (e) => {
    const inner = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    return inner?.data ? `${inner.data.errorName}(${inner.data.args.map(String).join(', ')})` : String(e.shortMessage || e.message);
};

/** The kill switch as the settlement sees it, so a before-and-after comparison is exact. */
export async function killSwitchState(pub, blockNumber) {
    const id = BigInt(keccak256(toHex(MANDATE_NAME)));
    const [status, expiry, owner, tokenId] = await pub.readContract({
        address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'getState', args: [id], blockNumber,
    });
    return { status: Number(status), expiry: Number(expiry), owner, tokenId: tokenId.toString() };
}

async function setup() {
    const pub = publicClient();
    const { account, wallet } = signer();
    if (account.address !== OWNER) throw new Error(`the key is ${account.address}, not the grantor ${OWNER}`);
    await requireCode(pub, [
        ['ETHRegistrar', ETH_REGISTRAR], ['ETHRegistry', ETH_REGISTRY], ['VerifiableFactory', VERIFIABLE_FACTORY],
        ['PermissionedResolver implementation', PERMISSIONED_RESOLVER_IMPL], ['MockUSDC', MOCK_USDC], ['mandate registry', ENS_REGISTRY],
    ]);

    const before = await killSwitchState(pub);
    console.log(`kill switch before  ${JSON.stringify(before)}`);

    // 1. The resolver: a PermissionedResolver proxy, through the factory ENS documents, with the
    //    salt it documents, so its provenance is checkable from the factory's own event.
    let resolver = ENS_RESOLVER;
    if (!resolver || (await pub.getCode({ address: resolver })) === undefined) {
        const salt = BigInt(keccak256(encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
            [keccak256(stringToHex('OwnedResolver')), account.address, 0n],
        )));
        const init = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'initialize', args: [account.address, everyRole, []] });
        ({ result: resolver } = await send(pub, account, wallet, {
            address: VERIFIABLE_FACTORY, abi: FACTORY_ABI, functionName: 'deployProxy', args: [PERMISSIONED_RESOLVER_IMPL, salt, init],
        }, 'deploy resolver'));
        console.log(`resolver            ${resolver}   add to deployment.mjs as ENS_RESOLVER`);
    }

    // 2. The second-level name, by commit and reveal, with the mandate registry as its subregistry
    //    from the moment it exists. Registering with the subregistry in place, rather than setting it
    //    afterwards, leaves no block in which batas.eth exists without the name it was bought for.
    const subregistry = await pub.readContract({ address: ETH_REGISTRY, abi: REGISTRY_ABI, functionName: 'getSubregistry', args: [ENS_PARENT_LABEL] });
    if (getAddress(subregistry) !== ENS_REGISTRY) {
        const available = await pub.readContract({ address: ETH_REGISTRAR, abi: REGISTRAR_ABI, functionName: 'isAvailable', args: [ENS_PARENT_LABEL] });
        if (!available) throw new Error(`${PARENT_NAME} is taken and its subregistry is ${subregistry}, not ours`);

        const [base, premium] = await pub.readContract({
            address: ETH_REGISTRAR, abi: REGISTRAR_ABI, functionName: 'getRegisterPrice', args: [ENS_PARENT_LABEL, YEAR, MOCK_USDC],
        });
        const cost = base + premium;
        const balance = await pub.readContract({ address: MOCK_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
        if (balance < cost) {
            await send(pub, account, wallet, {
                address: MOCK_USDC, abi: parseAbi(['function mint(address to, uint256 amount)']), functionName: 'mint', args: [account.address, cost - balance],
            }, 'mint MockUSDC');
        }
        const allowance = await pub.readContract({ address: MOCK_USDC, abi: erc20Abi, functionName: 'allowance', args: [account.address, ETH_REGISTRAR] });
        if (allowance < cost) {
            await send(pub, account, wallet, { address: MOCK_USDC, abi: erc20Abi, functionName: 'approve', args: [ETH_REGISTRAR, cost] }, 'approve registrar');
        }

        const secret = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
        const zero32 = `0x${'00'.repeat(32)}`;
        const args = [ENS_PARENT_LABEL, account.address, secret, ENS_REGISTRY, resolver, YEAR];
        const commitment = await pub.readContract({ address: ETH_REGISTRAR, abi: REGISTRAR_ABI, functionName: 'makeCommitment', args: [...args, zero32] });
        const { receipt } = await send(pub, account, wallet, { address: ETH_REGISTRAR, abi: REGISTRAR_ABI, functionName: 'commit', args: [commitment] }, 'commit');

        // The registrar compares against block time, so that is what is waited on, not this machine's clock.
        const minAge = await pub.readContract({ address: ETH_REGISTRAR, abi: REGISTRAR_ABI, functionName: 'MIN_COMMITMENT_AGE' });
        const committedAt = (await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
        for (;;) {
            const head = await pub.getBlock();
            if (head.timestamp > committedAt + minAge + 12n) break;
            await new Promise((ok) => setTimeout(ok, 6000));
        }
        await send(pub, account, wallet, {
            address: ETH_REGISTRAR, abi: REGISTRAR_ABI, functionName: 'register', args: [...args, MOCK_USDC, zero32],
        }, `register ${PARENT_NAME}`);
    } else {
        console.log(`${PARENT_NAME} already carries the mandate registry as its subregistry`);
    }

    // 3. The "agent" label was granted with the shared resolver implementation as its resolver, which
    //    holds no records. The UniversalResolver takes the deepest resolver it finds, so that one would
    //    shadow batas.eth's. setResolver changes the resolver field and nothing else.
    const current = await pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'getResolver', args: [MANDATE_NAME] });
    if (getAddress(current) !== getAddress(resolver)) {
        const tokenId = await pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'findTokenId', args: [MANDATE_NAME] });
        await send(pub, account, wallet, {
            address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'setResolver', args: [tokenId, resolver],
        }, `resolver of ${MANDATE_NAME}`);
    }

    // 4. The canonical back-link. The mandate registry was initialised without ROLE_SET_PARENT and
    //    nobody holds its admin, so the registry refuses; forward resolution does not depend on it.
    //    Reported as the chain's answer rather than skipped quietly.
    const [parent] = await pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'getParent' });
    if (getAddress(parent) !== ETH_REGISTRY) {
        try {
            await send(pub, account, wallet, {
                address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'setParent', args: [ETH_REGISTRY, ENS_PARENT_LABEL],
            }, 'setParent');
        } catch (e) {
            console.log(`setParent refused   ${revertName(e)}`);
        }
    }

    const after = await killSwitchState(pub);
    console.log(`kill switch after   ${JSON.stringify(after)}`);
    for (const k of ['status', 'expiry', 'owner', 'tokenId']) {
        if (String(before[k]) !== String(after[k])) throw new Error(`the kill switch moved: ${k} ${before[k]} -> ${after[k]}`);
    }
}

/** The resolver calls that would bring it to `desiredRecords`, skipping what already matches. */
export async function staleRecordCalls(pub, resolver = ENS_RESOLVER) {
    const calls = [];
    for (const [name, { addr, text }] of Object.entries(desiredRecords())) {
        const node = namehash(name);
        const current = await pub.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'addr', args: [node] });
        if (getAddress(current) !== addr) calls.push({ what: `${name} addr`, data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setAddr', args: [node, addr] }) });
        for (const [key, value] of Object.entries(text)) {
            const onChain = await pub.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'text', args: [node, key] });
            if (onChain !== value) calls.push({ what: `${name} ${key}`, data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setText', args: [node, key, value] }) });
        }
    }
    const alias = await pub.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'getAlias', args: [dnsEncode(ALIAS_NAME)] });
    if (alias.toLowerCase() !== dnsEncode(AGENT_NAME).toLowerCase()) {
        calls.push({ what: `alias ${ALIAS_NAME} -> ${AGENT_NAME}`, data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setAlias', args: [dnsEncode(ALIAS_NAME), dnsEncode(AGENT_NAME)] }) });
    }
    return calls;
}

async function records() {
    const pub = publicClient();
    const calls = await staleRecordCalls(pub);
    for (const c of calls) console.log(`stale  ${c.what}`);
    if (calls.length === 0) return console.log('every record is current');
    const { account, wallet } = signer();
    // One multicall: every record lands in the same block, so no reader sees half an update.
    await send(pub, account, wallet, {
        address: ENS_RESOLVER, abi: RESOLVER_ABI, functionName: 'multicall', args: [calls.map((c) => c.data)],
    }, `multicall ${calls.length} records`);
}

/**
 * ENSIP-25's two-way link between a name and an ERC-8004 agent, checked in both directions.
 *
 * Forward: the name, resolved through the UniversalResolver, carries a non-empty
 * `agent-registration[<registry>][<id>]` record. Reverse: the agent's registration file, read from the
 * identity registry, lists that name as an ENS service. Either half on its own proves nothing — anyone
 * can set a text record naming agent 10123, and any agent can claim any name in its own file — so
 * `linked` is true only when both hold.
 */
export async function verifyAgentLink(pub, { name = AGENT_NAME, agentId = AGENT_ID } = {}) {
    const { resolveAgent } = await import('./erc8004.mjs');
    const normalized = normalize(name);
    const key = agentRegistrationKey(agentId);
    const [value, agent] = await Promise.all([
        pub.getEnsText({ name: normalized, key, strict: true }),
        resolveAgent(String(agentId)),
    ]);
    const claimed = (agent.registration?.services ?? [])
        .filter((s) => typeof s?.name === 'string' && s.name.toLowerCase() === 'ens' && typeof s.endpoint === 'string')
        .map((s) => s.endpoint.toLowerCase());
    const forward = typeof value === 'string' && value.length > 0;
    const reverse = claimed.includes(normalized);
    return {
        name: normalized,
        agentId: String(agentId),
        registry: `eip155:${sepolia.id}:${IDENTITY_REGISTRY}`,
        ensRecord: { key, value: value || null },
        registrationNames: claimed,
        forward,
        reverse,
        linked: forward && reverse,
    };
}

async function status() {
    const { resolveName } = await import('./ens.mjs');
    const pub = publicClient();
    const [parent, parentLabel] = await pub.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'getParent' });
    console.log(`registry parent   ${parent} ${JSON.stringify(parentLabel)}`);
    for (const name of [AGENT_NAME, ALIAS_NAME, PARENT_NAME]) {
        console.log(JSON.stringify(await resolveName(pub, name), null, 2));
    }
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--setup')) return setup();
    if (argv.includes('--records')) return records();
    if (argv.includes('--status')) return status();
    if (argv.includes('--verify')) {
        const link = await verifyAgentLink(publicClient());
        console.log(JSON.stringify(link, null, 2));
        if (!link.linked) process.exitCode = 1;
        return;
    }
    console.log('usage: --status | --setup | --records | --verify');
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage || e.message || e));
        process.exit(1);
    });
}
