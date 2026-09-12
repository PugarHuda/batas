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

export const ROUTER = getAddress(env('BATAS_ROUTER', '0x648a0F330f432452CF53B967fd13305528C320a6'));
export const APP = getAddress(env('BATAS_APP', '0x2A06D6121Cedc9D67404bfb0Ec34BAB8d393e05e'));
export const TOKEN_A = getAddress(env('BATAS_TOKEN_A', '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B'));
export const TOKEN_B = getAddress(env('BATAS_TOKEN_B', '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81'));

/** The address that granted the live mandate. Public: it is the maker in Aqua's own event log. */
export const OWNER = getAddress(env('BATAS_OWNER', '0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E'));

/** ENSv2 UserRegistry proxy, deployed through ENS's own VerifiableFactory. */
export const ENS_REGISTRY = getAddress(env('BATAS_ENS_REGISTRY', '0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B'));
export const MANDATE_NAME = env('BATAS_MANDATE_NAME', 'agent');

/** Where mandates are published, and the ERC-8004 identity that publishes them. */
export const HCS_TOPIC = env('BATAS_HCS_TOPIC', '0.0.10394165');
/**
 * The Sepolia endpoint everything here reads through, in one place rather than twelve.
 *
 * It was `ethereum-sepolia-rpc.publicnode.com`, repeated as an inline default in every file that
 * needed a client, and it cost this project real time. publicnode fronts a load-balanced pool whose
 * backends do not all hold the same receipts: asked eight times for a transaction that is
 * demonstrably on the canonical chain, it answered seven. That is what turned `readme.test.mjs` red
 * with "linked from the README but is not on Sepolia" — a false statement about the chain,
 * assembled out of one endpoint's gaps.
 *
 * Measured before switching, five calls each:
 *
 *   rpc.sepolia.ethpandaops.io    5/5 up, 532ms,  8/8 receipts
 *   sepolia.gateway.tenderly.co   5/5 up, 701ms,  8/8 receipts
 *   1rpc.io/sepolia               5/5 up, 990ms
 *   ethereum-sepolia-rpc.publicnode.com  4/5 up, 1680ms, 7/8 receipts
 *
 * `SEPOLIA_RPC_URL` still overrides it, and tenderly is the alternate worth reaching for. The retry
 * in `readme.test.mjs` stays either way: a better endpoint makes a wrong answer rarer, and the
 * reason that test insists on asking twice is that rare is not never.
 */
export const SEPOLIA_RPC = env('SEPOLIA_RPC_URL', 'https://rpc.sepolia.ethpandaops.io');

export const AGENT_ID = env('BATAS_AGENT_ID', '10123');
/**
 * The Hedera account whose messages count on the publication topic.
 *
 * The topic was created with no submit key, so anyone can write to it — and until now the lookups
 * matched on message content alone. Anyone could post `{"kind":"batas.mandate","program":"0x…"}`
 * and the paid answer would report those bytes as published, with a consensus timestamp, under
 * this project's name. A record is only ours if this account paid for it, and the mirror node says
 * who paid on every message.
 */
export const PUBLISHER = env('HEDERA_SERVICE_ID', '0.0.10388560');
/**
 * ERC-8004's reputation registry, paired with the identity registry above.
 *
 * Checked rather than copied, and the check mattered: the addresses that circulate for these
 * registries include one beginning `0x8004B663056e9e57`, which this project's README already warns
 * about by name. The live one begins `0x8004B663056A597D` — the same twelve characters, then a
 * different address. `getIdentityRegistry()` on it answers with IDENTITY_REGISTRY above, which is
 * what actually establishes they are the same deployment.
 */
export const REPUTATION_REGISTRY = getAddress(
    env('BATAS_REPUTATION_REGISTRY', '0x8004B663056A597Dffe9eCcC1965A193B7388713'),
);

/**
 * The two token addresses in the order Aqua stores them.
 *
 * Aqua sorts the pair, so an order built with them the other way round hashes differently and the
 * position cannot be found. Sorting here rather than at each call site is one fewer place to
 * forget it.
 */
export const TOKENS = [TOKEN_A, TOKEN_B].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
