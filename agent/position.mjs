// Where the live position is, and what its bytes were.
//
// These two lived in inspect.mjs, which also carried the x402 client — so every free answer that
// only wanted to find the position paid to load a payment library it would never call. They are
// here so that the free path imports nothing it does not use; inspect.mjs still re-exports them.

import { createPublicClient, http, decodeAbiParameters, parseAbiParameters } from 'viem';
import { sepolia } from 'viem/chains';

import { AQUA, ROUTER, OWNER, TOKENS, SEPOLIA_RPC } from './deployment.mjs';

const SAFE_BALANCES = [{
    name: 'safeBalances', type: 'function', stateMutability: 'view',
    inputs: [
        { name: 'maker', type: 'address' }, { name: 'app', type: 'address' },
        { name: 'strategyHash', type: 'bytes32' }, { name: 'token0', type: 'address' },
        { name: 'token1', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
}];

// The scan walks up to seven getLogs windows, and every free answer that is not handed a program
// starts with it: the MCP authority tool, read_mandate, the publication check, the health route.
// Asked cold on a slow public endpoint it took longer than an MCP client's sixty-second request
// limit, so an assistant saw a timeout where there was an answer. A minute of reuse is the cost of
// that: a ship or a dock shows up at most a minute late, while the answer's own block pin and
// `docked` check still describe the chain as it was when the scan ran. A failed scan is never
// kept, and a caller that injects its own client always scans.
const REUSE_MS = 60_000;
let recent = null;

/** Pull the newest program this owner shipped to the router, straight out of Aqua's event log. */
export async function latestProgramOnChain({ client } = {}) {
    if (client) return scanLatestProgram({ client });
    if (recent && Date.now() - recent.at < REUSE_MS) return recent.pending;
    const entry = { at: Date.now(), pending: scanLatestProgram() };
    recent = entry;
    entry.pending.catch(() => { if (recent === entry) recent = null; });
    return entry.pending;
}

async function scanLatestProgram({ client } = {}) {
    const owner = OWNER;

    // Injectable for the same reason `resolveAgent` is: the interesting branch here is the one
    // where the scan gives up, and reaching it against a real chain would mean waiting for sixty
    // thousand empty blocks to go by.
    const pub = client ?? createPublicClient({
        chain: sepolia,
        transport: http(SEPOLIA_RPC),
    });

    // Aqua's Shipped event indexes nothing, so filtering happens here rather than at the node.
    const shipped = {
        type: 'event',
        name: 'Shipped',
        inputs: [
            { name: 'maker', type: 'address' },
            { name: 'app', type: 'address' },
            { name: 'strategyHash', type: 'bytes32' },
            { name: 'strategy', type: 'bytes' },
        ],
    };

    const head = await pub.getBlockNumber();
    const WINDOW = 60_000n;
    let exhausted = false;
    for (let to = head, scanned = 0n; to > 0n; ) {
        if (scanned >= WINDOW) {
            exhausted = true;
            break;
        }
        const from = to > 9_000n ? to - 9_000n : 0n;
        const batch = await pub.getLogs({ address: AQUA, event: shipped, fromBlock: from, toBlock: to });
        const mine = batch.filter(
            (l) => l.args.maker?.toLowerCase() === owner.toLowerCase()
                && l.args.app?.toLowerCase() === ROUTER.toLowerCase(),
        );
        if (mine.length > 0) {
            // strategy is abi.encode(Order); the program is the tail of `data` after the two tokens.
            const { strategy, strategyHash } = mine[mine.length - 1].args;
            return { strategyHash, strategy, docked: await isDocked(pub, strategyHash) };
        }
        scanned += to - from;
        to = from - 1n;
    }

    // Nothing found — and which "nothing" this is matters.
    //
    // `Shipped` indexes none of its parameters, so a node cannot filter it and this walks the logs
    // by hand. The walk is bounded, and until now hitting that bound returned the same `null` as
    // searching the entire chain: every caller then said "no mandate has been shipped yet", which
    // is a claim about the maker made out of a decision we took about how long to look.
    //
    // The whole chain having been searched is a finding. Sixty thousand blocks having gone by is
    // not, so it is raised rather than returned — a caller that cannot tell them apart should be
    // stopped rather than quietly handed the wrong one.
    if (exhausted) {
        const err = new Error(
            `no position found in the last ${WINDOW} blocks from ${head}; this is where the scan `
            + 'stopped, not where the chain does. Pass the program explicitly, or widen the window.',
        );
        err.scanExhausted = true;
        err.headBlock = head;
        err.windowBlocks = Number(WINDOW);
        throw err;
    }
    return null;
}

/**
 * Whether the maker has already docked this position.
 *
 * The event log only ever says a position was shipped; docking leaves no `Shipped` behind it. So
 * the newest log can name a position that no longer holds anything, and every free answer would
 * describe its terms as if they were still on offer. Aqua's `safeBalances` refuses to answer for a
 * docked strategy, and that refusal is the only on-chain record of the dock — so a revert here is
 * the finding, and any other failure is still a failure.
 */
async function isDocked(pub, strategyHash) {
    try {
        await pub.readContract({
            address: AQUA, abi: SAFE_BALANCES, functionName: 'safeBalances',
            args: [OWNER, ROUTER, strategyHash, TOKENS[0], TOKENS[1]],
        });
        return false;
    } catch (e) {
        if (e.walk?.((x) => x.name === 'ContractFunctionRevertedError')) return true;
        throw e;
    }
}

/**
 * Recover the program from the strategy bytes Aqua stored.
 *
 * The strategy is `abi.encode(Order)`, and `Order` has a dynamic member, so the encoding opens
 * with an offset word before the struct itself. Hand-counting those words is how the first version
 * of this function got it wrong; viem already knows the layout, so it decodes rather than counts.
 * `Order.data` is then tokenA ++ tokenB ++ program, and the program starts 40 bytes in.
 */
export function programFromStrategy(strategyHex) {
    const [order] = decodeAbiParameters(
        parseAbiParameters('(address maker, uint256 traits, bytes data)'),
        strategyHex,
    );
    const data = order.data.replace(/^0x/, '');
    if (data.length < 80) throw new Error('order data is shorter than its two token addresses');
    return `0x${data.slice(80)}`;
}
