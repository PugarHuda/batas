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
import { createPublicClient, createWalletClient, http, getAddress, keccak256, toHex, formatUnits, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { REPUTATION_REGISTRY, AGENT_ID, SEPOLIA_RPC } from './deployment.mjs';
import { IDENTITY_REGISTRY, REGISTRY_ABI as IDENTITY_ABI, parseAgentId } from './erc8004.mjs';

// The tag this project's counterparty writes its measured score under.
export const MANDATE_TAG = 'batas.mandate';

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
        name: 'readAllFeedback', type: 'function', stateMutability: 'view',
        inputs: [
            { name: 'agentId', type: 'uint256' },
            { name: 'clientAddresses', type: 'address[]' },
            { name: 'tag1', type: 'string' },
            { name: 'tag2', type: 'string' },
            { name: 'includeRevoked', type: 'bool' },
        ],
        outputs: [
            { name: 'clients', type: 'address[]' },
            { name: 'feedbackIndexes', type: 'uint64[]' },
            { name: 'values', type: 'int128[]' },
            { name: 'valueDecimals', type: 'uint8[]' },
            { name: 'tag1s', type: 'string[]' },
            { name: 'tag2s', type: 'string[]' },
            { name: 'revokedStatuses', type: 'bool[]' },
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
    transport: http(SEPOLIA_RPC),
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
    const transport = http(SEPOLIA_RPC);
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

/**
 * Which of an agent's feedback entries a summary should count.
 *
 * Revoked entries are out, because the spec takes them out of every summary and a client who
 * withdrew a claim has not made it. So is anything left by the identity's own owner or its agent
 * wallet: the registry refuses feedback from the owner at the moment it is given, but an identity
 * that later changes hands to a former reviewer would otherwise go on counting its new holder's
 * praise. Excluded entries are counted, not hidden, so a reader can see what was set aside.
 */
export function tallyFeedback(feedback, { tag1 = '', tag2 = '' } = {}) {
    const matching = feedback.filter((f) => (!tag1 || f.tag1 === tag1) && (!tag2 || f.tag2 === tag2));
    const counted = matching.filter((f) => !f.revoked && !f.self);
    return {
        counted,
        clients: [...new Set(counted.map((f) => f.client))],
        revokedCount: matching.filter((f) => f.revoked).length,
        selfFeedbackCount: matching.filter((f) => f.self && !f.revoked).length,
    };
}

/**
 * What counterparties have said, and who said it.
 *
 * Averaged over one tag, `batas.mandate` unless asked otherwise. A registry summary averages whatever
 * it is handed, and the counterparty leaves a `starred` 0-or-100 record beside every basis-point
 * record for explorers to aggregate. The untagged average of the two came out at 106 on the live
 * agent and was printed everywhere as "bps above the floor", while the basis-point records alone
 * averaged 108 — a unit error in the one number the page shows. Pass `tag1: ''` for the mixed
 * average, knowingly.
 */
export async function readReputation(agentId = AGENT_ID, { tag1 = MANDATE_TAG, tag2 = '', client } = {}) {
    const id = parseAgentId(agentId);
    if (id === null) throw new Error('agentId must be a non-negative integer');
    const pub = client ?? publicClient();
    const address = getAddress(REPUTATION_REGISTRY);
    const clients = await pub.readContract({
        address, abi: REGISTRY_ABI, functionName: 'getClients', args: [id],
    });
    // `getSummary` reverts on an empty client list rather than returning a zero summary, so an
    // agent nobody has reviewed yet is answered here instead of through a failed call. "Nobody has
    // said anything" is a real state and the commonest one; making the caller catch a revert to
    // learn it would be the library's problem becoming everyone's.
    const nothing = {
        registry: address, agentId: id.toString(), tag1, tag2, clients: [],
        feedbackCount: 0, clientCount: 0, summaryValue: '0', summaryValueDecimals: 0, summary: '0',
        revokedCount: 0, selfFeedbackCount: 0, feedback: [],
    };
    if (clients.length === 0) return nothing;

    // Read failures here propagate rather than default: an agent with clients must be registered,
    // and quietly skipping the self check would put the owner's own words back into the average.
    const [owner, wallet, all] = await Promise.all([
        pub.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [id] }),
        pub.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: 'getAgentWallet', args: [id] }),
        pub.readContract({ address, abi: REGISTRY_ABI, functionName: 'readAllFeedback', args: [id, clients, '', '', true] }),
    ]);
    const self = new Set([owner, wallet].filter((a) => a && a !== zeroAddress).map((a) => a.toLowerCase()));
    const [who, indexes, values, decimals, tag1s, tag2s, revoked] = all;
    const feedback = who.map((c, i) => ({
        client: getAddress(c), index: Number(indexes[i]),
        value: values[i].toString(), valueDecimals: Number(decimals[i]),
        tag1: tag1s[i], tag2: tag2s[i], revoked: revoked[i], self: self.has(c.toLowerCase()),
    }));
    const tally = tallyFeedback(feedback, { tag1, tag2 });
    if (tally.clients.length === 0) return { ...nothing, revokedCount: tally.revokedCount, selfFeedbackCount: tally.selfFeedbackCount, feedback };

    // The average itself is still the registry's: it normalises mixed `valueDecimals`, and doing
    // that arithmetic here would be a second opinion on a number the contract already states.
    const [count, summaryValue, summaryValueDecimals] = await pub.readContract({
        address, abi: REGISTRY_ABI, functionName: 'getSummary', args: [id, tally.clients, tag1, tag2],
    });
    // Two different numbers, and calling both of them `count` is how the first version printed
    // "2 client(s)" for one address that had left feedback twice. `getSummary` counts entries;
    // the client list counts addresses. An agent reviewed ten times by one counterparty and one
    // reviewed once by ten are not the same reputation, and a single field cannot say which.
    return {
        registry: address,
        agentId: id.toString(),
        tag1,
        tag2,
        clients: tally.clients,
        feedbackCount: Number(count),
        clientCount: tally.clients.length,
        summaryValue: summaryValue.toString(),
        summaryValueDecimals: Number(summaryValueDecimals),
        // `summaryValue` alone is a fixed-point integer; this is the number it stands for.
        summary: formatUnits(summaryValue, Number(summaryValueDecimals)),
        revokedCount: tally.revokedCount,
        selfFeedbackCount: tally.selfFeedbackCount,
        feedback,
    };
}

async function main() {
    const argv = process.argv.slice(2);
    const at = argv.indexOf('--read');
    const agentId = at === -1 ? AGENT_ID : (argv[at + 1] || AGENT_ID);

    const r = await readReputation(agentId);
    console.log(`agent #${r.agentId} in ${r.registry}`);
    console.log(`  feedback ${r.feedbackCount} tagged ${r.tag1} from ${r.clientCount} client(s), `
        + `${r.feedback.length} entries in all, ${r.revokedCount} revoked, ${r.selfFeedbackCount} from the agent itself`);
    if (r.feedbackCount === 0) {
        console.log('  nobody has traded against this agent and said so yet.');
        console.log('  the registry refuses feedback from the agent itself, so this can only be filled');
        console.log('  by somebody else — run agent/counterparty.mjs --trade with its own key.');
        return;
    }
    console.log(`  summary  ${r.summary}bps above the floor`);
    for (const c of r.clients) console.log(`    ${c}`);
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage ?? e.message ?? e));
        process.exitCode = 1;
    });
}
