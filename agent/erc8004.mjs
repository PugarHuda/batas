// Reading agent identities out of the canonical ERC-8004 registry.
//
// A mandate tells you what a position will do. It says nothing about who is running it, and the
// program cannot: bytecode has no author field. ERC-8004 is where that answer lives, so the
// inspection service resolves it rather than asking a caller to take an operator's word for it.
//
// Registering an identity and never reading one back would leave the standard as decoration. This
// is the read side.

import { createPublicClient, http, getAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { SEPOLIA_RPC } from './deployment.mjs';

// Same address on Ethereum Sepolia and Hedera testnet.
export const IDENTITY_REGISTRY = getAddress('0x8004A818BFB912233c491871b3d84c89A494BD9e');

const REGISTRY_ABI = [
    { name: 'tokenURI', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
    { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
];

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
    } catch {
        return { registered: false, agentId: id.toString(), registry: IDENTITY_REGISTRY };
    }

    let uri = '';
    try {
        uri = await pub.readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'tokenURI', args: [id] });
    } catch { /* an identity can exist without a readable URI; say so rather than fail */ }

    const parsed = parseAgentURI(uri);
    return {
        registered: true,
        agentId: id.toString(),
        registry: IDENTITY_REGISTRY,
        owner,
        uriKind: parsed.kind,
        ...(parsed.kind === 'inline' ? { registration: parsed.registration } : {}),
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
