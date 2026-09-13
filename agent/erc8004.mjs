// Reading agent identities out of the canonical ERC-8004 registry.
//
// A mandate tells you what a position will do. It says nothing about who is running it, and the
// program cannot: bytecode has no author field. ERC-8004 is where that answer lives, so the
// inspection service resolves it rather than asking a caller to take an operator's word for it.
//
// Registering an identity and never reading one back would leave the standard as decoration. This
// is the read side.

import { createPublicClient, http, getAddress, zeroAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { SEPOLIA_RPC } from './deployment.mjs';

// Same address on Ethereum Sepolia and Hedera testnet.
export const IDENTITY_REGISTRY = getAddress('0x8004A818BFB912233c491871b3d84c89A494BD9e');

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export const REGISTRY_ABI = [
    { name: 'tokenURI', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
    { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
    // The address the agent is paid at, which is not the same fact as who holds the identity. The
    // registry sets it to the owner at mint, only changes it against a signature from the new wallet,
    // and clears it when the token is transferred — so a zero here means nobody has proved control
    // of a payment address since the identity last changed hands.
    { name: 'getAgentWallet', type: 'function', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ type: 'address' }] },
];

/**
 * Check a registration file against the spec, and against the token it was read from.
 *
 * Decoding a registration only proves it is JSON. The field that matters most is `registrations`:
 * the file has to name this agent id in this registry, or it is a description that could have been
 * copied from any other agent and pointed at a different token. Nothing here fetches an endpoint —
 * the same reason `parseAgentURI` does not — so services are checked for shape, not for liveness.
 */
export function checkRegistration(registration, agentId, { registry = IDENTITY_REGISTRY, chainId = sepolia.id } = {}) {
    if (!registration || typeof registration !== 'object' || Array.isArray(registration)) {
        return { valid: false, bound: false, issues: ['the registration is not a JSON object'] };
    }
    const issues = [];
    if (registration.type !== REGISTRATION_TYPE) issues.push(`type is ${JSON.stringify(registration.type)}, not ${REGISTRATION_TYPE}`);
    if (typeof registration.name !== 'string' || registration.name.trim() === '') issues.push('the registration has no name');
    if ('active' in registration && typeof registration.active !== 'boolean') issues.push('active is not a boolean');
    if ('x402Support' in registration && typeof registration.x402Support !== 'boolean') issues.push('x402Support is not a boolean');
    if ('supportedTrust' in registration
        && !(Array.isArray(registration.supportedTrust) && registration.supportedTrust.every((t) => typeof t === 'string'))) {
        issues.push('supportedTrust is not a list of strings');
    }
    // Endpoints are not all URLs — the spec allows ENS names, DIDs and CAIP-10 accounts — so the only
    // honest structural check is that each service says what it is and where.
    if ('services' in registration && !Array.isArray(registration.services)) issues.push('services is not a list');
    for (const [i, s] of (Array.isArray(registration.services) ? registration.services : []).entries()) {
        if (typeof s?.name !== 'string' || s.name === '') issues.push(`service ${i} has no name`);
        if (typeof s?.endpoint !== 'string' || s.endpoint === '') issues.push(`service ${s?.name || i} has no endpoint`);
    }

    const caip10 = `eip155:${chainId}:${registry}`.toLowerCase();
    const bound = Array.isArray(registration.registrations) && registration.registrations.some((r) =>
        (typeof r?.agentId === 'number' || typeof r?.agentId === 'string') && parseAgentId(r.agentId) === BigInt(agentId)
        && typeof r?.agentRegistry === 'string' && r.agentRegistry.toLowerCase() === caip10);
    if (!bound) issues.push(`registrations does not name agent #${agentId} in ${caip10}`);
    return { valid: issues.length === 0, bound, issues };
}

/**
 * Decode a registration file.
 *
 * `data:` URIs are read inline. An http(s) URI is reported as a link rather than fetched: this runs
 * inside a paid request, and an operator who controls the URI should not be able to decide how long
 * that request takes or make it fetch arbitrary hosts on a caller's behalf.
 */
export function parseAgentURI(uri) {
    if (typeof uri !== 'string' || uri.length === 0) return { kind: 'missing' };
    if (uri.startsWith('data:')) {
        const comma = uri.indexOf(',');
        if (comma === -1) return { kind: 'malformed', uri };
        const payload = uri.slice(comma + 1);
        const isBase64 = uri.slice(0, comma).includes(';base64');
        try {
            const text = isBase64 ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
            return { kind: 'inline', registration: JSON.parse(text) };
        } catch (e) {
            return { kind: 'malformed', uri, error: String(e.message ?? e) };
        }
    }
    return { kind: 'hosted', uri };
}

/**
 * Interpret whatever arrived as an agent id, or say it is not one.
 *
 * `BigInt()` is far more willing than it looks: `BigInt([])` is `0n`, so an empty array asked about
 * agent #0 and got a real answer back. Everything else — an object, a float, a negative, "1e999" —
 * throws from deep inside, which the caller then sees as the identity failing rather than as their
 * own input being wrong. Neither is acceptable in something people pay for.
 */
export function parseAgentId(value) {
    if (typeof value === 'bigint') return value >= 0n ? value : null;
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return BigInt(value.trim());
    return null;
}

/**
 * Resolve an agent id to what the registry actually holds.
 *
 * Everything returned is read from chain. Nothing is inferred, and an id that is not registered
 * comes back as such rather than as an empty identity, because "no answer" and "an agent with no
 * name" are very different things to tell someone about to trade.
 */
export async function resolveAgent(agentId, { client, rpcUrl } = {}) {
    const id = parseAgentId(agentId);
    if (id === null) throw new Error('agentId must be a non-negative integer');
    const pub = client ?? createPublicClient({
        chain: sepolia,
        transport: http(rpcUrl || SEPOLIA_RPC),
    });

    let owner;
    try {
        owner = await pub.readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'ownerOf', args: [id] });
    } catch (e) {
        // Only a revert means "no such agent". A transport that would not answer used to land here
        // too and come out as `registered: false` — a statement about somebody else's identity made
        // out of our own failure to ask, which the paid route then wrapped as `checked: true`.
        // Anything that is not the contract refusing is rethrown so the caller can say "not
        // checked" instead of "not registered".
        const reverted = typeof e?.walk === 'function'
            ? e.walk((x) => x?.name === 'ContractFunctionRevertedError' || x?.name === 'ContractFunctionExecutionError' && /revert/i.test(x.shortMessage ?? '')) !== null
            : /revert/i.test(String(e?.shortMessage ?? e?.message ?? ''));
        if (!reverted) throw e;
        return { registered: false, agentId: id.toString(), registry: IDENTITY_REGISTRY };
    }

    const [uri, wallet] = await Promise.all([
        // An identity can exist without a readable URI; say so rather than fail.
        pub.readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'tokenURI', args: [id] }).catch(() => ''),
        // A wallet we could not read is left out entirely rather than reported as unset: "unset"
        // is a statement about the identity, and a failed call is not evidence of one.
        pub.readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'getAgentWallet', args: [id] }).catch(() => undefined),
    ]);

    const parsed = parseAgentURI(uri);
    return {
        registered: true,
        agentId: id.toString(),
        registry: IDENTITY_REGISTRY,
        owner,
        ...(wallet === undefined ? {} : { agentWallet: wallet === zeroAddress ? null : getAddress(wallet) }),
        uriKind: parsed.kind,
        ...(parsed.kind === 'inline'
            ? { registration: parsed.registration, registrationCheck: checkRegistration(parsed.registration, id) }
            : {}),
        ...(parsed.kind === 'hosted' ? { registrationURI: parsed.uri } : {}),
    };
}

/**
 * Does this identity actually vouch for the address that granted the mandate?
 *
 * An identity is only evidence if the same key controls both. A registration naming someone else
 * is not proof of anything, and saying so plainly is more useful than omitting the check.
 */
export function vouchesFor(agent, makerAddress) {
    if (!agent?.registered) return { vouched: false, reason: 'no identity to check' };
    // A maker that is not a string used to throw out of `.toLowerCase()`, and the caller saw that as
    // the identity being unregistered. Say what is actually wrong instead.
    if (typeof makerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(makerAddress)) {
        return { vouched: false, reason: 'no maker address to check against' };
    }
    if (agent.owner?.toLowerCase() === makerAddress.toLowerCase()) {
        return { vouched: true, reason: 'the identity is held by the address that granted the mandate' };
    }
    return {
        vouched: false,
        reason: `identity #${agent.agentId} is held by ${agent.owner}, which did not grant this mandate`,
    };
}
