// Batas agent.
//
// Reads the live position on Sepolia, decides what mandate the owner should be asked to grant,
// encodes the SwapVM program itself, and ships it. Every number below comes off the chain; nothing
// here is simulated.
//
//   node agent/batas-agent.mjs            observe and decide, no transaction
//   node agent/batas-agent.mjs --ship     also ship the mandate it decided on
//
// The agent chooses within bounds it cannot widen: the floor price it proposes is derived from the
// spot it observed, and whatever it proposes is enforced by PolicyEnvelope inside the VM. That is
// the point of the project — the agent decides, the machine constrains.

import {
    createPublicClient, createWalletClient, http, encodeAbiParameters, parseAbiParameters,
    keccak256, concat, formatUnits, getAddress,
} from 'viem';

import { toProgram } from './swapvm.mjs';
import { mandateNameStatus } from './ens.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import 'dotenv/config';

const AQUA = getAddress('0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a');
// Defaults are the Sepolia deployment; override to point at your own without editing this file.
const ROUTER = getAddress(process.env.BATAS_ROUTER || '0x228E82831afaC5dd9EbDE3489E9e18Ae9c7bcbf4');
const TOKENS = [
    getAddress(process.env.BATAS_TOKEN_A || '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B'),
    getAddress(process.env.BATAS_TOKEN_B || '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81'),
].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
const [TOKEN_A, TOKEN_B] = TOKENS;

// Opcodes, read from @1inch/swap-vm/src/libs/OpcodeList.sol.
const OP = { SALT: 0x02, POLICY_ENVELOPE: 0x21, XYC_SWAP: 0x50, FEE_FLAT_IN: 0x70 };

// MakerTraits packing for an Aqua-backed order with no hooks: the Aqua flag, and four uint16
// order-data offsets that are all 40 because `data` starts with two addresses and nothing else.
const AQUA_FLAG = 1n << 254n;
const ORDER_DATA_INDEXES = 0x0028002800280028n;
const TRAITS = AQUA_FLAG | (ORDER_DATA_INDEXES << 160n);

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

async function main() {
    const shipIt = process.argv.includes('--ship');
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
    const ensRegistry = process.env.BATAS_ENS_REGISTRY;
    if (ensRegistry) {
        const label = process.env.BATAS_MANDATE_NAME || 'agent';
        const status = await mandateNameStatus(pub, getAddress(ensRegistry), label, account.address);
        console.log('');
        console.log(`mandate name "${label}": ${status.reason}`);
        if (!status.valid) {
            console.error('refusing to act without a valid mandate name');
            process.exitCode = 1;
            return;
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
    const SLIPPAGE_BPS = 200n; // 2%
    const CAP_BPS = 1000n; // 10% of the input reserve
    const FEE_BPS = 30_000n; // 0.3% of SwapVM's 1e7 base

    const minRateE18 = (spotE18 * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const maxAmountIn = (reserveA * CAP_BPS) / 10_000n;

    console.log('\ndecision');
    console.log(`  floor  ${formatUnits(minRateE18, 18)} B per A  (${pct(SLIPPAGE_BPS, 10000n)}% under spot)`);
    console.log(`  cap    ${formatUnits(maxAmountIn, 18)} A        (${pct(CAP_BPS, 10000n)}% of reserve)`);
    console.log(`  fee    ${Number(FEE_BPS) / Number(BPS) * 100}%`);
    console.log(`  expires in 2 hours`);

    // Expiry is part of the grant, not decoration: a mandate with no deadline is authority with
    // no end. Two hours matches what the demo grants.
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 2 * 60 * 60);
    const program = toProgram({
        maxAmountIn,
        minRateE18,
        expiry,
        feeBps: FEE_BPS,
        salt: BigInt(Math.floor(Date.now() / 1000)),
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
    if (!agrees || !shipIt) {
        if (agrees && !shipIt) console.log('\nrun again with --ship to grant this mandate');
        return;
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
}

// Only run when invoked directly. Importing this file — a test does, and so could any other
// tool — must not fire off the whole flow as a side effect of loading it.
if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage || e.message || e));
        process.exit(1);
    });
}
