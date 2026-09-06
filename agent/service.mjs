// Mandate inspection, sold per call over x402 on Hedera.
//
// A Batas position states its terms only as SwapVM bytecode. Anyone about to trade against one, or
// to let an agent run under it, has to decode that stream to find out what it actually enforces.
// This service does that decoding and charges a fraction of a cent per answer — no key, no
// account, no subscription, just an HTTP 402 the caller settles and retries.
//
//   node agent/service.mjs
//
// Settlement runs through the Blocky402 facilitator on Hedera testnet. Note that the official
// Hedera PoC points its *testnet* config at x402.org and reaches for Blocky402 only on mainnet;
// Blocky402 does serve hedera:testnet, but at api.testnet.blocky402.com rather than the mainnet
// host, and its /supported lives at the root rather than under /v1.

import express from 'express';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { paymentMiddleware } from '@x402/express';
import 'dotenv/config';

import { explain } from './swapvm.mjs';

const PORT = Number(process.env.PORT || 4021);
const FACILITATOR = process.env.X402_FACILITATOR_URL || 'https://api.testnet.blocky402.com';
const PAY_TO = process.env.HEDERA_SERVICE_ID;
// Priced in HBAR rather than USDC. Both work, but an HTS token has to be associated with an
// account before it can be received, and HBAR does not — one less thing between a caller and an
// answer, which is the whole point of paying per request.
const HBAR = '0.0.0';
const PRICE = { asset: HBAR, amount: process.env.X402_PRICE_TINYBAR || '100000' }; // 0.001 HBAR

if (!PAY_TO) {
    console.error('HEDERA_SERVICE_ID missing. Create a testnet ECDSA account at https://portal.hedera.com');
    process.exit(1);
}

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }))
    .register('hedera:*', new ExactHederaScheme({}));

const app = express();
app.use(express.json({ limit: '256kb' }));

// Free: what this service is and what it charges. Anything that costs money to answer is behind
// the paywall below.
app.get('/', (_req, res) => {
    res.json({
        service: 'Batas mandate inspection',
        describes: 'What limits a SwapVM program actually enforces, decoded from its bytecode.',
        endpoint: 'POST /v1/mandate/explain',
        body: { program: '0x… SwapVM instruction stream' },
        price: `${Number(PRICE.amount) / 1e8} HBAR`,
        network: 'hedera:testnet',
        facilitator: FACILITATOR,
        payTo: PAY_TO,
    });
});

app.use(
    paymentMiddleware(
        {
            'POST /v1/mandate/explain': {
                accepts: [{ scheme: 'exact', price: PRICE, network: 'hedera:testnet', payTo: PAY_TO }],
                description: 'Decode a SwapVM program into the mandate it enforces',
                mimeType: 'application/json',
            },
        },
        resourceServer,
    ),
);

app.post('/v1/mandate/explain', (req, res) => {
    const program = req.body?.program;
    if (typeof program !== 'string' || !/^0x[0-9a-fA-F]*$/.test(program)) {
        return res.status(400).json({ error: 'body must be { program: "0x..." }' });
    }
    try {
        res.json(explain(program));
    } catch (e) {
        // A program that cannot be walked is a real answer, not a server fault: it tells the caller
        // the bytes they were handed are not a valid instruction stream.
        res.status(422).json({ error: String(e.message || e), valid: false });
    }
});

export default app;

// Vercel sets VERCEL at build and at runtime and serves the exported app itself, so the listener
// is only for running this locally. One implementation either way; no hosted copy to drift.
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`batas mandate inspection on http://localhost:${PORT}`);
        console.log(`  paid route  POST /v1/mandate/explain   ${Number(PRICE.amount) / 1e8} HBAR on hedera:testnet`);
        console.log(`  facilitator ${FACILITATOR}`);
        console.log(`  payTo       ${PAY_TO}`);
    });
}
