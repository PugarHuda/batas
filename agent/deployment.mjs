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

export const ROUTER = getAddress(env('BATAS_ROUTER', '0xaAC338aC7776b40F0f2757B824D188f8fbe35E8E'));
export const APP = getAddress(env('BATAS_APP', '0xD2cB41A7E77af1171deb18A3c559c578f4D82146'));
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

/**
 * Batas Inspection Credit (BIC), the HTS token the paid inspection accepts after HBAR.
 *
 * Its custom fee schedule is part of every settlement in it: a fixed 0.01 BIC fee, paid by the sender
 * on top of the price and collected by the service account, assessed by the ledger at consensus
 * rather than by anything this service runs. Created by `node agent/hts.mjs --create`.
 */
export const HTS_TOKEN = env('BATAS_HTS_TOKEN', '0.0.10523367');

/**
 * Where the mandate registry sits in the ENS hierarchy: `<MANDATE_NAME>.<ENS_PARENT_LABEL>.eth`.
 *
 * ENS_REGISTRY above is batas.eth's subregistry, so the label the settlement reads is also a name ENS
 * clients resolve. The resolver is batas.eth's PermissionedResolver, deployed through ENS's
 * VerifiableFactory. ETH_REGISTRY and ETH_REGISTRAR are the ENSv2 beta's own, checked for code before
 * use because the beta has moved before.
 */
export const ENS_PARENT_LABEL = env('BATAS_ENS_PARENT_LABEL', 'batas');
export const ENS_NAME = `${MANDATE_NAME}.${ENS_PARENT_LABEL}.eth`;
export const ENS_RESOLVER = getAddress(env('BATAS_ENS_RESOLVER', '0x671C506Aaa2a123bE802Fe51975Ca9515AEC2516'));
export const ETH_REGISTRY = getAddress('0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2');
export const ETH_REGISTRAR = getAddress('0xa88553f454b77203b0d036a05c894d555eaaa2cc');

/**
 * The banded, two-sided position on Sepolia, shipped by `node agent/band-live.mjs --ship`.
 *
 * Its maker is not OWNER, on purpose. Every reader of the live position filters Aqua's log by OWNER
 * and the router, so this band sits on the same router and the same tokens without becoming "the
 * live position" to any of them. The ship transaction alone rebuilds the order; the swaps are one
 * each way, and `band-live.test.mjs` reprices both against their Transfer logs.
 */
export const BAND_MAKER = getAddress(env('BATAS_BAND_MAKER', '0x3c57764cd37d5F624fcd04d2C1074A5074e5E58b'));
export const BAND_SHIP_TX = env('BATAS_BAND_SHIP_TX', '0x15b6bf658d95ed853a668d03ea7bc6f4fef00f9ae4cfadce7b40da77577389c9');
export const BAND_STRATEGY_HASH = env('BATAS_BAND_STRATEGY_HASH', '0x9af9f48811f516a5cf8263b4978ce543011915312d5b4c7d5fe1367ed36e5f30');
export const BAND_SWAP_TXS = env(
    'BATAS_BAND_SWAP_TXS',
    '0x69eda36bdaaf01112f9e92d8163d67f6a4ce629eb97a64f252cecf4c7175d4e6,0x8da6253af8ac55fca6ebd5c8daef4c0f31490d271cf20b4d8982a167b6b0b94c',
);

/**
 * The second agent namespace under batas.eth: `<COUNTERPARTY_LABEL>.<ENS_PARENT_LABEL>.eth`.
 *
 * agent/counterparty.mjs trades, pays and writes reputation from this address. It holds its own name in
 * the mandate registry, granted by OWNER on the same terms as the maker's label: expiring, soulbound, and
 * revocable by the grantor. It also holds its own ERC-8004 identity, which it minted with its own key.
 * Both are written by `node agent/namespaces.mjs`.
 */
export const COUNTERPARTY = getAddress(env('BATAS_COUNTERPARTY_ADDRESS', '0x1437aF5722D5Dfe6BAEda25f3A7A39aeCA374614'));
export const COUNTERPARTY_LABEL = env('BATAS_COUNTERPARTY_LABEL', 'counterparty');
export const COUNTERPARTY_NAME = `${COUNTERPARTY_LABEL}.${ENS_PARENT_LABEL}.eth`;
/** Minted by the counterparty's own key in tx 0x967a2895a649c237711b0f005ddadafaf715b6bb187c961439d08378043df081. */
export const COUNTERPARTY_AGENT_ID = env('BATAS_COUNTERPARTY_AGENT_ID', '10258');
