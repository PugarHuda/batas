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

import { explain, MAX_LISTED_INSTRUCTIONS } from './swapvm.mjs';
import { resolveAgent, vouchesFor, parseAgentId } from './erc8004.mjs';
import { lookupMandate } from './hcs.mjs';
import { decodeAnswer, publicationAnswer, authorityAnswer, reputationAnswer } from './free.mjs';
import { healthAnswer } from './health.mjs';
import { page } from './ui.mjs';
import { landing } from './landing.mjs';
import { FONTS } from './fonts.mjs';
import { HCS_TOPIC } from './deployment.mjs';
import { openapiDocument, agentCard, ATTRIBUTION } from './openapi.mjs';
import { attest } from './attest.mjs';
import { createServer as createMcpServer } from './mcp.mjs';
import { htsAccept, htsManifestAccept } from './hts.mjs';
import { mountA2A } from './a2a.mjs';
import { agentRegistrationRoute } from './agent-registration.mjs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

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
/**
 * What each part of the paid answer costs, in tinybar.
 *
 * The answer is not one unit of work. A program is walked instruction by instruction, the
 * publication lookup pages a mirror node, the authority check makes Sepolia reads, and the operator
 * check makes more of them only when the caller names an agent. A flat charge billed a six
 * instruction mandate and a 256 instruction stream with an identity check alike, so the price is
 * now the sum of the work the body actually asks for.
 *
 * The rates are set so that the live mandate on its own (six instructions, no agentId) still costs
 * exactly 0.001 HBAR, which is what every client and suite already knows. The ceiling, a program
 * past the instruction cap with a well-formed agent, is 0.0037 HBAR: under the 0.01 HBAR cap the
 * paying client in inspect.mjs sets by default, so no request this service accepts is one its own
 * client would refuse to pay.
 */
export const METER = Object.freeze({
    decode: 40_000,
    perInstruction: 1_000,
    // Billed up to the number the answer lists. Past it the stream is still read for its terms, but
    // it is not a mandate any more, and the price must not grow with a payload the answer bounds.
    instructionCap: MAX_LISTED_INSTRUCTIONS,
    publication: 34_000,
    authority: 20_000,
    operator: 20_000,
});

/**
 * The bill for one request, derived from its body alone.
 *
 * It mirrors `inspect` step for step, so the caller pays for the reads that answer will make and for
 * nothing it will not: a program that is not hex or does not decode is refused before any lookup, so
 * it is billed the decode only; the operator is billed only when `inspect` would actually go to the
 * chain for it. The paywall calls this for the 402, and again on the paid retry — x402 then requires
 * the signed payment to match the recomputed requirement, so a light price cannot be replayed
 * against a heavy body.
 */
export function priceFor(body) {
    const components = [{ component: 'decode', tinybar: METER.decode }];
    const program = body?.program;
    let count = null;
    if (typeof program === 'string' && /^0x[0-9a-fA-F]*$/.test(program)) {
        try {
            count = explain(program).instructionCount;
        } catch {
            // A 422: nothing past the decode is looked up, and x402 does not settle a 4xx answer.
        }
    }
    if (count !== null) {
        const billed = Math.min(count, METER.instructionCap);
        components.push(
            { component: 'instructions', count, billed, rate: METER.perInstruction, tinybar: billed * METER.perInstruction },
            { component: 'publication', tinybar: METER.publication },
            { component: 'authority', tinybar: METER.authority },
        );
        const { agentId, maker } = body;
        if (agentId !== undefined && parseAgentId(agentId) !== null && (maker === undefined || isAddress(maker))) {
            components.push({ component: 'operator', tinybar: METER.operator });
        }
    }
    const total = components.reduce((sum, c) => sum + c.tinybar, 0);
    return { unit: 'tinybar', asset: HBAR, components, total: String(total), hbar: total / 1e8 };
}

// The cheapest answer a caller can be charged for, and the most any request can cost. Stated on
// every surface that names a price, since no single number is the price any more.
const METER_MIN = METER.decode + METER.publication + METER.authority;
const METER_MAX = METER_MIN + METER.instructionCap * METER.perInstruction + METER.operator;
const PRICE_TEXT = `metered, ${METER_MIN / 1e8} to ${METER_MAX / 1e8} HBAR per call by the work the body asks for`;
const METERING = {
    unit: 'tinybar',
    min: String(METER_MIN),
    max: String(METER_MAX),
    rates: METER,
    formula: `decode ${METER.decode} + ${METER.perInstruction} per instruction (at most ${METER.instructionCap} billed)`
        + ` + publication ${METER.publication} + authority ${METER.authority}`
        + ` + operator ${METER.operator} when a well-formed agentId (and maker, if given) is sent.`
        + ' A program that is not hex or does not decode is billed the decode only, and x402 settles no 4xx answer.',
    exact: 'the 402 for a body states the exact amount; the paid answer carries the same breakdown as `metering`',
};
// The key that signs paid answers, or nothing. No fallback to any other key on purpose: a signature
// from the trading key or the Hedera key would be a different claim than "this service said so".
const ATTEST_KEY = process.env.BATAS_ATTEST_KEY || null;

if (!PAY_TO) {
    console.error('HEDERA_SERVICE_ID missing. Create a testnet ECDSA account at https://portal.hedera.com');
    process.exit(1);
}

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }))
    .register('hedera:*', new ExactHederaScheme({}));

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
    // The parts nobody draws. A JSON API has no scripts to protect, but a page is served from the
    // same origin, and these cost nothing to state.
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
});
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
    // Every other body-parser failure — a Content-Encoding it cannot decode, a charset it does not
    // know — carried an HTTP status and answered as Express's HTML page. Same rule as the two above.
    if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ error: err.type ?? 'bad request' });
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

// Two rooms for a person: the case for the product at `/`, the instrument at `/app`. A machine that
// asks for `/` still gets JSON, exactly as before; only a browser is shown either page.
const pageArgs = () => ({
    origin: PUBLIC_ORIGIN,
    // The floor, because the pages say "from": the exact bill depends on the body sent.
    price: METER_MIN / 1e8,
    payTo: PAY_TO,
    topic: HCS_TOPIC,
    facilitator: FACILITATOR,
    network: 'hedera:testnet',
});

// Faces for both pages. Immutable bytes under a name that changes when they do, so a year is safe.
app.get('/assets/fonts/:name.woff2', (req, res) => {
    const bytes = FONTS[req.params.name];
    if (!bytes) return res.status(404).json({ error: `no font ${req.params.name}` });
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('font/woff2').send(Buffer.from(bytes, 'base64'));
});

app.get('/app', (req, res) => {
    res.vary('Accept');
    if (wantsHtml(req)) return res.type('html').send(page(pageArgs()));
    // The instrument has no JSON of its own; the free routes are its data.
    res.json({ page: 'app', free: ['POST /v1/mandate/decode', 'POST /v1/mandate/publication', 'GET /v1/agent/authority', 'GET /v1/agent/reputation', 'GET /v1/position/health'] });
});

app.get('/', (req, res) => {
    // One URL, two representations: a shared cache must key on Accept or hand a machine the page.
    res.vary('Accept');
    if (wantsHtml(req)) {
        return res.type('html').send(landing(pageArgs()));
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
        price: PRICE_TEXT,
        metering: METERING,
        network: 'hedera:testnet',
        facilitator: FACILITATOR,
        payTo: PAY_TO,
        free: {
            'POST /v1/mandate/decode': 'what a program permits — arithmetic on bytes you already hold',
            'POST /v1/mandate/publication': 'when those exact bytes became public, from a mirror node that is not ours',
            'GET /v1/agent/authority': 'whether the ENSv2 mandate name still holds, and if not, lapsed or revoked',
            'GET /v1/agent/reputation': 'what clients have said, from ERC-8004; the agent itself is barred from saying it',
            'GET /v1/position/health': 'the live position against its mandate: headroom to the floor, trades, and alerts',
        },
        openapi: `${PUBLIC_ORIGIN}/openapi.json`,
        agentCard: `${PUBLIC_ORIGIN}/.well-known/agent-card.json`,
        mcp: `${PUBLIC_ORIGIN}/mcp`,
        attribution: ATTRIBUTION,
    });
});

// The three free answers, at parity with the free MCP tools.
//
// Registered above the paywall so they are outside it by construction rather than by the payment
// middleware happening not to name them. They give away nothing that was not already free: an
// assistant holding the MCP server has been able to ask all three since it existed. What the
// payment buys is still the one answer none of them contains — the operator's ERC-8004 identity,
// and whether it vouches for the address that granted the mandate.
/**
 * A bucket per caller, for the free routes only.
 *
 * The paid route needs none of this: a caller who wants to hammer it may, one settled payment at a
 * time. The free ones are the exposed surface — the publication lookup walks a mirror node and the
 * authority check makes three Sepolia reads — and something has to stand between a loop and two
 * public networks this project does not pay for.
 *
 * ponytail: a plain in-memory counter. It is per instance rather than global, so the real ceiling
 * is this number times however many instances are warm, and it resets whenever one is recycled. A
 * shared store is the upgrade if anyone ever actually abuses it; until then this is the difference
 * between "a runaway script costs the mirror node something" and "it does not".
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.BATAS_FREE_RATE_LIMIT || 60);
const buckets = new Map();

function overLimit(req) {
    // Behind Vercel the socket address is the proxy's, so the forwarded header is the only thing
    // that identifies a caller. It is caller-controlled and therefore spoofable, which is fine for
    // what this is: a brake on accidents and loops, not an access control.
    const who = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const now = Date.now();
    const bucket = buckets.get(who);
    if (!bucket || now - bucket.start >= WINDOW_MS) {
        buckets.set(who, { start: now, count: 1 });
        // Swept here rather than on a timer: a serverless instance that goes idle never runs the
        // timer anyway, and the map only grows while requests are arriving.
        if (buckets.size > 10_000) {
            for (const [k, v] of buckets) if (now - v.start >= WINDOW_MS) buckets.delete(k);
        }
        return false;
    }
    bucket.count += 1;
    // The seconds until this caller's window actually reopens, rather than a flat minute: a caller
    // refused with two seconds left was told to sit out sixty, and a client that honours Retry-After
    // exactly — which is the point of sending it — waited the whole time for nothing.
    return bucket.count > MAX_PER_WINDOW ? Math.max(1, Math.ceil((bucket.start + WINDOW_MS - now) / 1000)) : 0;
}

const refuse = (res, wait) => res.status(429)
    .set('Retry-After', String(wait))
    .json({
        error: `too many free requests; at most ${MAX_PER_WINDOW} per ${WINDOW_MS / 1000}s`,
        retryAfterSeconds: wait,
        note: 'the paid route is not rate limited — a settled payment is the quota',
    });

const freely = (handler) => async (req, res) => {
    const wait = overLimit(req);
    if (wait) return refuse(res, wait);
    // express.json accepts a top-level array, and every free route reads fields off an object, so
    // `[1,2]` used to fall through to "no program given" and answer about the live position.
    if (Array.isArray(req.body)) return res.status(400).json({ error: 'body must be a JSON object' });
    try {
        res.json(await handler(req));
    } catch (e) {
        // Whose fault. A program that is not hex is the caller's; a chain that would not answer is
        // not, and reporting it as 400 told the caller to fix a request that was fine. free.mjs
        // states the status on the errors that are the caller's; the message match stays for the
        // ones thrown deeper down that do not carry one.
        const message = String(e.shortMessage ?? e.message ?? e);
        const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status
            : /must be|needs|not a valid|hex string|non-negative/i.test(message) && !e.scanExhausted ? 400 : 502;
        res.status(status).json({ error: message, ...(status >= 500 ? { upstream: true } : {}) });
    }
};

app.post('/v1/mandate/decode', freely((req) => decodeAnswer(req.body?.program)));
app.post('/v1/mandate/publication', freely((req) => publicationAnswer(req.body?.program)));
app.get('/v1/agent/reputation', freely((req) => reputationAnswer({ agentId: req.query?.agentId })));
app.get('/v1/position/health', freely(() => healthAnswer()));
// Passed through as the query string gave them; authorityAnswer decides what a valid deadline is, so
// "abc" is refused there rather than becoming NaN here and being quietly ignored.
app.get('/v1/agent/authority', freely((req) => authorityAnswer({
    label: req.query?.label,
    grantedUntil: req.query?.grantedUntil,
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
                // told 402. The manifest cannot see a body, so `amount` is the most any request can
                // cost, which is the number a client budgeting ahead needs; `metered` gives the
                // formula that produces the exact figure the 402 will state.
                accepts: [{ scheme: 'exact', network: 'hedera:testnet', asset: HBAR, amount: String(METER_MAX), payTo: PAY_TO }, htsManifestAccept(PAY_TO)],
                metered: METERING,
            },
        ],
        docs: 'https://github.com/PugarHuda/batas',
        // Not in the draft's shape either; unknown fields must be ignored, and the licence asks
        // for the line wherever the service describes itself.
        attribution: ATTRIBUTION,
        updated: MANIFEST_UPDATED,
    });
});

// Described, so a machine can find it.
//
// Both documents come from one route table in openapi.mjs, and neither is rate limited: they are
// constants, and a directory that crawls them is exactly the caller they exist for.
const described = { origin: PUBLIC_ORIGIN, price: PRICE_TEXT, network: 'hedera:testnet', payTo: PAY_TO, metering: METERING };
app.get('/openapi.json', (_req, res) => res.json(openapiDocument(described)));
// The card now names a JSON-RPC interface as well, so a2a.mjs serves it, extending this one, next
// to the A2A endpoint that negotiates fills and settles them through the same resource server.
// A negotiated quote is one fixed deliverable rather than a body of work to meter, so it keeps one
// price: what the meter charges for reading the live six-instruction mandate on its own.
const A2A_PRICE = { asset: HBAR, amount: String(METER.decode + 6 * METER.perInstruction + METER.publication + METER.authority) };
mountA2A(app, { card: () => agentCard(described), resourceServer, origin: PUBLIC_ORIGIN, payTo: PAY_TO, price: A2A_PRICE, overLimit, inspect });
// ERC-8004 endpoint-domain proof: the on-chain registration, served from the domain it names.
app.get('/.well-known/agent-registration.json', agentRegistrationRoute);

// The MCP server, over HTTP rather than stdio. Same factory, same four tools, one server per
// request and no session: a Vercel function may not be the same instance twice, so there is nothing
// a session could be kept in. Behind the free brake, above the paywall — the tools are the free
// questions, and the one that pays does so from the server's own key, which the deployment does
// not hold.
app.post('/mcp', async (req, res) => {
    const wait = overLimit(req);
    if (wait) return refuse(res, wait);
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: String(e.message ?? e) });
    }
});

// Streamable HTTP says a server that offers no SSE stream must answer GET with 405, and a stateless
// one has no session for DELETE to end. A 404 here told an MCP client probing for the stream that
// the endpoint it had just been pointed at did not exist.
app.all('/mcp', (req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: `${req.method} /mcp is not served; this MCP endpoint is stateless and takes POST only` });
});

app.use(
    paymentMiddleware(
        {
            'POST /v1/mandate/explain': {
                // HBAR first, so a client that takes the first option needs no token association;
                // the HTS credit (agent/hts.mjs) follows, with its custom fee assessed at consensus.
                // A function of the request, which @x402/core resolves per call (DynamicPrice). The
                // body is already parsed: express.json runs before this middleware.
                accepts: [{
                    scheme: 'exact',
                    price: (context) => ({ asset: HBAR, amount: priceFor(context.adapter.getBody?.()).total }),
                    network: 'hedera:testnet',
                    payTo: PAY_TO,
                }, htsAccept(PAY_TO)],
                description: 'Decode a SwapVM program into the mandate it enforces',
                mimeType: 'application/json',
                // Stated, not derived. Left to itself the middleware builds the resource identity
                // from `req.protocol` + `Host`, and behind Vercel's proxy Express reports `http`, so
                // the live 402 advertised `http://batas-one.vercel.app/…` while the discovery
                // manifest said `https://` — two names for one resource, and the discovery draft
                // says resources must be HTTPS. The manifest and the 402 now come from one string.
                resource: `${PUBLIC_ORIGIN}/v1/mandate/explain`,
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

    // And whether the operator may still act at all.
    //
    // Free on its own, and included here anyway: what the payment buys is not any single one of
    // these reads, it is all of them assembled against the same position in one answer. A caller
    // told the terms and the identity but left to discover for themselves that the name behind it
    // was revoked an hour ago has been sold three quarters of a verdict.
    try {
        answer.authority = await authorityAnswer({ grantedUntil: answer.mandate?.expiry ?? undefined });
    } catch (e) {
        answer.authority = { checked: false, error: String(e.shortMessage || e.message || e) };
    }

    // And what anyone who has actually traded here says about it.
    if (answer.operator?.checked) {
        try {
            answer.reputation = await reputationAnswer({ agentId: answer.operator.agentId });
        } catch (e) {
            answer.reputation = { checked: false, error: String(e.shortMessage || e.message || e) };
        }
    }

    // The bill, itemised. The route is behind a paywall whose requirement came from this same function
    // over this same body, so this is what the caller settled, and each line can be checked against
    // the rates in the discovery manifest. Set last and before the attestation, so it is signed too.
    answer.metering = priceFor(body);

    return statusAnd(200, answer);
}

const statusAnd = (status, payload) => ({ status, body: payload });

app.post('/v1/mandate/explain', async (req, res) => {
    const { status, body } = await inspect(req.body);
    // Signed when the service holds a key, so the answer can be shown to a third party and still
    // mean something. Only a real answer: an error body is not a statement about a mandate.
    if (status === 200 && ATTEST_KEY) {
        body.attestation = await attest(body, { privateKey: ATTEST_KEY, program: req.body.program });
    }
    res.status(status).json(body);
});

// Express's default 404 is an HTML page, for the same non-existent browser. A machine that reached
// the wrong path is told the right ones rather than handed markup it cannot read.
// Last, and only for what nothing above caught: a thrown error inside a route must not become the
// HTML page Express prints by default, with a stack trace when NODE_ENV is unset.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal error' });
});

app.use((req, res) => {
    res.status(404).json({
        error: `no route for ${req.method} ${req.path}`,
        free: [
            'GET /',
            'GET /app',
            'GET /.well-known/x402',
            'POST /v1/mandate/decode',
            'POST /v1/mandate/publication',
            'GET /v1/agent/authority',
            'GET /v1/agent/reputation',
            'GET /v1/position/health',
            'GET /openapi.json',
            'GET /.well-known/agent-card.json',
            'POST /mcp',
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
        console.log(`  paid route  POST /v1/mandate/explain   ${PRICE_TEXT} on hedera:testnet`);
        console.log(`  facilitator ${FACILITATOR}`);
        console.log(`  payTo       ${PAY_TO}`);
    });
}
