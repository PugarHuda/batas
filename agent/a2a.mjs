// Agent2Agent: another agent negotiates a fill with the Batas agent, then pays for the firm quote.
//
// Everything else this service sells is sold to whoever sends an HTTP request. This is the same
// position sold to another agent in the shape agents use to talk to each other: A2A JSON-RPC
// (message/send, tasks/get, tasks/cancel), one task per negotiation, and payment carried inside
// that task by the a2a-x402 extension rather than by an HTTP 402.
//
// The negotiation is not a script. Every turn the proposal is priced against the live Aqua position
// at one Sepolia block: the size cap and floor are read out of the PolicyEnvelope bytes, the largest
// input that still clears the floor comes from the same bisection the health report uses, and the
// output is the router's own `quote()` at that block. A proposal outside the mandate is answered
// with the nearest one inside it; a proposal inside it is accepted, and the firm quote is released
// when the payment has settled on Hedera through the facilitator.
//
// No key is needed on this side. The payer signs, the facilitator pays the Hedera fee, and this
// server only verifies and settles through it, which is what lets the deployment run it at all.

import { randomUUID } from 'node:crypto';
import { createPublicClient, http, formatUnits, parseUnits, decodeAbiParameters, parseAbiParameters } from 'viem';
import { sepolia } from 'viem/chains';

import { explain, E18 } from './swapvm.mjs';
import { largestClearingInput } from './health.mjs';
import { latestProgramOnChain, programFromStrategy } from './position.mjs';
import { tryQuote } from './killswitch.mjs';
import { AQUA, ROUTER, OWNER, TOKENS, AGENT_ID, SEPOLIA_RPC } from './deployment.mjs';

/** The a2a-x402 extension, v0.1, as its spec names it. */
export const X402_EXTENSION = 'https://github.com/google-a2a/a2a-x402/v0.1';

const NETWORK = 'hedera:testnet';
const TERMINAL = new Set(['completed', 'canceled', 'failed', 'rejected']);
const HEX = /^0x[0-9a-fA-F]*$/;
const DECIMAL = /^\d+(\.\d{1,18})?$/;
const fmt = (wei) => formatUnits(wei, 18);
const FILL_DESCRIPTION = 'A firm quote for the fill negotiated in this task, read from the live position';
const INSPECT_DESCRIPTION = 'Decode a SwapVM program into the mandate it enforces, with its publication, operator, authority and reputation';

const SAFE_BALANCES = [{
    name: 'safeBalances', type: 'function', stateMutability: 'view',
    inputs: [
        { name: 'maker', type: 'address' }, { name: 'app', type: 'address' },
        { name: 'strategyHash', type: 'bytes32' }, { name: 'token0', type: 'address' },
        { name: 'token1', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
}];

const chain = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

/** A JSON-RPC error that is meant for the caller, carried on an Error so a handler can throw it. */
const fault = (code, message) => Object.assign(new Error(message), { rpc: { code, message } });

function amount(value, name, { optional = false } = {}) {
    if (value === undefined || value === null) {
        if (optional) return null;
        throw fault(-32602, `${name} is required`);
    }
    if (!DECIMAL.test(String(value))) throw fault(-32602, `${name} must be a decimal token amount such as "2.5"`);
    return parseUnits(String(value), 18);
}

/** A proposal as the counterparty sends it: decimal strings, parsed to wei. Refused as params if malformed. */
export function readProposal(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw fault(-32602, 'the message needs a data part: { direction, amountIn, minAmountOut or limitRate }');
    }
    if (data.direction !== 'aToB' && data.direction !== 'bToA') throw fault(-32602, 'direction must be "aToB" or "bToA"');
    const amountIn = amount(data.amountIn, 'amountIn');
    if (amountIn === 0n) throw fault(-32602, 'amountIn must be above zero');
    return {
        direction: data.direction,
        amountIn,
        minAmountOut: amount(data.minAmountOut, 'minAmountOut', { optional: true }),
        limitRateE18: amount(data.limitRate, 'limitRate', { optional: true }),
    };
}

// The ship scan walks up to 60,000 blocks of unindexed logs, and one negotiation asks several
// times in a minute. The reserves and the quote are read fresh every turn; only where the position
// is gets remembered, and a dock is still caught because `safeBalances` reverts for it.
let shipCache = { at: 0, value: null };

/** The live position at one block: its order, its mandate, its reserves, and a quote pinned there. */
export async function readLive(pub = chain) {
    if (!(Date.now() - shipCache.at < 60_000 && shipCache.value)) {
        shipCache = { at: Date.now(), value: await latestProgramOnChain({ client: pub }) };
    }
    const found = shipCache.value;
    if (!found) return { none: true, reason: 'no mandate has been shipped to the live router yet' };
    const program = programFromStrategy(found.strategy);
    const [order] = decodeAbiParameters(parseAbiParameters('(address maker, uint256 traits, bytes data)'), found.strategy);
    const blockNumber = await pub.getBlockNumber();
    let reserves;
    try {
        const [a, b] = await pub.readContract({
            address: AQUA, abi: SAFE_BALANCES, functionName: 'safeBalances',
            args: [OWNER, ROUTER, found.strategyHash, TOKENS[0], TOKENS[1]], blockNumber,
        });
        reserves = { a, b };
    } catch (e) {
        if (e.walk?.((x) => x.name === 'ContractFunctionRevertedError')) {
            return { none: true, reason: 'the maker has docked this position; nothing is on offer' };
        }
        throw e;
    }
    // The quote is read at the same block as the reserves, so the size the bisection chose and the
    // output the router gives for it describe one state of the pool rather than two.
    const atBlock = { readContract: (args) => pub.readContract({ ...args, blockNumber }) };
    return {
        program, order, strategyHash: found.strategyHash, mandate: explain(program).mandate, reserves, blockNumber,
        quote: (amountIn) => tryQuote(order, amountIn, { client: atBlock }),
    };
}

/**
 * Price one proposal against the live position: accept it, counter with the nearest terms the
 * mandate allows, or reject when nothing would settle at all.
 */
export async function evaluate(proposal, live, now = Math.floor(Date.now() / 1000)) {
    const m = live.mandate;
    if (m.expiry != null && now > m.expiry) {
        return { verdict: 'reject', reasons: [`the mandate expired at ${m.expiryISO}; the router refuses every trade`] };
    }
    // ponytail: tryQuote's taker data is aToB only, which is the live mandate's direction. A bToA
    // position would be refused by the router here and rejected; it needs a second taker-data word.
    const direction = m.direction ?? 'aToB';
    const [reserveIn, reserveOut] = direction === 'aToB' ? [live.reserves.a, live.reserves.b] : [live.reserves.b, live.reserves.a];
    const floor = m.minRateE18 == null ? 0n : BigInt(m.minRateE18);
    const cap = m.maxAmountIn == null ? reserveIn : BigInt(m.maxAmountIn);
    const clearing = largestClearingInput({ reserveA: reserveIn, reserveB: reserveOut, minRateE18: floor, feeBps: m.feeBps, ceiling: cap });
    if (clearing === 0n) {
        return { verdict: 'reject', reasons: ['no trade size clears the floor at these reserves; the mandate authorises nothing right now'] };
    }

    const reasons = [];
    if (proposal.direction !== direction) {
        reasons.push(`the mandate only permits ${direction}; the router refuses ${proposal.direction}`);
    }
    let amountIn = proposal.amountIn;
    if (amountIn > clearing) {
        reasons.push(amountIn > cap
            ? `${fmt(amountIn)} in is above the mandate's ${fmt(cap)} size cap; the largest input that also clears the floor now is ${fmt(clearing)}`
            : `${fmt(amountIn)} in is inside the cap but would settle under the floor; the largest input that clears now is ${fmt(clearing)}`);
        amountIn = clearing;
    }

    const quoted = await live.quote(amountIn);
    if (!quoted.ok) {
        return { verdict: 'reject', reasons: [`the router refuses ${fmt(amountIn)} in at block ${live.blockNumber}: ${quoted.why}`] };
    }
    const amountOut = quoted.amountOut;
    // Rounded up, as the router's check is `amountOut·1e18 >= amountIn·floor`: a limit one wei under
    // this would name a fill the chain refuses.
    const floorOut = (amountIn * floor + E18 - 1n) / E18;
    if (amountOut < floorOut) {
        return { verdict: 'reject', reasons: [`the router quotes ${fmt(amountOut)} out, under the floor, at block ${live.blockNumber}`] };
    }
    // A minimum stated for the opening size is scaled with the size, so it keeps meaning the same
    // price once the size has been countered.
    const minFromAmount = proposal.minAmountOut == null ? 0n : (proposal.minAmountOut * amountIn) / proposal.amountIn;
    const minFromRate = proposal.limitRateE18 == null ? 0n : (amountIn * proposal.limitRateE18) / E18;
    const theirs = minFromAmount > minFromRate ? minFromAmount : minFromRate;
    let minAmountOut = theirs;
    if (theirs < floorOut) {
        reasons.push(`a limit of ${fmt(theirs)} out allows a fill under the mandate's floor of ${fmt(floor)}; the agent cannot sign terms the router would refuse, so the limit is the floor`);
        minAmountOut = floorOut;
    } else if (theirs > amountOut) {
        reasons.push(`the position gives ${fmt(amountOut)} out for ${fmt(amountIn)} in at block ${live.blockNumber}, under the ${fmt(theirs)} asked`);
        minAmountOut = amountOut;
    }

    return {
        verdict: reasons.length ? 'counter' : 'accept',
        reasons,
        terms: { direction, amountIn: fmt(amountIn), minAmountOut: fmt(minAmountOut), limitRate: fmt((minAmountOut * E18) / amountIn) },
        amountOut: fmt(amountOut),
        mandate: { maxAmountIn: fmt(cap), minRate: fmt(floor), largestClearingInputNow: fmt(clearing) },
    };
}

/** The deliverable: the accepted terms, what the router gives for them, and the block it was read at. */
function firmQuote(result, live) {
    const m = live.mandate;
    const [tokenIn, tokenOut] = m.direction === 'bToA' ? [TOKENS[1], TOKENS[0]] : [TOKENS[0], TOKENS[1]];
    return {
        kind: 'batas.firm-quote',
        fill: { ...result.terms, amountOut: result.amountOut, tokenIn, tokenOut },
        mandate: {
            ...result.mandate, feePercent: m.feePercent, expiry: m.expiryISO, direction: m.direction, killSwitch: m.killSwitch ?? null,
        },
        position: { strategyHash: live.strategyHash, maker: OWNER, router: ROUTER, agentId: AGENT_ID },
        readAt: { chain: 'eip155:11155111', blockNumber: Number(live.blockNumber) },
        note: "amountOut is the router's own quote() at that block. The chain prices the swap again when it settles, so a trade in between moves it; minAmountOut is the limit both agents agreed, and the floor bounds it either way.",
    };
}

/** The Agent Card: the existing one, plus the A2A interface, the two negotiated skills and the x402 extension. */
export function a2aCard(base, { origin, price }) {
    const url = `${origin}/a2a`;
    const cost = `${Number(price.amount) / 1e8} HBAR on ${NETWORK}`;
    return {
        ...base,
        url,
        protocolVersion: '0.3.0',
        preferredTransport: 'JSONRPC',
        // The existing card left this empty because nothing here spoke message/send. Something does now.
        supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '0.3.0' }],
        additionalInterfaces: [{ url, transport: 'JSONRPC' }],
        capabilities: {
            ...base.capabilities,
            extensions: [{
                uri: X402_EXTENSION,
                description: `The deliverable of every task is released against an x402 payment of ${cost}, requested and settled inside the task.`,
                required: true,
            }],
        },
        defaultInputModes: ['application/json', 'text/plain'],
        defaultOutputModes: ['application/json', 'text/plain'],
        skills: [
            ...base.skills,
            {
                id: 'negotiate-fill',
                name: 'Negotiate a fill against the live position',
                description: `Send a data part { direction, amountIn, minAmountOut or limitRate } in token units. It is priced against the live Aqua position and its PolicyEnvelope at one Sepolia block: outside the mandate you get a counter-offer (the largest size that clears, or a limit at the floor) and the task stays input-required; inside it the terms are accepted and the firm quote is released for ${cost}, over the a2a-x402 extension.`,
                tags: ['a2a', 'negotiation', 'aqua', 'x402', 'hedera'],
                examples: ['{"direction":"aToB","amountIn":"2.5","limitRate":"1.95"}'],
                inputModes: ['application/json'],
                outputModes: ['application/json'],
            },
            {
                id: 'inspect-mandate',
                name: 'Inspect a mandate, paid inside the task',
                description: `Send a data part { skill: "inspect-mandate", program? }. The same assembled answer as POST /v1/mandate/explain, for the live position when no program is given, released for ${cost} over the a2a-x402 extension.`,
                tags: ['a2a', 'swapvm', 'mandate', 'x402', 'hedera'],
                examples: ['{"skill":"inspect-mandate"}'],
                inputModes: ['application/json'],
                outputModes: ['application/json'],
            },
        ],
    };
}

/**
 * Serve the card and the JSON-RPC endpoint on `app`.
 *
 * `resourceServer` is the one the paywall already uses, so both paid surfaces verify and settle
 * through one facilitator configuration. `inspect` is the paid handler from service.mjs, passed in
 * rather than imported because service.mjs imports this file.
 */
export function mountA2A(app, { card, resourceServer, origin, payTo, price, overLimit = () => 0, inspect }) {
    const endpoint = `${origin}/a2a`;
    // ponytail: tasks live in this instance's memory, capped at 1000. A serverless deployment may
    // answer the next turn from another instance, so every turn carries its own terms and nothing
    // below depends on the map except tasks/get and accumulated receipts. A shared store is the
    // upgrade if tasks/get across instances ever matters.
    const tasks = new Map();
    let ready;

    app.get('/.well-known/agent-card.json', (_req, res) => res.json(a2aCard(card(), { origin, price })));

    async function paymentRequired(description) {
        // The facilitator's /supported names the Hedera fee payer, and a requirement without it
        // cannot be signed. Fetched once; a failure is not remembered, so the next task retries.
        ready ??= resourceServer.initialize().catch((e) => { ready = undefined; throw e; });
        await ready;
        const accepts = await resourceServer.buildPaymentRequirements({ scheme: 'exact', network: NETWORK, payTo, price });
        return resourceServer.createPaymentRequiredResponse(accepts, { url: endpoint, description, mimeType: 'application/json' });
    }

    async function send(params) {
        const msg = params?.message;
        if (!msg || typeof msg !== 'object' || msg.role !== 'user' || !Array.isArray(msg.parts)) {
            throw fault(-32602, 'params.message must be a Message with role "user" and parts');
        }
        const prior = msg.taskId ? tasks.get(msg.taskId) : undefined;
        if (prior && TERMINAL.has(prior.task.status.state)) {
            throw fault(-32602, `task ${prior.task.id} is already ${prior.task.status.state}; start a new task`);
        }
        const id = msg.taskId ?? randomUUID();
        const contextId = prior?.task.contextId ?? msg.contextId ?? randomUUID();
        const data = msg.parts.find((p) => p?.kind === 'data')?.data;

        const reply = (state, text, { data: out, metadata, artifacts, agreed } = {}) => {
            const message = {
                kind: 'message', role: 'agent', messageId: randomUUID(), taskId: id, contextId,
                parts: [{ kind: 'text', text }, ...(out ? [{ kind: 'data', data: out }] : [])],
                ...(metadata ? { metadata } : {}),
            };
            const task = {
                kind: 'task', id, contextId,
                status: { state, message, timestamp: new Date().toISOString() },
                history: [...(prior?.task.history ?? []), msg, message],
                ...(artifacts ? { artifacts } : {}),
            };
            tasks.delete(id);
            tasks.set(id, { task, agreed });
            if (tasks.size > 1000) tasks.delete(tasks.keys().next().value);
            return task;
        };

        if (data?.decision === 'reject') return reply('canceled', 'Understood; no fill.');
        if (msg.metadata?.['x402.payment.status'] === 'payment-submitted') return settle(msg, reply, prior, data);
        return negotiate(reply, data);
    }

    const counter = (reply, result, live, suffix = '') => (result.verdict === 'reject'
        ? reply('rejected', `${result.reasons.join('; ')}.${suffix}`, {
            data: { kind: 'batas.refusal', reasons: result.reasons, readAt: { blockNumber: Number(live.blockNumber) } },
        })
        : reply('input-required', `Counter-offer: ${result.terms.amountIn} in for at least ${result.terms.minAmountOut} out.${suffix}`, {
            data: {
                kind: 'batas.counter-offer', counter: result.terms, reasons: result.reasons, quotedAmountOut: result.amountOut,
                mandate: result.mandate, readAt: { blockNumber: Number(live.blockNumber) },
            },
        }));

    const offer = async (reply, terms, text, extra = {}) => reply('input-required', text, {
        data: { kind: 'batas.terms-accepted', terms, ...extra },
        metadata: {
            'x402.payment.status': 'payment-required',
            'x402.payment.required': await paymentRequired(terms.skill === 'inspect-mandate' ? INSPECT_DESCRIPTION : FILL_DESCRIPTION),
        },
        agreed: terms,
    });

    /** What the program to inspect is, or a refusal before any payment is asked for. */
    async function inspectable(program) {
        if (program === undefined) {
            const live = await readLive();
            if (live.none) return { refused: live.reason };
            program = live.program;
        }
        if (typeof program !== 'string' || !HEX.test(program)) throw fault(-32602, 'program must be a 0x hex string');
        try {
            explain(program);
        } catch (e) {
            // Refused before payment, so a malformed program is never something a caller paid to hear.
            return { refused: `those bytes are not a SwapVM program: ${e.message}` };
        }
        return { program };
    }

    async function negotiate(reply, data) {
        if (data?.skill === 'inspect-mandate') {
            const found = await inspectable(data.program);
            if (found.refused) return reply('rejected', found.refused);
            return offer(reply, { skill: 'inspect-mandate', program: found.program }, 'Inspection of this program is released on payment.');
        }
        const proposal = readProposal(data);
        const live = await readLive();
        if (live.none) return reply('rejected', live.reason);
        const result = await evaluate(proposal, live);
        if (result.verdict !== 'accept') return counter(reply, result, live);
        return offer(reply, { skill: 'negotiate-fill', ...result.terms },
            `Accepted: ${result.terms.amountIn} in for at least ${result.terms.minAmountOut} out. The router quotes ${result.amountOut} at block ${live.blockNumber}; the firm quote is released on payment.`,
            { quotedAmountOut: result.amountOut, mandate: result.mandate, readAt: { blockNumber: Number(live.blockNumber) } });
    }

    async function settle(msg, reply, prior, data) {
        // The terms this server accepted when it remembers them, otherwise the ones the client
        // restates. Either way they are priced again below before anything is charged.
        const terms = prior?.agreed ?? data;
        const isInspect = terms?.skill === 'inspect-mandate';
        const required = await paymentRequired(isInspect ? INSPECT_DESCRIPTION : FILL_DESCRIPTION);
        const receipts = prior?.task.status.message.metadata?.['x402.payment.receipts'] ?? [];
        const refuse = (code, text) => reply('input-required', text, {
            metadata: {
                'x402.payment.status': 'payment-rejected', 'x402.payment.error': code, 'x402.payment.required': required,
                ...(receipts.length ? { 'x402.payment.receipts': receipts } : {}),
            },
            agreed: prior?.agreed,
        });

        const payload = msg.metadata?.['x402.payment.payload'];
        let requirement;
        try {
            requirement = payload && typeof payload === 'object' ? resourceServer.findMatchingRequirements(required.accepts, payload) : undefined;
        } catch {
            requirement = undefined;
        }
        if (!requirement) return refuse('INVALID_AMOUNT', 'That payload does not answer the requirement this task issued; nothing was charged.');

        // Verified before any chain is read. Matching the requirement only compares the payload with
        // a requirement anyone can copy from a 402, and this path skips the free routes' rate limit,
        // so an unsigned copy would otherwise buy unlimited Sepolia reads before being refused.
        const verified = await resourceServer.verifyPayment(payload, requirement);
        if (!verified.isValid) {
            return refuse(verified.invalidReason ?? 'INVALID_SIGNATURE', `The facilitator did not verify this payment (${verified.invalidMessage ?? verified.invalidReason}); nothing was charged.`);
        }

        // The deliverable is produced before the payment is settled, so a chain that moved or an
        // upstream that failed costs the caller nothing.
        let deliverable;
        if (isInspect) {
            const found = await inspectable(terms.program);
            if (found.refused) return reply('rejected', `${found.refused}; nothing was charged.`);
            const answer = await inspect({ program: found.program, agentId: AGENT_ID, maker: OWNER });
            if (answer.status !== 200) return reply('rejected', `${answer.body.error}; nothing was charged.`);
            deliverable = { name: 'mandate-inspection', data: answer.body };
        } else {
            const proposal = readProposal(terms);
            const live = await readLive();
            if (live.none) return reply('rejected', `${live.reason}; nothing was charged.`);
            const result = await evaluate(proposal, live);
            if (result.verdict !== 'accept') return counter(reply, result, live, ' The position moved since these terms were accepted; nothing was charged.');
            deliverable = { name: 'firm-quote', data: firmQuote(result, live) };
        }

        const receipt = await resourceServer.settlePayment(payload, requirement);
        const all = [...receipts, receipt];
        if (!receipt.success) {
            return reply('failed', `Settlement failed: ${receipt.errorMessage ?? receipt.errorReason}.`, {
                metadata: { 'x402.payment.status': 'payment-failed', 'x402.payment.error': 'SETTLEMENT_FAILED', 'x402.payment.receipts': all },
            });
        }
        return reply('completed', `Paid in ${receipt.transaction} on ${receipt.network}. The ${deliverable.name} is attached.`, {
            metadata: { 'x402.payment.status': 'payment-completed', 'x402.payment.receipts': all },
            artifacts: [{ artifactId: randomUUID(), name: deliverable.name, parts: [{ kind: 'data', data: deliverable.data }] }],
        });
    }

    app.post('/a2a', async (req, res) => {
        const body = req.body;
        const plain = body && typeof body === 'object' && !Array.isArray(body);
        const id = plain && (typeof body.id === 'string' || typeof body.id === 'number') ? body.id : null;
        const answer = (payload) => res.json({ jsonrpc: '2.0', id, ...payload });
        if (String(req.get('X-A2A-Extensions') ?? '').includes(X402_EXTENSION)) res.set('X-A2A-Extensions', X402_EXTENSION);
        if (!plain || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
            return answer({ error: { code: -32600, message: 'not a JSON-RPC 2.0 request; batches are not served' } });
        }
        // Negotiating reads Sepolia for free, so it sits behind the same brake as the free routes. A
        // payment does not: a settled payment is the quota, as on the paid HTTP route.
        const paying = body.params?.message?.metadata?.['x402.payment.status'] === 'payment-submitted';
        const wait = paying ? 0 : overLimit(req);
        if (wait) {
            return res.status(429).set('Retry-After', String(wait))
                .json({ jsonrpc: '2.0', id, error: { code: -32000, message: `too many requests; retry in ${wait}s` } });
        }
        try {
            switch (body.method) {
                case 'message/send':
                    return answer({ result: await send(body.params) });
                case 'tasks/get': {
                    const found = tasks.get(body.params?.id);
                    if (!found) throw fault(-32001, `no task ${body.params?.id} on this instance`);
                    return answer({ result: found.task });
                }
                case 'tasks/cancel': {
                    const found = tasks.get(body.params?.id);
                    if (!found) throw fault(-32001, `no task ${body.params?.id} on this instance`);
                    if (TERMINAL.has(found.task.status.state)) throw fault(-32002, `task is already ${found.task.status.state}`);
                    const task = { ...found.task, status: { state: 'canceled', timestamp: new Date().toISOString() } };
                    tasks.set(task.id, { task });
                    return answer({ result: task });
                }
                case 'message/stream':
                case 'tasks/resubscribe':
                case 'tasks/pushNotificationConfig/set':
                case 'tasks/pushNotificationConfig/get':
                    throw fault(-32004, `${body.method} is not supported; this agent answers message/send synchronously`);
                default:
                    throw fault(-32601, `method ${body.method} is not served`);
            }
        } catch (e) {
            if (e.rpc) return answer({ error: e.rpc });
            return answer({ error: { code: -32603, message: String(e.shortMessage ?? e.message ?? e) } });
        }
    });
}
