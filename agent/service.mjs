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
import { isAddress } from 'viem';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { paymentMiddleware } from '@x402/express';
import 'dotenv/config';

import { explain } from './swapvm.mjs';
import { resolveAgent, vouchesFor, parseAgentId } from './erc8004.mjs';
import { lookupMandate } from './hcs.mjs';
import { decodeAnswer, publicationAnswer, authorityAnswer } from './free.mjs';
import { page } from './ui.mjs';
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

// Body parsing fails before any route sees the request, and Express answers those with an HTML
// error page — `<!DOCTYPE html>` and a 400, from a service whose every other answer is JSON.
// Nothing that calls this endpoint is a browser: it is agents, indexers and facilitators, and an
// HTML page is not an answer any of them can read.
app.use((err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'body must be valid JSON' });
    }
    if (err?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'body must be under 256kb', limit: err.limit });
    }
    return next(err);
});

// Free: what this service is and what it charges. Anything that costs money to answer is behind
// the paywall below.
//
// Two audiences, one URL. Every consumer this service was built for is a machine, and the suite
// holds every route to answering JSON — but a person who pastes the hostname into a browser is not
// served by a wall of it. So the page is handed to a caller whose `Accept` header actually says
// `text/html`, which browsers send and none of the clients here do: the x402 client, the
// facilitator, an indexer and the test suite all send `*/*` or `application/json` and get exactly
// what they got before. The rule was never "HTML is wrong", it was "do not answer a machine in a
// format it cannot read".
// `?format=json` overrides it, because the page links to its own JSON and a link that serves the
// page again would be a footer lying about where it goes.
const wantsHtml = (req) =>
    req.query?.format !== 'json' && String(req.headers.accept || '').includes('text/html');

app.get('/', (req, res) => {
    if (wantsHtml(req)) {
        return res.type('html').send(page({
            origin: PUBLIC_ORIGIN,
            price: Number(PRICE.amount) / 1e8,
            payTo: PAY_TO,
            topic: HCS_TOPIC,
            facilitator: FACILITATOR,
            network: 'hedera:testnet',
        }));
    }
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
        free: {
            'POST /v1/mandate/decode': 'what a program permits — arithmetic on bytes you already hold',
            'POST /v1/mandate/publication': 'when those exact bytes became public, from a mirror node that is not ours',
            'GET /v1/agent/authority': 'whether the ENSv2 mandate name still holds, and if not, lapsed or revoked',
        },
    });
});

// The three free answers, at parity with the free MCP tools.
//
// Registered above the paywall so they are outside it by construction rather than by the payment
// middleware happening not to name them. They give away nothing that was not already free: an
// assistant holding the MCP server has been able to ask all three since it existed. What the
// payment buys is still the one answer none of them contains — the operator's ERC-8004 identity,
// and whether it vouches for the address that granted the mandate.
const freely = (handler) => async (req, res) => {
    try {
        res.json(await handler(req));
    } catch (e) {
        res.status(400).json({ error: String(e.shortMessage ?? e.message ?? e) });
    }
};

app.post('/v1/mandate/decode', freely((req) => decodeAnswer(req.body?.program)));
app.post('/v1/mandate/publication', freely((req) => publicationAnswer(req.body?.program)));
app.get('/v1/agent/authority', freely((req) => authorityAnswer({
    label: req.query?.label,
    grantedUntil: req.query?.grantedUntil === undefined ? undefined : Number(req.query.grantedUntil),
})));

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

/**
 * The paid answer, as a function.
 *
 * Split out from the route so it can be exercised without going through the paywall — the branch
 * below decides what a caller is told about somebody else's identity, and that is not something to
 * leave untested because testing it through HTTP would cost money.
 */
export async function inspect(body) {
    const program = body?.program;
    if (typeof program !== 'string' || !/^0x[0-9a-fA-F]*$/.test(program)) {
        return statusAnd(400, { error: 'body must be { program: "0x..." }' });
    }

    let answer;
    try {
        answer = explain(program);
    } catch (e) {
        // A program that cannot be walked is a real answer, not a server fault: it tells the caller
        // the bytes they were handed are not a valid instruction stream.
        return statusAnd(422, { error: String(e.message || e), valid: false });
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
    const { agentId, maker } = body ?? {};
    if (agentId !== undefined) {
        // `checked` separates the two answers that used to look alike. A malformed request, or an
        // RPC that would not answer, reported `registered: false` — telling someone who had paid
        // that an identity does not exist, when the truth was that we never managed to ask. That is
        // a statement about a third party, and getting it wrong is worse than returning nothing.
        const id = parseAgentId(agentId);
        if (id === null) {
            answer.operator = { checked: false, error: 'agentId must be a non-negative integer' };
        } else if (maker !== undefined && !isAddress(maker)) {
            answer.operator = { checked: false, error: 'maker must be a 0x-prefixed 20-byte address' };
        } else {
            try {
                const agent = await resolveAgent(id);
                answer.operator = { checked: true, ...agent, ...(maker ? { check: vouchesFor(agent, maker) } : {}) };
            } catch (e) {
                answer.operator = { checked: false, error: String(e.shortMessage || e.message || e) };
            }
        }
    }

    return statusAnd(200, answer);
}

const statusAnd = (status, payload) => ({ status, body: payload });

app.post('/v1/mandate/explain', async (req, res) => {
    const { status, body } = await inspect(req.body);
    res.status(status).json(body);
});

// Express's default 404 is an HTML page, for the same non-existent browser. A machine that reached
// the wrong path is told the right ones rather than handed markup it cannot read.
app.use((req, res) => {
    res.status(404).json({
        error: `no route for ${req.method} ${req.path}`,
        free: [
            'GET /',
            'GET /.well-known/x402',
            'POST /v1/mandate/decode',
            'POST /v1/mandate/publication',
            'GET /v1/agent/authority',
        ],
        paid: ['POST /v1/mandate/explain'],
    });
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
