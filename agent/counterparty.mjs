// The other agent. The one deciding whether to trust this position.
//
//   node agent/counterparty.mjs                 decide about the live position
//   node agent/counterparty.mjs --program 0x…   decide about a program you were handed
//   node agent/counterparty.mjs --paranoid      insist on knowing the operator, and pay for it
//   node agent/counterparty.mjs --trade         and act on the verdict: actually take the trade
//
// Everything else in this repository is the maker's side: an agent that runs a position under terms
// it cannot exceed. This is the counterparty — a different agent, with its own money and its own
// rules, arriving at a position it did not create and deciding whether to trade against it.
//
// It exists because "sold per call over x402" is a claim about a transaction between two machines,
// and until now only one of those machines was in the repository. A CLI a person runs to buy an
// answer demonstrates the payment. It does not demonstrate the decision, and the decision is the
// part worth showing: three of the four questions cost nothing, so an agent can walk away for free
// from a position it does not like, and pays only when the free evidence was good and the remaining
// doubt is worth a tenth of a cent to settle.
//
// Nothing here is discovered from this repository. The endpoint, the price and the network are read
// from the host's own `/.well-known/x402` manifest, the way an indexer or a stranger's agent would.

import 'dotenv/config';
import { createPublicClient, createWalletClient, http, formatUnits, decodeAbiParameters, parseAbiParameters, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { payForExplanation, latestProgramOnChain } from './inspect.mjs';
import { ROUTER, TOKEN_A, TOKEN_B } from './deployment.mjs';
import { feedbackFromTrade, giveFeedback, readReputation } from './reputation.mjs';

const ORIGIN = process.env.BATAS_SERVICE_URL?.replace(/\/v1\/.*$/, '') || 'https://batas-one.vercel.app';

/** What this counterparty will and will not trade against. Its rules, not the maker's. */
export const POLICY = {
    // A position whose terms could still be widened is not a position, it is a promise.
    requireGuarded: true,
    // A grant nobody can end early is one this counterparty declines to be the exit liquidity for.
    requireKillSwitch: true,
    // Terms published a minute ago are terms someone just wrote. Below this age the counterparty
    // wants the operator's identity before it trades, and will pay for it.
    freshPublicationSeconds: 3600,
};

/**
 * Everything wrong with this position, in the counterparty's opinion.
 *
 * Pure, and separate from the three fetches that feed it, because this is the only part worth
 * arguing with — and logic that can only be exercised by making three network calls against a live
 * chain does not get exercised. Empty means nothing free disqualified the position; it does not
 * mean trade, which is the next decision and a different one.
 */
export function doubtsAbout({ decoded, publication, authority }, policy = POLICY) {
    const m = decoded?.mandate ?? {};
    const doubts = [];

    if (policy.requireGuarded && !decoded?.guarded) {
        doubts.push('the policy guard is not outermost, so later instructions could undo it');
    }
    if (!m.minRateE18) doubts.push('no floor price: this position will settle at any rate');
    if (!m.maxAmountInFormatted) doubts.push('no size cap: one trade may take the whole reserve');
    if (!m.expiryISO) doubts.push('no deadline: this authority never ends on its own');
    if (policy.requireKillSwitch && !m.killSwitch) {
        doubts.push('no on-chain kill switch: only the expiry and the maker docking can end this');
    }
    if (publication?.published === null || publication?.searched === 'incomplete') {
        // Not the same doubt as "no record". The mirror walk ran out of pages, so the honest thing
        // to say is that the question is open — a counterparty told "unpublished" by a lookup that
        // gave up has been handed a finding that was never made.
        doubts.push(`the publication question is unanswered: ${publication.reason ?? 'the lookup did not finish'}`);
    } else if (!publication?.published) {
        doubts.push('these exact bytes have no publication record: they could have been written a minute ago');
    }
    if (!authority?.valid) {
        doubts.push(`the agent's authority is gone: ${authority?.reason ?? 'the name does not hold'}`);
    }
    return doubts;
}

const SWAP_ABI = [
    {
        name: 'swap', type: 'function', stateMutability: 'payable',
        inputs: [
            { name: 'order', type: 'tuple', components: [
                { name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' },
            ] },
            { name: 'amount', type: 'uint256' },
            { name: 'takerData', type: 'bytes' },
        ],
        outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
    },
];
const ERC20_ABI = [
    { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
    { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    { name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
];

// The plainest taker data there is: exactIn, no threshold, recipient equal to the taker, no hooks.
// `TakerTraitsLib.build` lays that out as ten zero slice indexes followed by the flag word, and
// 0x00e1 is exactIn | firstTransferFromTaker | transferFromAndAquaPush | aToB. Hand-packed only
// because it is degenerate; anything with a slice in it belongs in the Solidity builder.
const TAKER_DATA = `0x${'00'.repeat(20)}00e1`;

const say = (label, value) => console.log(`  ${label.padEnd(14)}${value}`);
const head = (n, title) => console.log(`\n${n}. ${title}\n${'─'.repeat(60)}`);

async function getJson(url, init) {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `${url} answered ${res.status}`);
    return body;
}

/**
 * Find the service the way something that has never heard of it would.
 *
 * The manifest is the whole point of publishing one: an agent learns that this host takes payment,
 * what it sells and what it costs, without being told the URL of the paid route first. Reading it
 * here rather than hard-coding the endpoint is what makes this a counterparty rather than a client
 * somebody wired up.
 */
async function discover() {
    const manifest = await getJson(`${ORIGIN}/.well-known/x402`);
    const resource = manifest.resources?.[0];
    if (!resource) throw new Error('the host publishes a manifest with no resources');
    const terms = resource.accepts?.[0];
    return {
        name: manifest.name,
        endpoint: resource.url,
        price: terms ? Number(terms.amount) / 1e8 : null,
        asset: terms?.asset,
        network: terms?.network,
    };
}

async function main() {
    const argv = process.argv.slice(2);
    const program = argv.includes('--program') ? argv[argv.indexOf('--program') + 1] : undefined;
    const paranoid = argv.includes('--paranoid');

    head(1, 'Find out what this host sells, without being told');
    const service = await discover();
    say('host', ORIGIN);
    say('sells', service.name);
    say('endpoint', service.endpoint);
    say('price', service.price === null ? 'unstated' : `${service.price} HBAR on ${service.network}`);

    const body = program ? { program } : {};

    head(2, 'What the bytes permit — free, so refusing costs nothing');
    const decoded = await getJson(`${ORIGIN}/v1/mandate/decode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const m = decoded.mandate;
    say('guarded', String(decoded.guarded));
    say('max input', m.maxAmountInFormatted ?? 'no cap');
    say('floor rate', m.minRateFormatted ?? 'no floor');
    say('expires', m.expiryISO ?? 'never');
    say('kill switch', m.killSwitch ? `"${m.killSwitch.label}" in ${m.killSwitch.registry}` : 'none');

    head(3, 'Whether the terms have been standing — free, and not from them');
    const pub = await getJson(`${ORIGIN}/v1/mandate/publication`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let ageSeconds = null;
    if (pub.published) {
        ageSeconds = Math.floor((Date.now() - Date.parse(pub.publishedAt)) / 1000);
        say('published', `${pub.publishedAt}  (${Math.floor(ageSeconds / 3600)}h ago)`);
        say('consensus', `topic ${pub.topic} #${pub.sequenceNumber}`);
    } else {
        say('published', `no — ${pub.reason ?? 'no record of these bytes'}`);
    }

    head(4, 'Whether the operator may still act — free');
    const authority = await getJson(`${ORIGIN}/v1/agent/authority`);
    say('name', `"${authority.label}"`);
    say('status', authority.valid ? 'live' : (authority.revoked ? 'revoked by the owner' : 'ended'));
    say('reason', authority.reason);

    head(5, 'The decision');
    const doubts = doubtsAbout({ decoded, publication: pub, authority });
    if (doubts.length > 0) {
        console.log('  walking away, having spent nothing:');
        for (const d of doubts) console.log(`    · ${d}`);
        console.log('\n  Three of the four questions are free, which is what makes this possible.');
        console.log('  A position worth declining should cost nothing to decline.');
        return;
    }

    console.log('  every free check passed.');
    const freshlyPublished = ageSeconds !== null && ageSeconds < POLICY.freshPublicationSeconds;
    if (!paranoid && !freshlyPublished) {
        console.log('  the terms are sound, the grant has been standing, and the name still holds.');
        console.log('\n  not paying: nothing is left that the operator\'s identity would change.');
        console.log('  run with --paranoid to buy the full answer anyway.');
        await act({ floorRateE18: m.minRateE18, feedbackURI: pub.mirror });
        return;
    }

    console.log(
        freshlyPublished
            ? `  but the grant is only ${ageSeconds}s old, and who is behind it now matters.`
            : '  --paranoid: buying the full answer regardless.',
    );
    console.log(`\n  paying ${service.price} HBAR for the operator's identity and whether it vouches …`);

    // `payForExplanation` returns the body alongside the settlement receipt, not the body itself.
    // Reading it as the body gave "agent not resolved" from an answer that had resolved the agent
    // perfectly — the paid call had worked and the reader had not.
    const { body: answer, settlement } = await payForExplanation(decoded.program, { log: (s) => console.log(`  ${s}`) });
    const operator = answer.operator;
    say('agent', operator?.agentId ? `#${operator.agentId}  ${operator.registration?.name ?? '(unnamed)'}` : 'not resolved');
    say('held by', operator?.owner ?? '—');
    say('vouches', operator?.check ? `${operator.check.vouched} — ${operator.check.reason}` : 'not checked');

    if (settlement) say('receipt', 'the payment is on Hedera, and the answer arrived with it');

    console.log('');
    if (operator?.check?.vouched) {
        console.log('  the identity operating this position is held by the address that granted it.');
        await act({ floorRateE18: m.minRateE18, feedbackURI: pub.mirror, agentId: operator?.agentId });
    } else {
        console.log('  the identity does not vouch for the maker. declining, and the tenth of a cent');
        console.log('  that established it was the cheapest part of this decision.');
        process.exitCode = 1;
    }
}

/**
 * Act on the verdict, or say plainly that it is not going to.
 *
 * This used to print "trading against it." and exit, which was a stub wearing the words of a
 * decision. Everything before it was real — the discovery, the three reads, a settled payment — and
 * then the agent that had just decided to trade did not trade.
 *
 * It needs its own key, and that is the point rather than an inconvenience: a counterparty signing
 * with the maker's key is the maker, and a demonstration of two agents that shares one wallet is a
 * demonstration of one. Without `BATAS_COUNTERPARTY_KEY` it advises and says so.
 */
async function act({ floorRateE18, feedbackURI, agentId } = {}) {
    if (!process.argv.includes('--trade')) {
        console.log('  it would trade. run with --trade to let it.');
        return;
    }
    const key = process.env.BATAS_COUNTERPARTY_KEY;
    if (!key) {
        console.log('  advising only: set BATAS_COUNTERPARTY_KEY to let this agent act on its verdict.');
        console.log("  a counterparty signing with the maker's key would be the maker.");
        return;
    }

    const account = privateKeyToAccount(key);
    const transport = http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com');
    const pub = createPublicClient({ chain: sepolia, transport });
    const wallet = createWalletClient({ account, chain: sepolia, transport });

    const shipped = await latestProgramOnChain();
    if (!shipped) throw new Error('the position went away between deciding and acting');
    const [order] = decodeAbiParameters(
        parseAbiParameters('(address maker, uint256 traits, bytes data)'),
        shipped.strategy,
    );

    const amountIn = 10n ** 18n;
    console.log(`\n  acting as ${account.address}`);

    // No minting. The first version tried, and `TokenMock.mint` is owner-only — it reverted with
    // `OwnableUnauthorizedAccount`, which was the contract making the right point: these are the
    // maker's tokens, and a counterparty that could conjure the input side would not be a
    // counterparty. It arrives with its own inventory or it does not trade.
    const held = await pub.readContract({ address: TOKEN_A, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
    if (held < amountIn) {
        console.log(`  holds     ${formatUnits(held, 18)} A, needs ${formatUnits(amountIn, 18)}`);
        console.log('  not trading: a counterparty brings its own side of the trade.');
        console.log('  for the demo, have the maker send this address some tokenA first.');
        return;
    }
    say('holds', `${formatUnits(held, 18)} A`);

    // The router, not Aqua: `useTransferFromAndAquaPush` means the router pulls the input from the
    // taker and pushes it to Aqua itself.
    const approve = await wallet.writeContract({ address: TOKEN_A, abi: ERC20_ABI, functionName: 'approve', args: [getAddress(ROUTER), amountIn * 10n] });
    await pub.waitForTransactionReceipt({ hash: approve });

    const before = await pub.readContract({ address: TOKEN_B, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
    const { request } = await pub.simulateContract({
        account, address: getAddress(ROUTER), abi: SWAP_ABI, functionName: 'swap',
        args: [order, amountIn, TAKER_DATA],
    });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const after = await pub.readContract({ address: TOKEN_B, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });

    say('traded', `${formatUnits(amountIn, 18)} A in`);
    say('received', `${formatUnits(after - before, 18)} B`);
    say('status', `${receipt.status}  https://sepolia.etherscan.io/tx/${hash}`);
    console.log('\n  the mandate priced that trade, and would have refused a different one.');

    await review({ account, received: after - before, amountIn, floorRateE18, feedbackURI, agentId });
}

/**
 * Say so on chain, in ERC-8004's reputation registry.
 *
 * The registry refuses feedback from the agent's own owner or operators, which is the property that
 * makes any of it worth reading — and the reason this could not exist until the counterparty had a
 * wallet of its own. A maker praising their own agent is not a reputation system.
 *
 * What gets written is not a rating. It is how far above its advertised floor the trade actually
 * settled, in basis points, with the Hedera publication record as the URI: two numbers both parties
 * hold and a pointer to the evidence, so a reader can redo the arithmetic instead of trusting it.
 */
async function review({ account, received, amountIn, floorRateE18, feedbackURI, agentId }) {
    if (!floorRateE18) {
        console.log('  no floor to score the trade against; leaving no feedback.');
        return;
    }
    const settledRateE18 = (received * 10n ** 18n) / amountIn;
    const score = feedbackFromTrade({ settledRateE18, floorRateE18 });

    console.log(`\n  leaving feedback: ${score.bps}bps above the floor, tagged ${score.tag2}`);
    try {
        const written = await giveFeedback({
            ...(agentId ? { agentId } : {}),
            value: score.value,
            valueDecimals: score.valueDecimals,
            tag1: score.tag1,
            tag2: score.tag2,
            endpoint: ORIGIN,
            feedbackURI: feedbackURI ?? '',
        });
        say('feedback', `${written.status}  https://sepolia.etherscan.io/tx/${written.hash}`);
        const now = await readReputation(agentId);
        say('reputation', `${now.count} client(s), summary ${now.summaryValue}`);
    } catch (e) {
        // The trade happened. Failing to review it is a smaller thing than pretending the trade
        // did not settle, so it is reported and the run stands.
        console.log(`  could not leave feedback: ${String(e.shortMessage ?? e.message ?? e)}`);
    }
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage ?? e.message ?? e));
        process.exitCode = 1;
    });
}
