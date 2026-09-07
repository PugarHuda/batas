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
import { resolveAgent, vouchesFor } from './erc8004.mjs';
import { lookupMandate } from './hcs.mjs';
import { HCS_TOPIC } from './deployment.mjs';

const PORT = Number(process.env.PORT || 4021);
const FACILITATOR = process.env.X402_FACILITATOR_URL || 'https://api.testnet.blocky402.com';
const PAY_TO = process.env.HEDERA_SERVICE_ID;
// Priced in HBAR rather than USDC. Both work, but an HTS token has to be associated with an
// account before it can be received, and HBAR does not — one less thing between a caller and an
// answer, which is the whole point of paying per request.
const HBAR = '0.0.0';
// Where this service answers from. The discovery manifest must name absolute HTTPS URLs on this
// host, so it cannot be derived from a request that may have arrived through a proxy.
const PUBLIC_ORIGIN = process.env.BATAS_PUBLIC_ORIGIN || 'https://batas-one.vercel.app';
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
        describes: 'What limits a SwapVM program actually enforces, decoded from its bytecode,'
            + ' and when those exact bytes were published to Hedera Consensus Service.',
        endpoint: 'POST /v1/mandate/explain',
        topic: HCS_TOPIC,
        body: {
            program: '0x… SwapVM instruction stream',
            agentId: 'optional — an ERC-8004 id to resolve the operator behind the position',
            maker: 'optional — the address that granted the mandate, to check the identity vouches for it',
        },
        price: `${Number(PRICE.amount) / 1e8} HBAR`,
        network: 'hedera:testnet',
        facilitator: FACILITATOR,
        payTo: PAY_TO,
    });
});

// Discovery, per draft-hawkins-x402-dns-discovery. A manifest at this path is how an indexer or a
// stranger's agent finds out that this host takes payment and what it sells, without being told
// the URL of the paid route first. Several facilitators already read it, so publishing it costs
// one handler and makes the service reachable by software that has never heard of this project.
//
// `updated` is a constant rather than the current time: it means "when this manifest last changed",
// and a value that moves on every request would claim a change that did not happen.
const MANIFEST_UPDATED = '2026-09-07T00:00:00Z';

app.get('/.well-known/x402', (_req, res) => {
    res.type('application/json').json({
        x402Version: 2,
        kind: 'resource-server',
        name: 'Batas mandate inspection',
        description: 'Decodes a SwapVM program into the mandate it enforces, and reports when those'
            + ' exact bytes were published to Hedera Consensus Service.',
        resources: [
            {
                url: `${PUBLIC_ORIGIN}/v1/mandate/explain`,
                method: 'POST',
                description: 'Decode a SwapVM program into the mandate it enforces',
                // Not part of the draft's required shape, and unknown fields must be ignored — but
                // an indexer that does read it learns the price without spending a request to be
                // told 402.
                accepts: [{ scheme: 'exact', network: 'hedera:testnet', asset: HBAR, amount: PRICE.amount, payTo: PAY_TO }],
            },
        ],
        docs: 'https://github.com/PugarHuda/batas',
        updated: MANIFEST_UPDATED,
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

app.post('/v1/mandate/explain', async (req, res) => {
    const program = req.body?.program;
    if (typeof program !== 'string' || !/^0x[0-9a-fA-F]*$/.test(program)) {
        return res.status(400).json({ error: 'body must be { program: "0x..." }' });
    }

    let answer;
    try {
        answer = explain(program);
    } catch (e) {
        // A program that cannot be walked is a real answer, not a server fault: it tells the caller
        // the bytes they were handed are not a valid instruction stream.
        return res.status(422).json({ error: String(e.message || e), valid: false });
    }

    // When these bytes became public, according to a network none of the parties runs.
    //
    // Decoding tells a caller what the program permits. It cannot tell them whether the program is
    // a real grant or something handed to them a minute ago, and the Sepolia timestamp is only as
    // good as the RPC that served it. The HCS record answers that from an independent ordering
    // service, and unlike the limits it is not something the caller could compute for themselves.
    // No input needed: the match is on the bytes already in the request.
    try {
        answer.publication = await lookupMandate(HCS_TOPIC, program);
    } catch (e) {
        answer.publication = { published: null, error: String(e.message || e) };
    }

    // Who is running this position. The program cannot say — bytecode has no author — so the
    // answer comes from the ERC-8004 registry rather than from anyone's claim. Optional, because a
    // caller who only wants the limits should not pay for a chain read they did not ask for.
    const { agentId, maker } = req.body ?? {};
    if (agentId !== undefined) {
        try {
            const agent = await resolveAgent(agentId);
            answer.operator = { ...agent, ...(maker ? { check: vouchesFor(agent, maker) } : {}) };
        } catch (e) {
            answer.operator = { registered: false, error: String(e.shortMessage || e.message || e) };
        }
    }

    res.json(answer);
});

export default app;

// Vercel sets VERCEL at build and at runtime and serves the exported app itself, so the listener
// is only for running this locally. One implementation either way; no hosted copy to drift.
//
// Only when invoked directly, for the same reason as inspect.mjs and batas-agent.mjs: importing
// this file must not bind a port. The production drift test imports the app to compare it against
// the deployment, and without this guard that import quietly took 4021 — and would have crashed
// the run outright whenever a local service was already holding it.
if (!process.env.VERCEL && import.meta.filename === process.argv[1]) {
    app.listen(PORT, () => {
        console.log(`batas mandate inspection on http://localhost:${PORT}`);
        console.log(`  paid route  POST /v1/mandate/explain   ${Number(PRICE.amount) / 1e8} HBAR on hedera:testnet`);
        console.log(`  facilitator ${FACILITATOR}`);
        console.log(`  payTo       ${PAY_TO}`);
    });
}
