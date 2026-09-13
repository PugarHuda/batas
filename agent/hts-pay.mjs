// Pay for a mandate inspection in Batas Inspection Credit instead of HBAR, then check the ledger.
//
//   node agent/hts-pay.mjs                 inspect the live Sepolia position, paying in BIC
//   node agent/hts-pay.mjs 0x2120...       inspect a program you already have
//
// The 402 lists HBAR first and the credit second. This client allowlists only the credit, so the
// x402 client picks it: a TransferTransaction of HTS tokens from the agent to the service, signed by
// the agent and paid for by the facilitator. The token's custom fee is not in that transaction
// body at all; the network assesses it at consensus. So after settling, the client reads the record
// from the mirror node and requires both halves: the credits reached the service, and the custom fee
// was assessed on the agent to the collector.

import 'dotenv/config';

import { HTS_TOKEN } from './deployment.mjs';
import { HTS_PRICE, HTS_SYMBOL, HTS_DECIMALS, confirmTokenSettlement } from './hts.mjs';

const SERVICE = process.env.BATAS_SERVICE_URL || 'https://batas-one.vercel.app';

/** Pay for one explanation in BIC and return the answer with the ledger's account of the payment. */
export async function payInCredits(program, {
    log = () => {},
    accountId = process.env.HEDERA_AGENT_ID,
    privateKey = process.env.HEDERA_AGENT_KEY,
    origin = SERVICE,
    // The cap is the price plus nothing: the fee is charged by the ledger on top, never in the body.
    maxPerCall = process.env.BATAS_HTS_MAX || HTS_PRICE,
} = {}) {
    if (!accountId || !privateKey) throw new Error('HEDERA_AGENT_ID and HEDERA_AGENT_KEY are required to pay');
    const [{ wrapFetchWithPayment, x402Client, decodePaymentResponseHeader }, { ExactHederaScheme }, { createClientHederaSigner, PrivateKey }] =
        await Promise.all([import('@x402/fetch'), import('@x402/hedera/exact/client'), import('@x402/hedera')]);

    const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), { network: 'hedera:testnet' });
    // Only the credit is allowlisted, which is what makes the client skip the HBAR option listed first.
    const client = x402Client.fromConfig({
        schemes: [{ network: 'hedera:testnet', client: new ExactHederaScheme(signer) }],
        spendControls: { allowedAssets: [{ network: 'hedera:testnet', asset: HTS_TOKEN, maxAmountPerPayment: String(maxPerCall) }] },
    });
    const unit = 10 ** HTS_DECIMALS;
    log(`paying   ${Number(HTS_PRICE) / unit} ${HTS_SYMBOL} (${HTS_TOKEN}) from ${accountId} to ${origin}`);

    const res = await wrapFetchWithPayment(fetch, client)(`${origin}/v1/mandate/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ program }),
    });
    const header = res.headers.get('PAYMENT-RESPONSE') || res.headers.get('X-PAYMENT-RESPONSE');
    const receipt = header ? decodePaymentResponseHeader(header) : null;
    if (!res.ok) throw new Error(`service returned ${res.status}: ${await res.text()}${receipt ? ` ${JSON.stringify(receipt)}` : ''}`);
    if (!receipt?.transaction) throw new Error('the service answered without naming a settlement transaction');
    log(`settled  ${receipt.transaction}`);

    const onLedger = await confirmTokenSettlement(receipt.transaction, { payer: accountId });
    log(onLedger.confirmed
        ? `ledger   ${onLedger.paid / unit} ${HTS_SYMBOL} left ${accountId}; ${onLedger.received / unit} reached the service, `
            + `of which ${onLedger.fee / unit} is the assessed custom fee  ${onLedger.mirror}`
        : `ledger   ${onLedger.confirmed === false ? 'NOT confirmed' : 'not checked'} — ${onLedger.reason}`);
    return { body: await res.json(), receipt, onLedger };
}

if (import.meta.filename === process.argv[1]) {
    (async () => {
        let program = process.argv[2];
        if (!program) {
            const { latestProgramOnChain, programFromStrategy } = await import('./position.mjs');
            const found = await latestProgramOnChain();
            if (!found) throw new Error('no live position found; pass a program');
            program = programFromStrategy(found.strategy);
        }
        const { body, onLedger } = await payInCredits(program, { log: (m) => console.log(m) });
        console.log(`guarded  ${body.guarded}`);
        if (!onLedger.confirmed) process.exit(1);
    })().catch((e) => {
        console.error(String(e.shortMessage || e.message || e));
        process.exit(1);
    });
}
