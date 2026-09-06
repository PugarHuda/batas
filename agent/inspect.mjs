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
import { createPublicClient, http, getAddress } from 'viem';
import { sepolia } from 'viem/chains';
import 'dotenv/config';

const SERVICE = process.env.BATAS_SERVICE_URL || 'http://localhost:4021';
const AQUA = getAddress('0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a');
const ROUTER = getAddress(process.env.BATAS_ROUTER || '0x228E82831afaC5dd9EbDE3489E9e18Ae9c7bcbf4');

/** Pull the newest program this owner shipped to the router, straight out of Aqua's event log. */
async function latestProgramOnChain() {
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

/** `data` is tokenA ++ tokenB ++ program, so the program starts 40 bytes in. */
function programFromOrderData(dataHex) {
    return `0x${dataHex.replace(/^0x/, '').slice(80)}`;
}

/** Decode abi.encode(Order) far enough to reach the `data` field. */
function orderDataFromStrategy(strategyHex) {
    const b = strategyHex.replace(/^0x/, '');
    const word = (i) => b.slice(i * 64, (i + 1) * 64);
    const dataOffset = Number(BigInt('0x' + word(2))) / 32; // words
    const len = Number(BigInt('0x' + word(dataOffset)));
    return `0x${b.slice((dataOffset + 1) * 64, (dataOffset + 1) * 64 + len * 2)}`;
}

async function main() {
    const accountId = process.env.HEDERA_AGENT_ID;
    const privateKey = process.env.HEDERA_AGENT_KEY;
    if (!accountId || !privateKey) {
        throw new Error('HEDERA_AGENT_ID and HEDERA_AGENT_KEY missing; create a testnet ECDSA account at https://portal.hedera.com');
    }

    let program = process.argv[2];
    if (!program) {
        const found = await latestProgramOnChain();
        if (!found) {
            throw new Error('pass a program as an argument, or set BATAS_OWNER to read the live position');
        }
        program = programFromOrderData(orderDataFromStrategy(found.strategy));
        console.log(`reading the live position ${found.strategyHash}`);
    }
    console.log(`program  ${program}`);
    console.log(`service  ${SERVICE}`);

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
    console.log(`budget   at most ${Number(MAX_PER_CALL) / 1e8} HBAR per call`);
    const paidFetch = wrapFetchWithPayment(fetch, client);

    console.log(`paying   from ${accountId} on hedera:testnet`);
    const res = await paidFetch(`${SERVICE}/v1/mandate/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ program }),
    });

    const settled = res.headers.get('PAYMENT-RESPONSE') || res.headers.get('X-PAYMENT-RESPONSE');
    if (settled) {
        try {
            const receipt = decodePaymentResponseHeader(settled);
            console.log(`settled  ${receipt.transaction ?? JSON.stringify(receipt)}`);
        } catch {
            console.log(`settled  ${settled}`);
        }
    }

    if (!res.ok) {
        console.error(`service returned ${res.status}: ${await res.text()}`);
        process.exit(1);
    }

    const body = await res.json();
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
    if (body.notes.length) {
        console.log('notes');
        for (const n of body.notes) console.log(`  - ${n}`);
    }
}

main().catch((e) => {
    console.error(String(e.shortMessage || e.message || e));
    process.exit(1);
});
