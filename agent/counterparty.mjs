// The other agent. The one deciding whether to trust this position.
//
//   node agent/counterparty.mjs                 decide about the live position
//   node agent/counterparty.mjs --program 0x…   decide about a program you were handed
//   node agent/counterparty.mjs --paranoid      insist on knowing the operator, and pay for it
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

import { payForExplanation } from './inspect.mjs';

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
    if (!publication?.published) {
        doubts.push('these exact bytes have no publication record: they could have been written a minute ago');
    }
    if (!authority?.valid) {
        doubts.push(`the agent's authority is gone: ${authority?.reason ?? 'the name does not hold'}`);
    }
    return doubts;
}

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
        console.log('  trading against it.');
    } else {
        console.log('  the identity does not vouch for the maker. declining, and the tenth of a cent');
        console.log('  that established it was the cheapest part of this decision.');
        process.exitCode = 1;
    }
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage ?? e.message ?? e));
        process.exitCode = 1;
    });
}
