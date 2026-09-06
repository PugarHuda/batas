// Pay for a mandate inspection and print what the position enforces.
//
//   node agent/inspect.mjs                 inspect the live Sepolia position
//   node agent/inspect.mjs 0x2120...       inspect a program you already have
//
// The first request comes back 402. The client settles on Hedera testnet through the Blocky402
// facilitator and retries, with no API key and no account on the service side — the payment is the
// authentication. Every call is settled independently, so there is nothing to cancel and nothing
// to over-buy.

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner, PrivateKey } from '@x402/hedera';
import { createPublicClient, http, getAddress, decodeAbiParameters, parseAbiParameters } from 'viem';
import { sepolia } from 'viem/chains';
import 'dotenv/config';

const SERVICE = process.env.BATAS_SERVICE_URL || 'http://localhost:4021';
const AQUA = getAddress('0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a');
const ROUTER = getAddress(process.env.BATAS_ROUTER || '0x228E82831afaC5dd9EbDE3489E9e18Ae9c7bcbf4');

/** Pull the newest program this owner shipped to the router, straight out of Aqua's event log. */
export async function latestProgramOnChain() {
    const owner = process.env.BATAS_OWNER;
    if (!owner) return null;

    const pub = createPublicClient({
        chain: sepolia,
        transport: http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'),
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
    for (let to = head, scanned = 0n; scanned < 60_000n && to > 0n; ) {
        const from = to > 9_000n ? to - 9_000n : 0n;
        const batch = await pub.getLogs({ address: AQUA, event: shipped, fromBlock: from, toBlock: to });
        const mine = batch.filter(
            (l) => l.args.maker?.toLowerCase() === owner.toLowerCase()
                && l.args.app?.toLowerCase() === ROUTER.toLowerCase(),
        );
        if (mine.length > 0) {
            // strategy is abi.encode(Order); the program is the tail of `data` after the two tokens.
            const strategy = mine[mine.length - 1].args.strategy;
            return { strategyHash: mine[mine.length - 1].args.strategyHash, strategy };
        }
        scanned += to - from;
        to = from - 1n;
    }
    return null;
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
export async function payForExplanation(program, { log = () => {} } = {}) {
    const accountId = process.env.HEDERA_AGENT_ID;
    const privateKey = process.env.HEDERA_AGENT_KEY;
    if (!accountId || !privateKey) {
        throw new Error('HEDERA_AGENT_ID and HEDERA_AGENT_KEY missing; create a testnet ECDSA account at https://portal.hedera.com');
    }

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
    const post = () => paidFetch(`${SERVICE}/v1/mandate/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The operator lookup is opt-in on the service side, so ask for it when we know who to ask
        // about. Sending the maker alongside turns the answer from "an identity exists" into
        // "that identity is held by the address that granted this mandate", which is the only form
        // of it worth anything.
        body: JSON.stringify({
            program,
            ...(process.env.BATAS_AGENT_ID ? { agentId: process.env.BATAS_AGENT_ID } : {}),
            ...(process.env.BATAS_OWNER ? { maker: process.env.BATAS_OWNER } : {}),
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
            throw new Error('pass a program as an argument, or set BATAS_OWNER to read the live position');
        }
        program = programFromStrategy(found.strategy);
        console.log(`reading the live position ${found.strategyHash}`);
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
        if (!o.registered) {
            console.log(`  no ERC-8004 identity${o.error ? ` — ${o.error}` : ''}`);
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
