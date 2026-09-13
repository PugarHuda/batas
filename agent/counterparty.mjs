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
// Nothing here is discovered from this repository. The host comes out of the ERC-8004 identity
// registry — agent #10123's own registration names its x402 endpoint — and the price, network and
// payee from that host's `/.well-known/x402` manifest, which has to agree with what the registry
// says before anything is called. BATAS_SERVICE_URL, when set, skips the registry, and the run says so.

import 'dotenv/config';
import { createPublicClient, createWalletClient, http, formatUnits, decodeAbiParameters, parseAbiParameters, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { payForExplanation, latestProgramOnChain, programFromStrategy } from './inspect.mjs';
import { explain } from './swapvm.mjs';
import { tryQuote } from './killswitch.mjs';
import { AQUA, OWNER, ROUTER, TOKEN_A, TOKEN_B, SEPOLIA_RPC, AGENT_ID } from './deployment.mjs';
import { resolveAgent, IDENTITY_REGISTRY } from './erc8004.mjs';
import { keccak256, toHex, parseUnits } from 'viem';
import { feedbackFromTrade, giveFeedback, readReputation } from './reputation.mjs';

// Set by `discover`. Module-level because `review` names the same host in the feedback it writes.
let ORIGIN;
const E18 = 10n ** 18n;

/**
 * The counterparty's own reference price, if it has one. `BATAS_COUNTERPARTY_MIN_RATE` is B per A:
 * a decimal ("1.95") or, without a point, already scaled to 1e18. Absent means the counterparty
 * has no view of the market and only holds the floor against the position's own spot.
 */
export function minRateFromEnv(value = process.env.BATAS_COUNTERPARTY_MIN_RATE) {
    if (!value) return null;
    return value.includes('.') ? parseUnits(value, 18) : BigInt(value);
}

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
export function doubtsAbout({
    decoded, local, publication, authority, spotE18 = null, minRateE18 = null, quoteE18 = null, docked = false, nowMs = Date.now(),
}, policy = POLICY) {
    // The chain's reading wins when the counterparty has one. The server's answer is then a claim
    // to be checked, not a source.
    const m = (local ?? decoded)?.mandate ?? {};
    const doubts = [];

    // Both of these used to pass. A docked position still decodes to sound terms, and an expired
    // one still carries a deadline — so "has a deadline" was checked and "the deadline is behind
    // us" was not, and the counterparty walked on to trade against terms that authorise nothing.
    // Either party's word on the dock is enough: nobody docks a position by mistake.
    if (docked || decoded?.docked) doubts.push('the maker has docked this position: nothing is on offer');
    // Past the expiry second, not at it — `Deadline` is `block.timestamp <= deadline`.
    if (m.expiryISO && nowMs >= Date.parse(m.expiryISO) + 1000) {
        doubts.push(`the deadline passed at ${m.expiryISO}: this position authorises nothing`);
    }

    if (local !== undefined && terms(local) !== terms(decoded)) {
        doubts.push('the service describes bytes the chain does not carry');
    }
    if (policy.requireGuarded && !(local ?? decoded)?.guarded) {
        doubts.push('the policy guard is not outermost, so later instructions could undo it');
    }
    if (!m.minRateE18) doubts.push('no floor price: this position will settle at any rate');
    if (!m.maxAmountInFormatted) doubts.push('no size cap: one trade may take the whole reserve');
    if (!m.expiryISO) doubts.push('no deadline: this authority never ends on its own');
    if (policy.requireKillSwitch && !m.killSwitch) {
        doubts.push('no on-chain kill switch: only the expiry and the maker docking can end this');
    }
    // A floor is only protection if it sits near the price. The maker's own agent never strikes
    // one more than 10% under spot, so a floor further down than that is either stale or written
    // by someone who wanted room — and either way it bounds nothing this counterparty cares about.
    if (m.minRateE18 && spotE18 !== null && BigInt(m.minRateE18) * 10n < spotE18 * 9n) {
        doubts.push("the floor sits more than 10% under the position's own spot");
    }
    if (minRateE18 !== null) {
        if (quoteE18 === null) doubts.push('the position gave no quote for 1 A, so the minimum rate cannot be checked');
        else if (quoteE18 < minRateE18) doubts.push(`1 A quotes ${formatUnits(quoteE18, 18)} B, under this counterparty's minimum of ${formatUnits(minRateE18, 18)}`);
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

/** The five terms a counterparty trades on, as one comparable string. Casing is not a term. */
function terms(d) {
    const m = d?.mandate ?? {};
    const k = m.killSwitch;
    return JSON.stringify([
        Boolean(d?.guarded), m.minRateE18 ?? null, m.maxAmountInFormatted ?? null, m.expiryISO ?? null,
        k ? [k.registry?.toLowerCase(), k.holder?.toLowerCase(), k.label] : null,
    ]);
}

/**
 * Whether the paid answer is worth its price.
 *
 * Separate from `doubtsAbout` because it is a different decision: that one is "is anything wrong",
 * this one is "is anything left that money would settle". With a doubt standing there is nothing
 * to buy — the position is already declined. With none, the operator's identity only matters when
 * the terms are too new to have earned trust on their own, or when the counterparty says so.
 */
export function shouldPay(doubts, { ageSeconds = null, paranoid = false } = {}, policy = POLICY) {
    if (doubts.length > 0) return { pay: false, reason: 'declined for free; nothing left to buy' };
    if (paranoid) return { pay: true, reason: '--paranoid: buying the full answer regardless' };
    if (ageSeconds !== null && ageSeconds < policy.freshPublicationSeconds) {
        return { pay: true, reason: `the grant is only ${ageSeconds}s old, and who is behind it now matters` };
    }
    return { pay: false, reason: "nothing is left that the operator's identity would change" };
}

const AQUA_ABI = [{
    name: 'safeBalances', type: 'function', stateMutability: 'view',
    inputs: [
        { name: 'maker', type: 'address' }, { name: 'app', type: 'address' },
        { name: 'strategyHash', type: 'bytes32' }, { name: 'token0', type: 'address' },
        { name: 'token1', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
}];

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
export async function discover({ override = process.env.BATAS_SERVICE_URL, agentId = AGENT_ID } = {}) {
    if (override) {
        const origin = override.replace(/\/v1\/.*$/, '').replace(/\/$/, '');
        const manifest = await getJson(`${origin}/.well-known/x402`);
        const resource = manifest.resources?.[0];
        if (!resource) throw new Error('the host publishes a manifest with no resources');
        return { via: 'BATAS_SERVICE_URL', origin, ...summarise(manifest, resource) };
    }
    return discoverFromRegistry(agentId);
}

const METADATA_ABI = [{
    name: 'getMetadata', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }, { name: 'metadataKey', type: 'string' }],
    outputs: [{ type: 'bytes' }],
}];

/**
 * Find the service from the agent's identity, not from a URL somebody configured.
 *
 * A configured host is a host the caller already trusted. The registry is where an agent that has
 * never heard of this one would look: the token's registration names its x402 endpoint, and the
 * on-chain metadata names the network and the Hedera account payments go to. The manifest is then
 * fetched from that endpoint's host and has to repeat both. A host serving a manifest that pays an
 * account the identity never named is not the agent, whatever its URL looks like.
 */
export async function discoverFromRegistry(agentId = AGENT_ID, { rpcUrl = SEPOLIA_RPC } = {}) {
    const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
    const agent = await resolveAgent(agentId, { client });
    if (!agent.registered) throw new Error(`agent #${agentId} is not in the identity registry`);
    if (!agent.registrationCheck?.valid) {
        throw new Error(`agent #${agentId}'s registration does not check out: ${agent.registrationCheck?.issues?.join('; ') ?? agent.uriKind}`);
    }
    const [payTo, network] = await Promise.all(['batas.x402.payTo', 'batas.x402.network'].map(async (key) => {
        const hex = await client.readContract({
            address: IDENTITY_REGISTRY, abi: METADATA_ABI, functionName: 'getMetadata', args: [BigInt(agent.agentId), key],
        });
        return hex === '0x' ? null : Buffer.from(hex.slice(2), 'hex').toString('utf8');
    }));
    const endpoint = x402Endpoint(agent.registration);
    if (!endpoint) throw new Error(`agent #${agentId} advertises no x402 service`);
    const origin = new URL(endpoint).origin;
    const manifest = await getJson(`${origin}/.well-known/x402`);
    const check = checkDiscovery({ endpoint, metadata: { payTo, network }, manifest });
    if (!check.ok) throw new Error(`the manifest at ${origin} does not match agent #${agentId}: ${check.issues.join('; ')}`);
    return {
        via: `ERC-8004 agent #${agent.agentId}`, origin, agentId: agent.agentId, registered: { endpoint, payTo, network },
        ...summarise(manifest, check.resource),
    };
}

/** The http(s) endpoint an ERC-8004 registration lists for its x402 service, if it lists one. */
export function x402Endpoint(registration) {
    const s = (Array.isArray(registration?.services) ? registration.services : [])
        .find((x) => x?.name === 'x402' && typeof x.endpoint === 'string');
    return s && /^https?:\/\//.test(s.endpoint) ? s.endpoint : null;
}

/**
 * Whether a manifest is the service the identity describes.
 *
 * Pure, so each way of disagreeing is pinned by a test. The resource has to be the registered
 * endpoint itself, and every payment option it offers has to go to the registered account on the
 * registered network: one stray `accepts` entry is enough for a client that takes the first option
 * it supports to pay a stranger. Missing metadata is a failure, not a pass, because a check with
 * nothing to compare against has checked nothing.
 */
export function checkDiscovery({ endpoint, metadata = {}, manifest }) {
    const issues = [];
    const resource = (Array.isArray(manifest?.resources) ? manifest.resources : []).find((r) => r?.url === endpoint);
    if (!resource) {
        issues.push(`the manifest lists no resource at the registered endpoint ${endpoint}`);
        return { ok: false, issues };
    }
    if (!metadata.payTo) issues.push('the registry holds no batas.x402.payTo to check the manifest against');
    if (!metadata.network) issues.push('the registry holds no batas.x402.network to check the manifest against');
    const accepts = Array.isArray(resource.accepts) ? resource.accepts : [];
    if (accepts.length === 0) issues.push('the resource offers no way to pay');
    for (const a of accepts) {
        if (metadata.payTo && a?.payTo !== metadata.payTo) issues.push(`the manifest pays ${a?.payTo}, the registry names ${metadata.payTo}`);
        if (metadata.network && a?.network !== metadata.network) issues.push(`the manifest settles on ${a?.network}, the registry names ${metadata.network}`);
    }
    return { ok: issues.length === 0, issues, resource };
}

function summarise(manifest, resource) {
    const terms = resource.accepts?.[0];
    return {
        name: manifest.name,
        endpoint: resource.url,
        price: terms ? Number(terms.amount) / 1e8 : null,
        asset: terms?.asset,
        network: terms?.network,
        payTo: terms?.payTo,
    };
}

async function main() {
    const argv = process.argv.slice(2);
    const program = argv.includes('--program') ? argv[argv.indexOf('--program') + 1] : undefined;
    const paranoid = argv.includes('--paranoid');

    head(1, 'Find out what this host sells, without being told');
    const service = await discover();
    ORIGIN = service.origin;
    say('found via', service.via === 'BATAS_SERVICE_URL' ? 'BATAS_SERVICE_URL, set by hand; the registry was not consulted' : service.via);
    if (service.registered) say('registry', `x402 at ${service.registered.endpoint}, pays ${service.registered.payTo} on ${service.registered.network}`);
    if (service.registered) say('manifest', 'agrees with the registry on endpoint, payee and network');
    say('host', ORIGIN);
    say('sells', service.name);
    say('endpoint', service.endpoint);
    say('price', service.price === null ? 'unstated' : `metered, at most ${service.price} HBAR on ${service.network}`);

    const body = program ? { program } : {};

    head(2, 'What the bytes permit — free, so refusing costs nothing');
    const decoded = await getJson(`${ORIGIN}/v1/mandate/decode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    // And the same reading made here, from bytes the counterparty fetched itself. The server's
    // decode is the maker's server describing the maker's position; until this ran locally, the
    // agent was checking terms against the word of the party it was checking. Which position the
    // decision is about comes from the chain for the same reason — a hash the server supplied
    // pins the trade to whatever the server said, and "given" means the caller pasted bytes,
    // which are not a position and must not be acted on.
    let localProgram = program;
    let decidedHash = null;
    let spotE18 = null;
    let quoteE18 = null;
    let shipped = null;
    if (!program) {
        shipped = await latestProgramOnChain();
        if (!shipped) throw new Error('no position shipped to the live router yet');
        decidedHash = shipped.strategyHash;
        localProgram = programFromStrategy(shipped.strategy);
    }
    const docked = Boolean(shipped?.docked);
    // A docked strategy has no reserves to read — Aqua reverts — and no quote to give. Asking
    // anyway crashed the run on a revert, when the dock was itself the answer and a free one.
    if (shipped && !docked) {
        const chain = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
        const [reserveA, reserveB] = await chain.readContract({
            address: AQUA, abi: AQUA_ABI, functionName: 'safeBalances',
            args: [OWNER, ROUTER, shipped.strategyHash, TOKEN_A, TOKEN_B],
        });
        spotE18 = reserveA > 0n ? (reserveB * E18) / reserveA : null;
        const [order] = decodeAbiParameters(parseAbiParameters('(address maker, uint256 traits, bytes data)'), shipped.strategy);
        const quote = await tryQuote(order, E18);
        quoteE18 = quote.ok ? quote.amountOut : null;
    }
    const local = explain(localProgram);
    const m = local.mandate;
    say('guarded', String(local.guarded));
    say('max input', m.maxAmountInFormatted ?? 'no cap');
    say('floor rate', m.minRateFormatted ?? 'no floor');
    say('expires', m.expiryISO ?? 'never');
    say('kill switch', m.killSwitch ? `"${m.killSwitch.label}" in ${m.killSwitch.registry}` : 'none');
    say('server', terms(local) === terms(decoded) ? 'agrees with the bytes' : 'DISAGREES with the bytes');
    if (spotE18 !== null) say('spot', `${formatUnits(spotE18, 18)} B per A, from the live reserves`);
    if (!program) say('quote 1 A', quoteE18 === null ? 'refused' : `${formatUnits(quoteE18, 18)} B`);
    const minRateE18 = minRateFromEnv();
    if (minRateE18 !== null) say('my minimum', `${formatUnits(minRateE18, 18)} B per A`);

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
    const doubts = doubtsAbout({ decoded, local, publication: pub, authority, spotE18, minRateE18, quoteE18, docked });
    if (doubts.length > 0) {
        console.log('  walking away, having spent nothing:');
        for (const d of doubts) console.log(`    · ${d}`);
        console.log('\n  Three of the four questions are free, which is what makes this possible.');
        console.log('  A position worth declining should cost nothing to decline.');
        return;
    }

    console.log('  every free check passed.');
    const buy = shouldPay(doubts, { ageSeconds, paranoid });
    if (!buy.pay) {
        console.log('  the terms are sound, the grant has been standing, and the name still holds.');
        console.log(`\n  not paying: ${buy.reason}.`);
        console.log('  run with --paranoid to buy the full answer anyway.');
        await act({ floorRateE18: m.minRateE18, feedbackURI: pub.mirror, decidedHash });
        return;
    }

    console.log(`  but ${buy.reason}.`);
    console.log(`\n  paying the metered price, at most ${service.price} HBAR, for the operator's identity and whether it vouches …`);

    // `payForExplanation` returns the body alongside the settlement receipt, not the body itself.
    // Reading it as the body gave "agent not resolved" from an answer that had resolved the agent
    // perfectly — the paid call had worked and the reader had not.
    // Paid for against the bytes this agent holds, not the ones the server said it holds.
    const { body: answer, settlement } = await payForExplanation(localProgram, { origin: ORIGIN, log: (s) => console.log(`  ${s}`) });
    const operator = answer.operator;
    say('agent', operator?.agentId ? `#${operator.agentId}  ${operator.registration?.name ?? '(unnamed)'}` : 'not resolved');
    say('held by', operator?.owner ?? '—');
    say('vouches', operator?.check ? `${operator.check.vouched} — ${operator.check.reason}` : 'not checked');

    if (settlement) say('receipt', 'the payment is on Hedera, and the answer arrived with it');

    console.log('');
    if (operator?.check?.vouched) {
        console.log('  the identity operating this position is held by the address that granted it.');
        await act({ floorRateE18: m.minRateE18, feedbackURI: pub.mirror, agentId: operator?.agentId, decidedHash });
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
async function act({ floorRateE18, feedbackURI, agentId, decidedHash } = {}) {
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
    const transport = http(SEPOLIA_RPC);
    const pub = createPublicClient({ chain: sepolia, transport });
    const wallet = createWalletClient({ account, chain: sepolia, transport });

    const shipped = await latestProgramOnChain();
    if (!shipped) throw new Error('the position went away between deciding and acting');
    // The trade goes to the position the verdict was about, or nowhere. `act` used to swap against
    // whatever `latestProgramOnChain` returned — a renewal between deciding and acting, or a
    // `--program` decision about pasted bytes, sent the trade to a position nobody had judged, and
    // scored it against the wrong floor.
    if (!decidedHash) {
        console.log('  not trading: the verdict was about pasted bytes, not a shipped position.');
        console.log('  run without --program to decide about the live position and act on it.');
        return;
    }
    if (shipped.strategyHash.toLowerCase() !== decidedHash.toLowerCase()) {
        console.log(`  not trading: the live position is now ${shipped.strategyHash}`);
        console.log(`  and the verdict was about ${decidedHash}. decide again.`);
        return;
    }
    // The same position, closed since the verdict. The approve below would still be sent and the
    // swap would revert in simulation, spending gas to learn what one read already says.
    if (shipped.docked) {
        console.log('  not trading: the maker docked this position between deciding and acting.');
        return;
    }
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
        // The hash commits to what the URI serves. ERC-8004 says feedbackHash is the keccak of the
        // content at feedbackURI; the first version hashed a string of its own, which committed to
        // nothing a reader could fetch. Fetched once, hashed as bytes, or zero if unreachable —
        // a wrong hash is worse than none.
        let feedbackHash = `0x${'00'.repeat(32)}`;
        if (feedbackURI) {
            try {
                const body = await (await fetch(feedbackURI)).text();
                feedbackHash = keccak256(toHex(body));
            } catch { /* leave it zero: a URI we could not read is not one we can vouch for */ }
        }
        const written = await giveFeedback({
            ...(agentId ? { agentId } : {}),
            value: score.value,
            valueDecimals: score.valueDecimals,
            tag1: score.tag1,
            tag2: score.tag2,
            endpoint: ORIGIN,
            feedbackURI: feedbackURI ?? '',
            feedbackHash,
        });
        say('feedback', `${written.status}  https://sepolia.etherscan.io/tx/${written.hash}`);

        // And once more in the vocabulary explorers aggregate. `batas.mandate` is the honest
        // signal and it is what this counterparty actually measured; `starred` is what 8004scan
        // reads for its average, and an agent with real trades behind it should not show "no
        // ratings" because its reviewer used precise words.
        const starred = await giveFeedback({
            ...(agentId ? { agentId } : {}),
            value: score.bps >= 0n ? 100n : 0n,
            valueDecimals: 0,
            tag1: 'starred',
            tag2: score.tag2,
            endpoint: ORIGIN,
            feedbackURI: feedbackURI ?? '',
            feedbackHash,
        });
        say('starred', `${starred.status}  ${score.bps >= 0n ? 100 : 0}/100`);
        const now = await readReputation(agentId);
        say('reputation', `${now.feedbackCount} feedback from ${now.clientCount} client(s), `
            + `${now.summaryValue}bps above the floor on average`);
    } catch (e) {
        // The trade happened. Failing to review it is a smaller thing than pretending the trade
        // did not settle, so it is reported and the run stands.
        console.log(`  could not leave feedback: ${String(e.shortMessage ?? e.message ?? e)}`);
    }
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        // An exhausted scan is a statement about how far we looked, not about the chain; it is
        // printed as the message it already is rather than as a crash.
        console.error(e.scanExhausted ? e.message : String(e.shortMessage ?? e.message ?? e));
        process.exitCode = 1;
    });
}
