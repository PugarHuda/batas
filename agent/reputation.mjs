// ERC-8004's second registry, and the one this project had no business skipping.
//
//   node agent/reputation.mjs --read 10123      what clients have said about this agent
//
// The identity registry answers *who is operating this position*. It cannot answer whether anyone
// has traded against them and been treated well, and until now this project registered an identity,
// read it back, and stopped — using one third of a standard whose other two thirds are the part
// about trust.
//
// The reputation registry refuses feedback from the agent's own owner or operators:
//
//     require(!isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed");
//
// which is the property that makes the signal worth reading, and the reason this only became
// possible once `counterparty.mjs` had a wallet of its own. A maker praising their own agent is not
// a reputation system, and the contract says so.
//
// The Validation Registry is deliberately absent. The canonical repository does not list one for
// Sepolia — it is "still under active update and discussion with the TEE community" — and pointing
// at an address for it would be inventing a deployment.

import 'dotenv/config';
import { createPublicClient, createWalletClient, http, getAddress, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { REPUTATION_REGISTRY, AGENT_ID } from './deployment.mjs';

export const REGISTRY_ABI = [
    {
        name: 'giveFeedback', type: 'function', stateMutability: 'nonpayable',
        inputs: [
            { name: 'agentId', type: 'uint256' },
            { name: 'value', type: 'int128' },
            { name: 'valueDecimals', type: 'uint8' },
            { name: 'tag1', type: 'string' },
            { name: 'tag2', type: 'string' },
            { name: 'endpoint', type: 'string' },
            { name: 'feedbackURI', type: 'string' },
            { name: 'feedbackHash', type: 'bytes32' },
        ],
        outputs: [],
    },
    {
        name: 'getSummary', type: 'function', stateMutability: 'view',
        inputs: [
            { name: 'agentId', type: 'uint256' },
            { name: 'clientAddresses', type: 'address[]' },
            { name: 'tag1', type: 'string' },
            { name: 'tag2', type: 'string' },
        ],
        outputs: [
            { name: 'count', type: 'uint64' },
            { name: 'summaryValue', type: 'int128' },
            { name: 'summaryValueDecimals', type: 'uint8' },
        ],
    },
    {
        name: 'getClients', type: 'function', stateMutability: 'view',
        inputs: [{ name: 'agentId', type: 'uint256' }],
        outputs: [{ type: 'address[]' }],
    },
    {
        name: 'getIdentityRegistry', type: 'function', stateMutability: 'view',
        inputs: [], outputs: [{ type: 'address' }],
    },
];

const publicClient = () => createPublicClient({
    chain: sepolia,
    transport: http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'),
});

/**
 * Turn a settled trade into a feedback record that says something checkable.
 *
 * Not a star rating. A number nobody can verify is a number nobody should weigh, and "four out of
 * five" about an autonomous market maker means nothing at all. What a counterparty genuinely knows
 * after trading is whether the position honoured the floor it advertised, and by how much — which
 * is arithmetic on two numbers both parties hold, and which anyone can redo from the transaction.
 *
 * Basis points above the floor, so the scale is stated by the unit rather than by convention. A
 * trade settled exactly on the floor scores 0: the mandate was honoured and nothing was given away.
 * Below it scores negative, and should be impossible — the contracts refuse it — so a negative
 * reading is a claim that something in this system failed, not a complaint about service.
 */
export function feedbackFromTrade({ settledRateE18, floorRateE18 }) {
    const settled = BigInt(settledRateE18);
    const floor = BigInt(floorRateE18);
    if (floor <= 0n) throw new Error('a position with no floor cannot be scored against one');
    if (settled <= 0n) throw new Error('a trade that settled at zero is not a trade');

    const bps = ((settled - floor) * 10_000n) / floor;
    return {
        value: bps,
        valueDecimals: 0,
        tag1: 'batas.mandate',
        tag2: bps >= 0n ? 'floor-honoured' : 'floor-breached',
        bps,
    };
}

/** Leave feedback, as somebody who is not the agent. */
export async function giveFeedback({
    agentId = AGENT_ID,
    value,
    valueDecimals = 0,
    tag1,
    tag2,
    endpoint = '',
    feedbackURI = '',
    feedbackHash,
    key = process.env.BATAS_COUNTERPARTY_KEY,
}) {
    if (!key) throw new Error('feedback needs a key that is not the agent\'s; set BATAS_COUNTERPARTY_KEY');
    const account = privateKeyToAccount(key);
    const transport = http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com');
    const pub = createPublicClient({ chain: sepolia, transport });
    const wallet = createWalletClient({ account, chain: sepolia, transport });

    const { request } = await pub.simulateContract({
        account,
        address: getAddress(REPUTATION_REGISTRY),
        abi: REGISTRY_ABI,
        functionName: 'giveFeedback',
        args: [
            BigInt(agentId), value, valueDecimals, tag1, tag2, endpoint, feedbackURI,
            feedbackHash ?? keccak256(toHex(`${tag1}:${tag2}:${value}`)),
        ],
    });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status, from: account.address };
}

/** What everyone has said, and who said it. */
export async function readReputation(agentId = AGENT_ID, { tag1 = '', tag2 = '', client } = {}) {
    const pub = client ?? publicClient();
    const address = getAddress(REPUTATION_REGISTRY);
    const clients = await pub.readContract({
        address, abi: REGISTRY_ABI, functionName: 'getClients', args: [BigInt(agentId)],
    });
    // `getSummary` reverts on an empty client list rather than returning a zero summary, so an
    // agent nobody has reviewed yet is answered here instead of through a failed call. "Nobody has
    // said anything" is a real state and the commonest one; making the caller catch a revert to
    // learn it would be the library's problem becoming everyone's.
    if (clients.length === 0) {
        return {
            registry: address, agentId: String(agentId), clients: [],
            count: 0, summaryValue: '0', summaryValueDecimals: 0,
        };
    }

    const [count, summaryValue, summaryValueDecimals] = await pub.readContract({
        address, abi: REGISTRY_ABI, functionName: 'getSummary', args: [BigInt(agentId), clients, tag1, tag2],
    });
    return {
        registry: address,
        agentId: String(agentId),
        clients: [...clients],
        count: Number(count),
        summaryValue: summaryValue.toString(),
        summaryValueDecimals: Number(summaryValueDecimals),
    };
}

async function main() {
    const argv = process.argv.slice(2);
    const at = argv.indexOf('--read');
    const agentId = at === -1 ? AGENT_ID : (argv[at + 1] || AGENT_ID);

    const r = await readReputation(agentId);
    console.log(`agent #${r.agentId} in ${r.registry}`);
    console.log(`  clients  ${r.count}`);
    if (r.count === 0) {
        console.log('  nobody has traded against this agent and said so yet.');
        console.log('  the registry refuses feedback from the agent itself, so this can only be filled');
        console.log('  by somebody else — run agent/counterparty.mjs --trade with its own key.');
        return;
    }
    console.log(`  summary  ${r.summaryValue} (${r.summaryValueDecimals} decimals)`);
    for (const c of r.clients) console.log(`    ${c}`);
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage ?? e.message ?? e));
        process.exitCode = 1;
    });
}
