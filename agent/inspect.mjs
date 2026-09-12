// Pay for a mandate inspection and print what the position enforces.
//
//   node agent/inspect.mjs                 inspect the live Sepolia position
//   node agent/inspect.mjs 0x2120...       inspect a program you already have
//
// The first request comes back 402. The client settles on Hedera testnet through the Blocky402
// facilitator and retries, with no API key and no account on the service side — the payment is the
// authentication. Every call is settled independently, so there is nothing to cancel and nothing
// to over-buy.

import 'dotenv/config';

import { ROUTER, OWNER, AGENT_ID } from './deployment.mjs';
import { latestProgramOnChain, programFromStrategy } from './position.mjs';

// Finding the position moved to position.mjs so the free path stops loading the payment client.
// Still exported from here: the walkthrough, the counterparty and the kill switch import them.
export { latestProgramOnChain, programFromStrategy };

// The deployed service, not a local one. counterparty.mjs already defaulted here, and the two
// disagreeing meant `--paid` walked up to a port nobody was listening on.
const SERVICE = process.env.BATAS_SERVICE_URL || 'https://batas-one.vercel.app';

/**
 * Pay for one explanation and return it.
 *
 * Exported because the MCP server sells the same answer to a different kind of caller. One payment
 * path, one place to get the spend cap and the cold-start retry right — a second implementation
 * would be a second thing to keep correct, and the first difference between them would be silent.
 *
 * `log` exists so the CLI can narrate while the MCP server stays silent. An MCP server speaks
 * JSON-RPC over stdout; a stray console.log there corrupts the stream.
 */
export async function payForExplanation(program, {
    log = () => {},
    accountId = process.env.HEDERA_AGENT_ID,
    privateKey = process.env.HEDERA_AGENT_KEY,
    origin = SERVICE,
} = {}) {
    if (!accountId || !privateKey) {
        throw new Error('HEDERA_AGENT_ID and HEDERA_AGENT_KEY missing; create a testnet ECDSA account at https://portal.hedera.com');
    }

    // Loaded here rather than at the top: these three take about a second to import, and every
    // free answer used to pay that second for a client it never constructed.
    const [{ wrapFetchWithPayment, x402Client, decodePaymentResponseHeader }, { ExactHederaScheme }, { createClientHederaSigner, PrivateKey }] =
        await Promise.all([import('@x402/fetch'), import('@x402/hedera/exact/client'), import('@x402/hedera')]);

    const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), {
        network: 'hedera:testnet',
    });
    // An allowlist rather than `spendControls: false`. HBAR is not one of the assets the client
    // recognises by default, so it has to be named — and naming it is the moment to cap it. The
    // agent may spend at most MAX_PER_CALL on any single request, which is the same idea as the
    // mandate it enforces on chain: autonomy inside a number someone else set.
    const MAX_PER_CALL = process.env.X402_MAX_TINYBAR || '1000000'; // 0.01 HBAR
    const client = x402Client.fromConfig({
        schemes: [{ network: 'hedera:testnet', client: new ExactHederaScheme(signer) }],
        spendControls: {
            allowedAssets: [{ network: 'hedera:testnet', asset: '0.0.0', maxAmountPerPayment: MAX_PER_CALL }],
        },
    });
    log(`budget   at most ${Number(MAX_PER_CALL) / 1e8} HBAR per call`);
    const paidFetch = wrapFetchWithPayment(fetch, client);

    log(`paying   from ${accountId} on hedera:testnet`);

    // A serverless deployment answers its first request cold, and the facilitator handshake the
    // paywall needs runs on that request path. The first caller after an idle period can therefore
    // see a 5xx while a warm one sees the 402 immediately. Retrying once is the honest fix: no
    // payment is created for a failed request, so the retry costs nothing but a second.
    const post = () => paidFetch(`${origin}/v1/mandate/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The operator lookup is opt-in on the service side, so ask for it when we know who to ask
        // about. Sending the maker alongside turns the answer from "an identity exists" into
        // "that identity is held by the address that granted this mandate", which is the only form
        // of it worth anything.
        body: JSON.stringify({
            program,
            ...(AGENT_ID ? { agentId: AGENT_ID } : {}),
            ...(OWNER ? { maker: OWNER } : {}),
        }),
    });

    let res = await post();
    if (res.status >= 500) {
        log(`retry    service answered ${res.status} cold, trying once more`);
        await new Promise((r) => setTimeout(r, 1500));
        res = await post();
    }

    const settled = res.headers.get('PAYMENT-RESPONSE') || res.headers.get('X-PAYMENT-RESPONSE');
    if (settled) {
        try {
            const receipt = decodePaymentResponseHeader(settled);
            log(`settled  ${receipt.transaction ?? JSON.stringify(receipt)}`);
        } catch {
            log(`settled  ${settled}`);
        }
    }

    if (!res.ok) {
        throw new Error(`service returned ${res.status}: ${await res.text()}`);
    }
    return { body: await res.json(), settlement: settled ?? null };
}

async function main() {
    let program = process.argv[2];
    if (!program) {
        const found = await latestProgramOnChain();
        if (!found) {
            throw new Error(`no mandate shipped to ${ROUTER} by ${OWNER}; run script/Demo.s.sol first`);
        }
        program = programFromStrategy(found.strategy);
        console.log(`reading the live position ${found.strategyHash}`);
        if (found.docked) console.log('docked   the maker has withdrawn it; these terms are no longer on offer');
    }
    console.log(`program  ${program}`);
    console.log(`service  ${SERVICE}`);

    const { body } = await payForExplanation(program, { log: (m) => console.log(m) });
    console.log('');
    console.log(`guarded by PolicyEnvelope: ${body.guarded}`);
    console.log('instructions');
    for (const i of body.instructions) console.log(`  @${String(i.offset).padStart(2)} ${i.name}`);
    console.log('enforced mandate');
    const m = body.mandate;
    if (m.maxAmountInFormatted) console.log(`  max input   ${m.maxAmountInFormatted}`);
    if (m.minRateFormatted) console.log(`  floor rate  ${m.minRateFormatted}`);
    if (m.feePercent !== null) console.log(`  fee         ${m.feePercent}%`);
    if (m.curve) console.log(`  curve       ${m.curve}`);
    if (m.expiryISO) console.log(`  expires     ${m.expiryISO}`);
    // What the limits alone cannot tell you: whether these bytes were ever published, and when.
    // A program that decodes perfectly and has no publication record is a set of terms someone
    // just handed you, which is a different thing from a mandate that has been standing for a day.
    const p = body.publication;
    if (p) {
        console.log('publication');
        if (p.published) {
            console.log(`  published   ${p.publishedAt}  (HCS consensus, topic ${p.topic} #${p.sequenceNumber})`);
            if (p.maker) console.log(`  granted by  ${p.maker}`);
            console.log(`  verify      ${p.mirror}`);
        } else if (p.published === false) {
            console.log(`  not published — ${p.reason}`);
        } else {
            console.log(`  unknown — ${p.error}`);
        }
    }

    if (body.operator) {
        const o = body.operator;
        console.log('operator');
        if (o.checked === false) {
            // Not the same as "no identity". Saying so would be a claim about someone else.
            console.log(`  not checked — ${o.error}`);
        } else if (!o.registered) {
            console.log('  no ERC-8004 identity under that id');
        } else {
            console.log(`  agent #${o.agentId}  ${o.registration?.name ?? '(unnamed)'}`);
            console.log(`  held by     ${o.owner}`);
            if (o.check) console.log(`  vouches     ${o.check.vouched ? 'yes' : 'no'} — ${o.check.reason}`);
        }
    }

    if (body.notes.length) {
        console.log('notes');
        for (const n of body.notes) console.log(`  - ${n}`);
    }
}

// Only run when invoked directly. Importing this file — a test does, and so could any other
// tool — must not fire off the whole flow as a side effect of loading it.
if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage || e.message || e));
        process.exit(1);
    });
}
