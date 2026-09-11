// Batas agent.
//
// Reads the live position on Sepolia, decides what mandate the owner should be asked to grant,
// encodes the SwapVM program itself, and ships it. Every number below comes off the chain; nothing
// here is simulated.
//
//   node agent/batas-agent.mjs            observe and decide, no transaction
//   node agent/batas-agent.mjs --ship     also ship the mandate it decided on
//   node agent/batas-agent.mjs --watch    keep running it: re-check authority, renew near expiry
//   node agent/batas-agent.mjs --watch --ship --interval 60 --max-ships 2
//
// The agent chooses within bounds it cannot widen: the floor price it proposes is derived from the
// spot it observed, and whatever it proposes is enforced by PolicyEnvelope inside the VM. That is
// the point of the project — the agent decides, the machine constrains.

import {
    createPublicClient, createWalletClient, http, encodeAbiParameters, parseAbiParameters,
    keccak256, concat, formatUnits, getAddress,
} from 'viem';

import { toProgram, decideMandate, decodeProgram, readMandate, volatilityBudget } from './swapvm.mjs';
import { programFromStrategy } from './inspect.mjs';
import { mandateNameStatus } from './ens.mjs';
import { publishMandate } from './hcs.mjs';
import { AQUA, ROUTER, TOKENS, ENS_REGISTRY, MANDATE_NAME } from './deployment.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import 'dotenv/config';

const [TOKEN_A, TOKEN_B] = TOKENS;

// Opcodes, read from @1inch/swap-vm/src/libs/OpcodeList.sol.
const OP = { SALT: 0x02, POLICY_ENVELOPE: 0x21, XYC_SWAP: 0x50, FEE_FLAT_IN: 0x70 };

// MakerTraits packing for an Aqua-backed order with no hooks: the Aqua flag, and four uint16
// order-data offsets that are all 40 because `data` starts with two addresses and nothing else.
const AQUA_FLAG = 1n << 254n;
const ORDER_DATA_INDEXES = 0x0028002800280028n;
const TRAITS = AQUA_FLAG | (ORDER_DATA_INDEXES << 160n);

// How long a grant lasts, in hours. Shared with script/Demo.s.sol through the same variable so
// the two never disagree about what a mandate's term is.
const MANDATE_HOURS = BigInt(process.env.BATAS_MANDATE_HOURS || 2);

const BPS = 10_000_000n; // SwapVM fee base, 1e7
const E18 = 10n ** 18n;

const AQUA_ABI = [
    {
        name: 'safeBalances', type: 'function', stateMutability: 'view',
        inputs: [
            { name: 'maker', type: 'address' }, { name: 'app', type: 'address' },
            { name: 'strategyHash', type: 'bytes32' }, { name: 'token0', type: 'address' },
            { name: 'token1', type: 'address' },
        ],
        outputs: [{ type: 'uint256' }, { type: 'uint256' }],
    },
    {
        name: 'ship', type: 'function', stateMutability: 'nonpayable',
        inputs: [
            { name: 'app', type: 'address' }, { name: 'strategy', type: 'bytes' },
            { name: 'tokens', type: 'address[]' }, { name: 'amounts', type: 'uint256[]' },
        ],
        outputs: [{ type: 'bytes32' }],
    },
];

const ROUTER_ABI = [{
    name: 'hash', type: 'function', stateMutability: 'view',
    inputs: [{
        name: 'order', type: 'tuple',
        components: [
            { name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' },
            { name: 'data', type: 'bytes' },
        ],
    }],
    outputs: [{ type: 'bytes32' }],
}];

const ERC20_ABI = [
    { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
    { name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
];

// --- SwapVM program encoding -------------------------------------------------
// Shared with the decoder and with MandateLib on the Solidity side, rather than written a second
// time here. The first version of this file had its own inline encoder and silently dropped the
// Deadline instruction, so every mandate the agent granted was one that never expired.

const buildOrder = (maker, program) => ({
    maker,
    traits: TRAITS,
    data: concat([TOKEN_A, TOKEN_B, program]),
});

// In Aqua mode the shipped strategy is the encoded order, so its keccak is the strategy hash.
const encodeOrder = (order) =>
    encodeAbiParameters(parseAbiParameters('(address maker, uint256 traits, bytes data)'), [order]);

// --- the agent ---------------------------------------------------------------

const pct = (n, d) => (d === 0n ? '0' : (Number((n * 10000n) / d) / 100).toFixed(2));

/**
 * Should this mandate be replaced yet?
 *
 * Pure, exported and deliberately narrow. The agent renews on *time* and on nothing else: a
 * mandate approaching its deadline is about to stop authorising anything, and re-granting is the
 * only way the position keeps working. It does not renew because the price moved, and that is a
 * decision rather than an omission — re-shipping burns a strategy hash and writes new terms, so an
 * agent that did it whenever spot drifted would be rewriting its own limits as a matter of routine,
 * which is the one thing this project exists to prevent it doing.
 */
export function renewalDecision({ expiry, now = Math.floor(Date.now() / 1000), renewBeforeSeconds = 3600 }) {
    if (expiry === null || expiry === undefined) {
        return { act: true, reason: 'the live mandate carries no deadline; granting one that does' };
    }
    const left = Number(expiry) - now;
    if (left <= 0) return { act: true, reason: `the mandate expired ${-left}s ago` };
    if (left <= renewBeforeSeconds) {
        return { act: true, reason: `${left}s left, inside the ${renewBeforeSeconds}s renewal window` };
    }
    return { act: false, reason: `${Math.floor(left / 3600)}h left; nothing to do` };
}

async function tick({ watching = false, mayShip = true } = {}) {
    const shipIt = process.argv.includes('--ship') && mayShip;
    const key = process.env.SEPOLIA_PRIVATE_KEY;
    if (!key) throw new Error('SEPOLIA_PRIVATE_KEY missing; copy .env.example to .env');

    const account = privateKeyToAccount(key);
    const transport = http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com');
    const pub = createPublicClient({ chain: sepolia, transport });
    const wallet = createWalletClient({ account, chain: sepolia, transport });

    console.log(`owner   ${account.address}`);
    console.log(`router  ${ROUTER}`);

    // 1. Observe. Find the position this owner most recently shipped to the router and read what
    //    Aqua says its reserves are right now.
    // Public RPCs cap how far back a single getLogs call may reach, so walk backwards in windows
    // rather than asking for the whole chain and being refused.
    const head = await pub.getBlockNumber();
    const WINDOW = 9_000n;
    const MAX_LOOKBACK = 200_000n;
    // Aqua declares `Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)`
    // with NOTHING indexed — every field lives in the data, and the log carries a single topic.
    // So the node cannot filter by maker or app for us; we fetch and sift here.
    const shippedEvent = {
        type: 'event', name: 'Shipped',
        inputs: [
            { name: 'maker', type: 'address' },
            { name: 'app', type: 'address' },
            { name: 'strategyHash', type: 'bytes32' },
            { name: 'strategy', type: 'bytes' },
        ],
    };

    let logs = [];
    let scanned = 0n;
    for (let to = head; logs.length === 0 && scanned < MAX_LOOKBACK && to > 0n; ) {
        const from = to > WINDOW ? to - WINDOW : 0n;
        const batch = await pub.getLogs({ address: AQUA, event: shippedEvent, fromBlock: from, toBlock: to });
        logs = batch.filter(
            (l) => l.args.maker?.toLowerCase() === account.address.toLowerCase()
                && l.args.app?.toLowerCase() === ROUTER.toLowerCase(),
        );
        scanned += to - from;
        to = from - 1n;
    }
    console.log(`scanned ${scanned} blocks back from ${head}`);

    if (logs.length === 0) {
        console.log('\nno position shipped to this router yet; run script/Demo.s.sol first');
        return;
    }

    const latest = logs[logs.length - 1];
    const strategyHash = latest.args.strategyHash;
    console.log(`\nobserved ${logs.length} mandate(s); reading the newest`);
    console.log(`  hash   ${strategyHash}`);
    console.log(`  block  ${latest.blockNumber}`);

    // What this position's price has actually done, for the floor to be derived from rather than
    // typed. `Swapped` indexes nothing either, so it is fetched and sifted here the same way.
    const swappedEvent = {
        type: 'event', name: 'Swapped',
        inputs: [
            { name: 'orderHash', type: 'bytes32' },
            { name: 'maker', type: 'address' },
            { name: 'taker', type: 'address' },
            { name: 'tokenIn', type: 'address' },
            { name: 'tokenOut', type: 'address' },
            { name: 'amountIn', type: 'uint256' },
            { name: 'amountOut', type: 'uint256' },
        ],
    };
    const settledRates = [];
    try {
        const since = head > MAX_LOOKBACK ? head - MAX_LOOKBACK : 0n;
        for (let to = head; to > since; ) {
            const from = to > WINDOW ? to - WINDOW : 0n;
            const batch = await pub.getLogs({ address: ROUTER, event: swappedEvent, fromBlock: from, toBlock: to });
            for (const l of batch) {
                if (l.args.maker?.toLowerCase() !== account.address.toLowerCase()) continue;
                if (!l.args.amountIn || l.args.amountIn === 0n) continue;
                settledRates.push({ block: l.blockNumber, rate: (l.args.amountOut * E18) / l.args.amountIn });
            }
            to = from - 1n;
            if (from === 0n) break;
        }
    } catch {
        // History is an input to a better number, not a precondition for acting. A node that will
        // not serve the range leaves the budget at its floor rather than stopping the agent.
    }
    settledRates.sort((a, b) => (a.block < b.block ? -1 : 1));

    const [reserveA, reserveB] = await pub.readContract({
        address: AQUA, abi: AQUA_ABI, functionName: 'safeBalances',
        args: [account.address, ROUTER, strategyHash, TOKEN_A, TOKEN_B],
    });

    // 2. Check that it is allowed to act at all, before doing any work.
    //
    // The ENS mandate name is the owner's kill switch. Revoking it, or simply letting it expire,
    // ends the agent's authority without touching the position or spending anything on chain. An
    // agent that does not consult it turns that control into decoration, so the check runs before
    // the transaction rather than after.
    let liveExpiry = null;
    const ensRegistry = ENS_REGISTRY;
    if (ensRegistry) {
        const label = MANDATE_NAME;
        // The live mandate's own deadline. The name is granted to run exactly that long, so an
        // earlier expiry on the name means the owner pulled it rather than that it ran out — and
        // an agent reporting a withdrawal as a lapse tells its operator the wrong thing.
        let grantedUntil;
        try {
            grantedUntil = readMandate(decodeProgram(programFromStrategy(latest.args.strategy))).expiry ?? undefined;
        } catch { /* an undecodable strategy is not a reason to skip the authority check */ }
        liveExpiry = grantedUntil ?? null;
        const status = await mandateNameStatus(pub, getAddress(ensRegistry), label, account.address, { grantedUntil });
        console.log('');
        console.log(`mandate name "${label}": ${status.reason}`);
        if (!status.valid) {
            console.error('refusing to act without a valid mandate name');
            // In a watch the loop keeps running: the owner may hand the authority back, and an
            // agent that exited on revocation would have to be restarted by the person who just
            // demonstrated they can stop it remotely. Outside a watch it is a failed run.
            if (!watching) process.exitCode = 1;
            return { shipped: false, stopped: 'authority', reason: status.reason };
        }
        console.log(`  ${Math.floor(status.secondsLeft / 60)} minutes of authority left`);
    } else {
        console.log('');
        console.log('no BATAS_ENS_REGISTRY set; skipping the mandate-name check');
    }


    // 3. Decide. Spot comes from the reserves the chain reports, not from a guess.
    const spotE18 = (reserveB * E18) / reserveA;
    console.log(`\nreserves ${formatUnits(reserveA, 18)} A / ${formatUnits(reserveB, 18)} B`);
    console.log(`spot     ${formatUnits(spotE18, 18)} B per A`);

    // The floor sits one slippage budget under spot; the cap is a slice of the reserve, which is
    // what actually bounds how far a single trade can walk the price.
    const budget = volatilityBudget(settledRates.map((r) => r.rate));
    const SLIPPAGE_BPS = budget.bps;
    // A ceiling, not the cap. The real limit comes out of the slippage budget: on a constant
    // product curve a floor and a size cap are the same constraint stated twice, so the cap is
    // derived rather than guessed beside it.
    const CAP_BPS = 1000n;
    const FEE_BPS = 30_000n; // 0.3% of SwapVM's 1e7 base

    const { minRateE18, maxAmountIn } = decideMandate({
        reserveA, reserveB, slippageBps: SLIPPAGE_BPS, capBps: CAP_BPS,
    });

    console.log('\ndecision');
    console.log(`  budget ${SLIPPAGE_BPS}bps from ${budget.samples} settled trade(s) — ${budget.reason}`);
    console.log(`  floor  ${formatUnits(minRateE18, 18)} B per A  (${pct(SLIPPAGE_BPS, 10000n)}% under spot)`);
    console.log(
        `  cap    ${formatUnits(maxAmountIn, 18)} A  (${pct((maxAmountIn * 10_000n) / reserveA, 10_000n)}% of reserve,`
        + ` the largest trade that still clears the floor)`,
    );
    console.log(`  fee    ${Number(FEE_BPS) / Number(BPS) * 100}%`);
    console.log(`  expires in ${MANDATE_HOURS} hour${MANDATE_HOURS === 1n ? '' : 's'}`);

    // Expiry is part of the grant, not decoration: a mandate with no deadline is authority with
    // no end. How long is the maker's call, not ours — an agent that picks its own term is
    // choosing the one limit it is least entitled to. Two hours is the default the demo shares.
    const expiry = BigInt(Math.floor(Date.now() / 1000)) + MANDATE_HOURS * 3600n;
    // The kill switch, compiled in rather than merely consulted.
    //
    // The check above is the agent choosing to obey; this is the settlement refusing without it.
    // Until the name was an instruction, revoking it stopped this agent because this agent asks,
    // and stopped nobody else — not a second copy of it, and not an ordinary taker arriving at a
    // position that was still shipped. Naming the registry here binds every caller.
    //
    // Same registry and holder the agent just checked, so the authority it obeys and the authority
    // the chain enforces cannot be two different things.
    const program = toProgram({
        maxAmountIn,
        minRateE18,
        expiry,
        feeBps: FEE_BPS,
        salt: BigInt(Math.floor(Date.now() / 1000)),
        ...(ensRegistry
            ? { nameRegistry: getAddress(ensRegistry), nameHolder: account.address, nameLabel: MANDATE_NAME }
            : {}),
    });
    const order = buildOrder(account.address, program);

    console.log(`\nprogram  ${program} (${(program.length - 2) / 2} bytes)`);

    // 4. Prove the encoding. The router computes the order hash on chain; if our bytes were wrong
    //    in any way, these two would differ. This is the check that makes the encoder trustworthy.
    const localHash = keccak256(encodeOrder(order));
    const chainHash = await pub.readContract({
        address: ROUTER, abi: ROUTER_ABI, functionName: 'hash', args: [order],
    });
    const agrees = localHash.toLowerCase() === chainHash.toLowerCase();
    console.log(`\nencoding check`);
    console.log(`  local  ${localHash}`);
    console.log(`  chain  ${chainHash}`);
    console.log(`  ${agrees ? 'agree' : 'DISAGREE, refusing to ship'}`);
    if (!agrees) process.exitCode = 1;
    if (!agrees) return { shipped: false, stopped: 'encoding' };

    // In a watch, wanting to ship is not the same as it being time to.
    const due = renewalDecision({ expiry: liveExpiry, renewBeforeSeconds: RENEW_BEFORE });
    if (watching) {
        console.log(`\nrenewal  ${due.reason}`);
        if (!due.act) return { shipped: false, reason: due.reason };
    }

    if (!shipIt) {
        console.log(mayShip
            ? '\nrun again with --ship to grant this mandate'
            : '\nship budget for this watch is spent; observing only');
        return { shipped: false, reason: 'not shipping' };
    }

    // 5. Act.
    const balA = await pub.readContract({ address: TOKEN_A, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
    const balB = await pub.readContract({ address: TOKEN_B, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
    const shipA = balA < reserveA ? balA : reserveA;
    const shipB = balB < reserveB ? balB : reserveB;
    if (shipA === 0n || shipB === 0n) throw new Error('owner holds none of the pair; mint demo tokens first');

    console.log(`\nshipping ${formatUnits(shipA, 18)} A / ${formatUnits(shipB, 18)} B under the new mandate`);
    const hash = await wallet.writeContract({
        address: AQUA, abi: AQUA_ABI, functionName: 'ship',
        args: [ROUTER, encodeOrder(order), [TOKEN_A, TOKEN_B], [shipA, shipB]],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`  tx     ${hash}`);
    console.log(`  status ${receipt.status}  gas ${receipt.gasUsed}`);
    console.log(`\nhttps://sepolia.etherscan.io/tx/${hash}`);

    // 6. Publish. The grant is now on Sepolia, but its date is a block's word. Submitting the same
    //    bytes to HCS puts an independent consensus timestamp on them, which is what the inspection
    //    service hands to anyone who later asks whether this mandate is real and how old it is.
    //
    //    This runs after settlement on purpose: publishing a mandate that failed to ship would
    //    advertise authority that was never granted.
    if (receipt.status !== 'success') return;
    if (!process.env.BATAS_HCS_TOPIC) {
        console.log('\nno BATAS_HCS_TOPIC set; the mandate was not published to Hedera');
        return;
    }
    try {
        const published = await publishMandate(null, {
            program, maker: account.address, app: ROUTER, chainId: sepolia.id, strategyHash: chainHash,
        });
        console.log(`\npublished to HCS topic ${published.topicId}`);
        console.log(`  sequence ${published.sequenceNumber}  tx ${published.transactionId}`);
        console.log(`  https://hashscan.io/testnet/topic/${published.topicId}`);
    } catch (e) {
        // The mandate is granted either way; say the publication failed rather than implying the
        // record exists.
        console.error(`\nHCS publication failed: ${String(e.message || e)}`);
        if (!watching) process.exitCode = 1;
    }

    return { shipped: true };
}

const argValue = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? fallback : process.argv[i + 1];
};

const RENEW_BEFORE = Number(process.env.BATAS_RENEW_BEFORE_SECONDS || argValue('--renew-before', 3600));

/**
 * The part that makes "an agent runs your position" true rather than aspirational.
 *
 * Until this existed the agent was a command: it observed, decided, shipped and exited, and the
 * word autonomous was carrying a claim one invocation cannot support. A position is run over time —
 * the mandate approaches its deadline, the owner takes the name back and later hands it over again
 * — and none of that was anything this program could see.
 *
 * Three guards, because a loop that sends transactions needs them. It ships only inside the renewal
 * window, never more than `--max-ships` times in one run, and the interval has a floor: an agent
 * polling two chains every second is not attentive, it is a denial of service with good intentions.
 */
async function watch() {
    const interval = Math.max(30, Number(argValue('--interval', 300)));
    const budget = Number(argValue('--max-ships', 3));
    const willShip = process.argv.includes('--ship');
    console.log(`watching every ${interval}s; renewing inside ${RENEW_BEFORE}s of expiry`);
    console.log(willShip ? `ship budget ${budget}` : 'observing only; add --ship to let it act');

    let shipped = 0;
    for (let round = 1; ; round++) {
        console.log(`\n${'='.repeat(68)}\n${new Date().toISOString()}  round ${round}\n${'='.repeat(68)}`);
        try {
            const result = await tick({ watching: true, mayShip: shipped < budget });
            if (result?.shipped) {
                shipped += 1;
                console.log(`\nships used ${shipped}/${budget}`);
            }
        } catch (e) {
            // A failed round is a bad minute, not a reason to stop running the position. The next
            // one re-reads everything from the chain, so nothing carries over from this one.
            console.error(`round ${round} failed: ${String(e.shortMessage || e.message || e)}`);
        }
        await new Promise((r) => setTimeout(r, interval * 1000));
    }
}

async function main() {
    if (process.argv.includes('--watch')) return watch();
    await tick();
}

// Only run when invoked directly. Importing this file — a test does, and so could any other
// tool — must not fire off the whole flow as a side effect of loading it.
if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage || e.message || e));
        process.exit(1);
    });
}
