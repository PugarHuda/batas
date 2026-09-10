// The live deployment, in one place.
//
// Every value here is public by construction: addresses on a public chain, a topic on a public
// mirror node, an id in a public registry. None of it is a secret and none of it could be — the
// whole argument of this project is that a stranger can check a mandate without being handed
// anything. So these are defaults rather than required configuration, and a fresh clone reads the
// live position with no `.env` at all.
//
// They were previously literals repeated across four files each. That is fine until one moves.

import { getAddress } from 'viem';
import 'dotenv/config';

const env = (name, fallback) => process.env[name] || fallback;

/** Aqua is canonical and identical on every chain it is live on. Not ours. */
export const AQUA = getAddress('0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a');

/** Same address on Ethereum Sepolia and Hedera testnet; both checked for code before use. */
export const IDENTITY_REGISTRY = getAddress('0x8004A818BFB912233c491871b3d84c89A494BD9e');

export const ROUTER = getAddress(env('BATAS_ROUTER', '0x8e9BF70758AC73824135C05e70cbdf512713950E'));
export const APP = getAddress(env('BATAS_APP', '0x25E518b4138928da04DD65f0eD595b0924c3decE'));
export const TOKEN_A = getAddress(env('BATAS_TOKEN_A', '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B'));
export const TOKEN_B = getAddress(env('BATAS_TOKEN_B', '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81'));

/** The address that granted the live mandate. Public: it is the maker in Aqua's own event log. */
export const OWNER = getAddress(env('BATAS_OWNER', '0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E'));

/** ENSv2 UserRegistry proxy, deployed through ENS's own VerifiableFactory. */
export const ENS_REGISTRY = getAddress(env('BATAS_ENS_REGISTRY', '0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B'));
export const MANDATE_NAME = env('BATAS_MANDATE_NAME', 'agent');

/** Where mandates are published, and the ERC-8004 identity that publishes them. */
export const HCS_TOPIC = env('BATAS_HCS_TOPIC', '0.0.10394165');
export const AGENT_ID = env('BATAS_AGENT_ID', '10123');

/**
 * The two token addresses in the order Aqua stores them.
 *
 * Aqua sorts the pair, so an order built with them the other way round hashes differently and the
 * position cannot be found. Sorting here rather than at each call site is one fewer place to
 * forget it.
 */
export const TOKENS = [TOKEN_A, TOKEN_B].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
