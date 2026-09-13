// The service, described in the two formats other people's software already reads.
//
// Every route below is listed once, in ROUTES, and both documents are generated from that list: the
// OpenAPI document a code generator or an LLM tool-loader consumes, and the A2A Agent Card an agent
// directory crawls. Two hand-written documents would be two places for a route to go missing from,
// and the free/paid split — the one fact about this service that matters most to a caller — would
// be stated three times.
//
// The response schemas are written by hand from what `free.mjs` and `service.mjs` actually return,
// and every one of them permits additional properties: the answers grow when a new fact is worth
// reporting, and a schema that refused the growth would make an honest answer invalid.

import { AGENT_ID, IDENTITY_REGISTRY, HCS_TOPIC } from './deployment.mjs';

export const ATTRIBUTION = 'Powered by SwapVM — © Degensoft Ltd 2025. Powered by Aqua — © Degensoft Ltd 2025.';

const HEX = { type: 'string', pattern: '^0x[0-9a-fA-F]*$', description: 'a SwapVM instruction stream' };
const ADDRESS = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
const NULLABLE_STRING = { type: ['string', 'null'] };
const NULLABLE_INT = { type: ['integer', 'null'] };

const schemas = {
    Error: {
        type: 'object',
        required: ['error'],
        properties: {
            error: { type: 'string' },
            upstream: { type: 'boolean', description: 'present and true when a chain or mirror node would not answer; the request was fine' },
        },
        additionalProperties: true,
    },
    RateLimited: {
        type: 'object',
        required: ['error', 'retryAfterSeconds'],
        properties: { error: { type: 'string' }, retryAfterSeconds: { type: 'integer' }, note: { type: 'string' } },
        additionalProperties: true,
    },
    ProgramBody: {
        type: 'object',
        properties: { program: { ...HEX, description: 'omit to ask about the live Sepolia position' } },
        additionalProperties: true,
    },
    Mandate: {
        type: 'object',
        description: 'The terms the program carries. Null means the program does not carry that term, which is a different claim from a term of zero.',
        properties: {
            maxAmountIn: { ...NULLABLE_STRING, description: 'uint256 as a decimal string' },
            maxAmountInFormatted: NULLABLE_STRING,
            minRateE18: { ...NULLABLE_STRING, description: 'floor price, 1e18 fixed point, as a decimal string' },
            minRateFormatted: NULLABLE_STRING,
            expiry: { ...NULLABLE_INT, description: 'unix seconds' },
            expiryISO: NULLABLE_STRING,
            feeBps: NULLABLE_INT,
            feePercent: { type: ['number', 'null'] },
            curve: NULLABLE_STRING,
            salt: NULLABLE_STRING,
            direction: { type: ['string', 'null'], enum: ['aToB', 'bToA', null] },
            killSwitch: {
                type: ['object', 'null'],
                properties: { registry: ADDRESS, holder: ADDRESS, label: { type: 'string' } },
                additionalProperties: true,
            },
        },
        additionalProperties: true,
    },
    Decoded: {
        type: 'object',
        required: ['guarded', 'instructionCount', 'instructions', 'mandate', 'notes'],
        properties: {
            source: { type: 'string', description: '"given", or which live position was read' },
            program: HEX,
            guarded: { type: 'boolean', description: 'PolicyEnvelope is the outermost instruction, so the limits bind rather than advise' },
            instructionCount: { type: 'integer' },
            instructions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { offset: { type: 'integer' }, name: { type: 'string' }, args: { type: 'string' } },
                    additionalProperties: true,
                },
            },
            mandate: { $ref: '#/components/schemas/Mandate' },
            notes: { type: 'array', items: { type: 'string' } },
            docked: { type: 'boolean', description: 'present when the live position was read and the maker has withdrawn it; the terms decode the same and are no longer on offer' },
        },
        additionalProperties: true,
    },
    Publication: {
        type: 'object',
        required: ['published'],
        properties: {
            source: { type: 'string' },
            topic: NULLABLE_STRING,
            published: { type: ['boolean', 'null'], description: 'null when the topic walk gave up before finishing; that is not a statement about the mandate' },
            payer: { type: 'string' },
            consensusTimestamp: { type: 'string' },
            publishedAt: { type: 'string', format: 'date-time' },
            sequenceNumber: { type: 'integer' },
            maker: NULLABLE_STRING,
            app: NULLABLE_STRING,
            chainId: NULLABLE_INT,
            mirror: { type: 'string', format: 'uri', description: 'the mirror node URL of the record, so the answer can be checked without us' },
            searched: { type: 'string', enum: ['complete', 'incomplete'] },
            pagesWalked: { type: 'integer' },
            topicExists: { type: 'boolean' },
            reason: { type: 'string' },
        },
        additionalProperties: true,
    },
    Authority: {
        type: 'object',
        required: ['label', 'registry', 'valid', 'revoked', 'reason'],
        properties: {
            label: { type: 'string' },
            registry: ADDRESS,
            valid: { type: 'boolean' },
            revoked: { type: 'boolean', description: 'ended by the owner ahead of its term, as opposed to lapsed' },
            reason: { type: 'string' },
            expiry: { type: 'integer', description: 'unix seconds' },
            secondsLeft: { type: 'integer' },
            owner: ADDRESS,
        },
        additionalProperties: true,
    },
    Reputation: {
        type: 'object',
        required: ['registry', 'agentId', 'clients', 'feedbackCount', 'clientCount', 'summaryValue', 'summaryValueDecimals'],
        properties: {
            registry: ADDRESS,
            agentId: { type: 'string' },
            clients: { type: 'array', items: ADDRESS },
            feedbackCount: { type: 'integer', description: 'entries; one client may have left several' },
            clientCount: { type: 'integer', description: 'distinct addresses' },
            summaryValue: { type: 'string' },
            summaryValueDecimals: { type: 'integer' },
        },
        additionalProperties: true,
    },
    Operator: {
        type: 'object',
        required: ['checked'],
        properties: {
            checked: { type: 'boolean', description: 'false means we could not ask, not that the identity does not exist' },
            error: { type: 'string' },
            registered: { type: 'boolean' },
            agentId: { type: 'string' },
            registry: ADDRESS,
            owner: ADDRESS,
            uriKind: { type: 'string' },
            registration: { type: 'object', additionalProperties: true },
            registrationURI: { type: 'string' },
            check: {
                type: 'object',
                properties: { vouched: { type: 'boolean' }, reason: { type: 'string' } },
                additionalProperties: true,
            },
        },
        additionalProperties: true,
    },
    Attestation: {
        type: 'object',
        description: 'EIP-712 signature over the rest of this body (canonical JSON, keys sorted), present when the service holds a signing key',
        required: ['signer', 'domain', 'types', 'message', 'signature'],
        properties: {
            signer: ADDRESS,
            domain: { type: 'object', additionalProperties: true },
            types: { type: 'object', additionalProperties: true },
            message: {
                type: 'object',
                properties: {
                    programHash: { type: 'string', description: 'keccak256 of the program bytes' },
                    answerHash: { type: 'string', description: 'keccak256 of the canonical body without this field' },
                    issuedAt: { type: 'integer', description: 'unix seconds' },
                },
                additionalProperties: true,
            },
            signature: { type: 'string' },
        },
        additionalProperties: true,
    },
    Explanation: {
        description: 'Everything the free routes answer, assembled against one position, plus the operator identity',
        allOf: [
            { $ref: '#/components/schemas/Decoded' },
            {
                type: 'object',
                properties: {
                    publication: { $ref: '#/components/schemas/Publication' },
                    operator: { $ref: '#/components/schemas/Operator' },
                    authority: { $ref: '#/components/schemas/Authority' },
                    reputation: { $ref: '#/components/schemas/Reputation' },
                    attestation: { $ref: '#/components/schemas/Attestation' },
                    metering: { $ref: '#/components/schemas/Metering' },
                },
                additionalProperties: true,
            },
        ],
    },
    Metering: {
        type: 'object',
        description: 'The bill for this call: each unit of work the body asked for and what it cost. `total` is the amount the 402 demanded and the payment settled.',
        required: ['unit', 'asset', 'components', 'total', 'hbar'],
        properties: {
            unit: { const: 'tinybar' },
            asset: { const: '0.0.0' },
            components: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['component', 'tinybar'],
                    properties: {
                        component: { enum: ['decode', 'instructions', 'publication', 'authority', 'operator'] },
                        tinybar: { type: 'integer', minimum: 0 },
                        count: { type: 'integer', minimum: 0, description: 'instructions decoded' },
                        billed: { type: 'integer', minimum: 0, description: 'instructions charged for, at most the listing cap' },
                        rate: { type: 'integer', minimum: 0, description: 'tinybar per billed instruction' },
                    },
                    additionalProperties: false,
                },
            },
            total: { type: 'string', pattern: '^[0-9]+$', description: 'the sum of the components, in tinybar' },
            hbar: { type: 'number' },
        },
        additionalProperties: false,
    },
    PaymentRequired: {
        type: 'object',
        description: 'The x402 payment requirement, also carried base64-encoded in the PAYMENT-REQUIRED header',
        properties: {
            x402Version: { type: 'integer' },
            accepts: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        additionalProperties: true,
    },
};

const json = (ref) => ({ 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } });
const answer = (ref, description) => ({ description, content: json(ref) });

const FREE_ERRORS = {
    400: answer('Error', 'the request is the problem — a program that is not hex, an id that is not a non-negative integer, a parameter given twice, a body that is not a JSON object'),
    429: {
        ...answer('RateLimited', 'the free routes have a brake; the paid one does not'),
        headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 }, description: 'seconds until this caller\'s window reopens; the same number as retryAfterSeconds' } },
    },
    502: answer('Error', 'a chain or mirror node would not answer; the request was fine'),
};

// Body parsing runs before any route, so every route that takes a body can answer these.
const TOO_LARGE = { 413: answer('Error', 'the body is over 256kb; `limit` carries the size in bytes') };

// What the MCP transport answers when the envelope is wrong, before a tool is ever reached.
const JSON_RPC_ERROR = {
    'application/json': {
        schema: {
            type: 'object',
            required: ['jsonrpc', 'error'],
            properties: {
                jsonrpc: { const: '2.0' },
                error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'integer' }, message: { type: 'string' } }, additionalProperties: true },
                id: { type: ['string', 'integer', 'null'] },
            },
            additionalProperties: true,
        },
    },
};

/**
 * One row per route. `skill` marks the four questions the Agent Card lists; `free` is the split.
 * `x-cost` is not an OpenAPI field, and is the most important word on the document to a caller
 * that pays per request.
 */
export const ROUTES = [
    {
        method: 'post', path: '/v1/mandate/decode', free: true,
        skill: { id: 'read_mandate', tags: ['swapvm', 'mandate', 'free'] },
        summary: 'What a program permits',
        description: 'Decode a SwapVM program into the limits it enforces: the size cap, the floor price, the expiry, the fee and the curve. Arithmetic on bytes you already hold. Reports whether PolicyEnvelope is outermost, which is what makes the limits binding rather than advisory.',
        body: 'ProgramBody',
        responses: {
            200: answer('Decoded', 'what these bytes permit'),
            ...FREE_ERRORS,
            422: answer('Error', 'hex, but not a valid instruction stream — a real answer about the bytes, and the one the paid route gives'),
            ...TOO_LARGE,
        },
    },
    {
        method: 'post', path: '/v1/mandate/publication', free: true,
        skill: { id: 'check_publication', tags: ['hedera', 'hcs', 'mandate', 'free'] },
        summary: 'When those exact bytes became public',
        description: `Ask Hedera Consensus Service topic ${HCS_TOPIC}, through a public mirror node rather than through us, when these exact bytes were first published and by whom. A program that decodes cleanly but has no record is a set of terms somebody handed you a minute ago, which is a different thing from a grant that has been standing.`,
        body: 'ProgramBody',
        responses: { 200: answer('Publication', 'the record, or the fact that there is none'), ...FREE_ERRORS, ...TOO_LARGE },
    },
    {
        method: 'get', path: '/v1/agent/authority', free: true,
        skill: { id: 'check_agent_authority', tags: ['ens', 'authority', 'free'] },
        summary: 'Whether the agent may still act',
        description: 'Read the ENSv2 mandate name that gates the agent. Returns whether the name is held and unexpired, and if not, whether it lapsed or was revoked ahead of its term — the owner can end the agent\'s authority at any moment without touching the position.',
        parameters: [
            { name: 'label', in: 'query', schema: { type: 'string' }, description: 'mandate name label; default "agent"' },
            { name: 'grantedUntil', in: 'query', schema: { type: 'integer' }, description: 'the mandate\'s own deadline in unix seconds; supply it to tell revocation from lapse. Filled from the live mandate when omitted.' },
        ],
        responses: { 200: answer('Authority', 'held, lapsed, or revoked'), ...FREE_ERRORS },
    },
    {
        method: 'get', path: '/v1/agent/reputation', free: true,
        skill: { id: 'check_reputation', tags: ['erc-8004', 'reputation', 'free'] },
        summary: 'What clients have said',
        description: 'Read the ERC-8004 reputation registry for an agent. The registry refuses feedback from the agent\'s own owner and operators, which is what makes the number worth reading.',
        parameters: [
            { name: 'agentId', in: 'query', schema: { type: 'string' }, description: `ERC-8004 agent id; default ${AGENT_ID}` },
        ],
        responses: { 200: answer('Reputation', 'the summary and who left it'), ...FREE_ERRORS },
    },
    {
        method: 'get', path: '/v1/position/health', free: true,
        summary: 'The live position against its mandate',
        description: 'Headroom between the current spot and the floor, the trades settled under the mandate, and alerts. Read from Sepolia, for the position the router holds now.',
        responses: {
            200: {
                description: 'the health report',
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['status', 'headroom', 'alerts'],
                            properties: {
                                status: { type: 'string' },
                                reason: { type: 'string', description: 'present when there is no position to report on' },
                                headroom: { type: ['object', 'null'], additionalProperties: true },
                                // Objects, not strings: this said strings for as long as the live
                                // position happened to raise no alert, so nothing ever checked it.
                                alerts: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        required: ['code', 'severity', 'message'],
                                        properties: {
                                            code: { type: 'string', description: 'stable, e.g. FLOOR_INVERTED, NAME_INVALID' },
                                            severity: { type: 'string', enum: ['info', 'warn', 'critical'] },
                                            since: NULLABLE_STRING,
                                            message: { type: 'string' },
                                        },
                                        additionalProperties: true,
                                    },
                                },
                                trades: { type: 'array', items: { type: 'object', additionalProperties: true } },
                            },
                            additionalProperties: true,
                        },
                    },
                },
            },
            ...FREE_ERRORS,
        },
    },
    {
        method: 'post', path: '/v1/mandate/explain', free: false,
        skill: { id: 'inspect_mandate_paid', tags: ['x402', 'hedera', 'erc-8004', 'paid'] },
        summary: 'All of it, against one position, plus the operator identity',
        description: 'The decoded limits, the publication record, the ERC-8004 identity behind the position with a check that it is held by the address that granted the mandate, the authority check, and the reputation — assembled in one answer and, when the service holds a signing key, signed. Paid per call over x402: the first request answers 402 with a payment requirement, the caller settles it on Hedera and retries with the receipt.',
        body: {
            type: 'object',
            properties: {
                program: HEX,
                agentId: { type: 'string', description: 'an ERC-8004 id, to resolve the operator behind the position' },
                maker: { ...ADDRESS, description: 'the address that granted the mandate, to check the identity vouches for it' },
            },
            required: ['program'],
            additionalProperties: true,
        },
        responses: {
            200: answer('Explanation', 'the paid answer'),
            // The body is an empty object; the requirement travels only in the header. This used to
            // say "and the body", and a client written from the document would have read `{}`.
            402: {
                description: 'no payment carried. The requirement is in the PAYMENT-REQUIRED header as base64 JSON; the body is an empty object.',
                headers: { 'PAYMENT-REQUIRED': { required: true, schema: { type: 'string' }, description: 'base64 of the x402 PaymentRequired object, #/components/schemas/PaymentRequired' } },
                content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
            400: answer('Error', 'paid, but the body was not { program: "0x…" }, or was not valid JSON'),
            422: answer('Error', 'paid, and the bytes are not a valid instruction stream — that is a real answer'),
            ...TOO_LARGE,
        },
    },
    {
        method: 'get', path: '/app', free: true,
        summary: 'The instrument',
        description: 'A page to a browser that says Accept: text/html; to anything else, the list of free routes the page reads.',
        responses: {
            200: {
                description: 'the free routes behind the page',
                content: { 'application/json': { schema: { type: 'object', required: ['page', 'free'], properties: { page: { const: 'app' }, free: { type: 'array', items: { type: 'string' } } }, additionalProperties: true } } },
            },
        },
    },
    {
        method: 'get', path: '/assets/fonts/{name}.woff2', free: true,
        summary: 'The faces both pages use',
        description: 'Served from here so neither page fetches anything from a third party. Immutable under a name that changes when the bytes do.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
            200: { description: 'the font', content: { 'font/woff2': { schema: { type: 'string', contentEncoding: 'binary' } } } },
            404: answer('Error', 'no font by that name'),
        },
    },
    {
        method: 'get', path: '/', free: true,
        summary: 'What this service is and what it charges',
        description: 'JSON for a machine; the same URL answers a page to a browser that says Accept: text/html.',
        responses: { 200: { description: 'the description', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
    },
    {
        method: 'get', path: '/.well-known/x402', free: true,
        summary: 'x402 discovery manifest',
        description: 'Per draft-hawkins-x402-dns-discovery: what this host sells, at what price, settled where.',
        responses: { 200: { description: 'the manifest', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
    },
    {
        method: 'get', path: '/.well-known/agent-card.json', free: true,
        summary: 'A2A Agent Card',
        description: 'The four questions as A2A skills, with pointers to the x402 manifest and the ERC-8004 identity.',
        responses: { 200: { description: 'the card', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
    },
    {
        method: 'post', path: '/a2a', free: true,
        summary: 'A2A JSON-RPC: negotiate a fill, then pay for the firm quote inside the task',
        description: 'message/send, tasks/get and tasks/cancel. A proposal { direction, amountIn, minAmountOut or limitRate } is priced against the live position: outside the mandate the task stays input-required with a counter-offer; inside it the task asks for payment under the a2a-x402 extension (x402.payment.required), and completes with the firm quote once the x402.payment.payload has settled on Hedera. Negotiating is free and rate limited; the deliverable costs the same as the paid route.',
        body: { type: 'object', description: 'a JSON-RPC 2.0 request', additionalProperties: true },
        responses: {
            200: { description: 'a JSON-RPC 2.0 response; protocol errors answer here too, with error.code', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
            400: answer('Error', 'the body was not valid JSON'),
            ...TOO_LARGE,
            429: { description: 'too many negotiation turns from one caller; payments are not limited', content: JSON_RPC_ERROR },
        },
    },
    {
        method: 'get', path: '/openapi.json', free: true,
        summary: 'This document',
        responses: { 200: { description: 'OpenAPI 3.1', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
    },
    {
        method: 'post', path: '/mcp', free: true,
        summary: 'MCP over Streamable HTTP',
        description: 'The same four tools the stdio server offers, as JSON-RPC over HTTP. Stateless: every request is its own session. Send Accept: application/json, text/event-stream. The paid tool needs a funded Hedera key on the server, which the public deployment does not hold; use the HTTP route for that.',
        body: { type: 'object', description: 'a JSON-RPC 2.0 request', additionalProperties: true },
        responses: {
            200: { description: 'a JSON-RPC 2.0 response; a tool that fails answers here too, with result.isError', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
            400: { description: 'not a JSON-RPC 2.0 message', content: JSON_RPC_ERROR },
            406: { description: 'the Accept header does not name both application/json and text/event-stream', content: JSON_RPC_ERROR },
            ...TOO_LARGE,
            429: FREE_ERRORS[429],
        },
    },
];

/** @param {{ origin: string, price: string, network: string, payTo: string }} service */
export function openapiDocument({ origin, price, network, payTo }) {
    const paths = {};
    for (const r of ROUTES) {
        const op = {
            operationId: r.skill?.id ?? (r.path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root'),
            summary: r.summary,
            ...(r.description ? { description: r.description } : {}),
            tags: [r.free ? 'free' : 'paid'],
            'x-cost': r.free ? 'free' : `${price} on ${network}, over x402, paid to ${payTo}`,
            ...(r.parameters ? { parameters: r.parameters } : {}),
            ...(r.body ? {
                requestBody: {
                    required: !r.free,
                    content: { 'application/json': { schema: typeof r.body === 'string' ? { $ref: `#/components/schemas/${r.body}` } : r.body } },
                },
            } : {}),
            responses: r.responses,
        };
        (paths[r.path] ??= {})[r.method] = op;
    }
    return {
        openapi: '3.1.0',
        info: {
            title: 'Batas mandate inspection',
            version: '1.0.0',
            summary: 'What limits a SwapVM program actually enforces, and when those bytes were published.',
            description: 'A Batas position states its terms only as SwapVM bytecode. These routes decode it, check when it was published to Hedera Consensus Service, whether the ENSv2 name that gates the agent still holds, and what the ERC-8004 registries say about the operator. Four answers are free; the one that assembles all of them against a single position, with the operator identity, is sold per call over x402.\n\n'
                + ATTRIBUTION,
            license: { name: 'see repository', url: 'https://github.com/PugarHuda/batas' },
        },
        servers: [{ url: origin }],
        tags: [
            { name: 'free', description: 'rate limited per caller; nothing here costs money to answer' },
            { name: 'paid', description: `${price} per call over x402 on ${network}; not rate limited — a settled payment is the quota` },
        ],
        paths,
        components: { schemas },
        externalDocs: { url: 'https://github.com/PugarHuda/batas', description: 'the project' },
    };
}

/**
 * A2A Agent Card, per https://a2a-protocol.org/latest/specification/ (1.0).
 *
 * `supportedInterfaces` is required and empty on purpose. This service does not speak A2A's
 * message/send; it answers plain HTTP and MCP, and the card exists so an agent directory that
 * crawls `/.well-known/agent-card.json` learns the skills and where the real interfaces are — the
 * OpenAPI document, the MCP endpoint, the x402 manifest — rather than being sent to a JSON-RPC
 * surface that would answer 404. `url` is the 0.x field name and is kept for readers of that shape.
 */
export function agentCard({ origin, price, network }) {
    return {
        name: 'Batas mandate inspection',
        description: 'Decodes a SwapVM program into the mandate it enforces, reports when those exact bytes were published to Hedera Consensus Service, whether the ENSv2 name gating the agent still holds, and what ERC-8004 says about the operator. Four free questions and one paid answer over x402. '
            + ATTRIBUTION,
        url: origin,
        version: '1.0.0',
        protocolVersion: '1.0',
        documentationUrl: `${origin}/openapi.json`,
        provider: { organization: 'Batas', url: 'https://github.com/PugarHuda/batas' },
        capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        supportedInterfaces: [],
        skills: ROUTES.filter((r) => r.skill).map((r) => ({
            id: r.skill.id,
            name: r.summary,
            description: `${r.description} ${r.free ? 'Free.' : `${price} on ${network}, over x402.`} ${r.method.toUpperCase()} ${origin}${r.path}`,
            tags: r.skill.tags,
            inputModes: ['application/json'],
            outputModes: ['application/json'],
        })),
        extensions: [
            {
                uri: 'https://www.x402.org/',
                description: 'The paid skill is settled over x402. The discovery manifest names the price, asset, network and payee.',
                required: false,
                params: { manifest: `${origin}/.well-known/x402` },
            },
            {
                uri: 'https://eips.ethereum.org/EIPS/eip-8004',
                description: 'The identity behind this service, on Sepolia',
                required: false,
                params: { agentId: AGENT_ID, identityRegistry: IDENTITY_REGISTRY, chainId: 11155111 },
            },
            {
                uri: 'https://modelcontextprotocol.io/',
                description: 'The same skills as MCP tools, over Streamable HTTP; or over stdio from agent/mcp.mjs in the repository',
                required: false,
                params: { endpoint: `${origin}/mcp` },
            },
        ],
    };
}
