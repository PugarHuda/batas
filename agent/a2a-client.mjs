// A counterparty agent that negotiates a fill with the Batas agent over A2A, and pays for it.
//
//   node agent/a2a-client.mjs
//
// It finds the agent from its Agent Card, refuses to go on unless the card declares the a2a-x402
// extension, and reads the mandate from the chain itself rather than from the agent it is about to
// bargain with. It then opens deliberately outside that mandate: twice the size cap, at a limit
// under the floor. The Batas agent counters; the counter is checked against the bytes this client
// read, accepted, and paid for with HEDERA_AGENT_ID inside the same task. The settlement is then
// read back from the Hedera mirror node, which neither agent keeps.

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { formatUnits, parseUnits } from 'viem';

import { X402_EXTENSION } from './a2a.mjs';
import { confirmSettlement } from './inspect.mjs';
import { latestProgramOnChain, programFromStrategy } from './position.mjs';
import { explain } from './swapvm.mjs';

const ORIGIN = (process.env.BATAS_SERVICE_URL || 'https://batas-one.vercel.app').replace(/\/v1\/.*$/, '').replace(/\/+$/, '');
const MAX_TURNS = 6;

async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
}

async function rpc(url, method, params) {
    const res = await fetch(url, {
        method: 'POST',
        // Activation per the A2A extension mechanism: the client names the extensions it speaks.
        headers: { 'Content-Type': 'application/json', 'X-A2A-Extensions': X402_EXTENSION },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    });
    const body = await res.json().catch(() => null);
    if (!body) throw new Error(`${url} answered ${res.status} with no JSON-RPC body`);
    if (body.error) throw new Error(`${method} failed ${body.error.code}: ${body.error.message}`);
    return body.result;
}

const say = (url, { taskId, contextId, text, data, metadata }) => rpc(url, 'message/send', {
    message: {
        kind: 'message', role: 'user', messageId: randomUUID(),
        ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}),
        parts: [{ kind: 'text', text }, { kind: 'data', data }],
        ...(metadata ? { metadata } : {}),
    },
});

const dataOf = (task) => task.status.message?.parts?.find((p) => p.kind === 'data')?.data;

/**
 * The whole exchange, returned rather than printed so a test can run it against a server it started.
 * `endpoint` overrides the interface the card names, for a card that advertises a public origin.
 */
export async function negotiateAndSettle({
    origin = ORIGIN, endpoint, log = () => {},
    accountId = process.env.HEDERA_AGENT_ID, privateKey = process.env.HEDERA_AGENT_KEY,
} = {}) {
    if (!accountId || !privateKey) {
        throw new Error('HEDERA_AGENT_ID and HEDERA_AGENT_KEY missing; create a testnet ECDSA account at https://portal.hedera.com');
    }

    const card = await getJson(`${origin}/.well-known/agent-card.json`);
    const ext = card.capabilities?.extensions?.find((e) => e.uri === X402_EXTENSION);
    if (!ext) throw new Error(`the Agent Card does not declare ${X402_EXTENSION}; this counterparty only pays agents that do`);
    if (!card.skills?.some((s) => s.id === 'negotiate-fill')) throw new Error('the Agent Card offers no negotiate-fill skill');
    const url = endpoint ?? card.supportedInterfaces?.find((i) => i.protocolBinding === 'JSONRPC')?.url ?? card.url;
    log(`card     ${card.name}, x402 extension ${ext.required ? 'required' : 'optional'}, JSON-RPC at ${url}`);

    // The terms from the chain, not from the agent. Everything the agent says later is checked
    // against these.
    const shipped = await latestProgramOnChain();
    if (!shipped) throw new Error('no position shipped to the live router yet');
    const mandate = explain(programFromStrategy(shipped.strategy)).mandate;
    const cap = BigInt(mandate.maxAmountIn);
    const floor = BigInt(mandate.minRateE18);
    log(`mandate  ${mandate.direction}, cap ${formatUnits(cap, 18)}, floor ${formatUnits(floor, 18)}  (read from Sepolia)`);

    let proposal = { direction: mandate.direction, amountIn: formatUnits(cap * 2n, 18), limitRate: formatUnits((floor * 9n) / 10n, 18) };
    let task;
    const turns = [];
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        log(`propose  ${proposal.amountIn} in, limit ${proposal.limitRate}${proposal.minAmountOut ? `, at least ${proposal.minAmountOut} out` : ''}`);
        task = await say(url, { taskId: task?.id, contextId: task?.contextId, text: `Proposal, turn ${turn}.`, data: proposal });
        const data = dataOf(task);
        turns.push({ proposal, state: task.status.state, answer: data });
        log(`agent    ${task.status.state}: ${task.status.message?.parts?.[0]?.text}`);
        if (task.status.message?.metadata?.['x402.payment.status'] === 'payment-required') break;
        if (task.status.state !== 'input-required' || data?.kind !== 'batas.counter-offer') {
            throw new Error(`the negotiation ended ${task.status.state}`);
        }
        const c = data.counter;
        for (const r of data.reasons) log(`  reason ${r}`);
        // Its own rule: a counter is only taken if it is inside the mandate this client read itself.
        if (parseUnits(c.amountIn, 18) > cap || parseUnits(c.limitRate, 18) < floor || c.direction !== mandate.direction) {
            await say(url, { taskId: task.id, contextId: task.contextId, text: 'Declined.', data: { decision: 'reject' } });
            throw new Error(`declined a counter outside the mandate read from chain: ${JSON.stringify(c)}`);
        }
        proposal = c;
    }
    if (task.status.message?.metadata?.['x402.payment.status'] !== 'payment-required') {
        throw new Error(`no agreement in ${MAX_TURNS} turns`);
    }
    const agreed = dataOf(task).terms;
    const required = task.status.message.metadata['x402.payment.required'];

    // The same payer and spend cap as inspect.mjs's payForExplanation: HBAR named explicitly, and
    // capped per payment, so the agent it negotiated with cannot name a larger price.
    const [{ x402Client }, { ExactHederaScheme }, { createClientHederaSigner, PrivateKey }] =
        await Promise.all([import('@x402/fetch'), import('@x402/hedera/exact/client'), import('@x402/hedera')]);
    const MAX_PER_CALL = process.env.X402_MAX_TINYBAR || '1000000'; // 0.01 HBAR
    const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), { network: 'hedera:testnet' });
    const client = x402Client.fromConfig({
        schemes: [{ network: 'hedera:testnet', client: new ExactHederaScheme(signer) }],
        spendControls: { allowedAssets: [{ network: 'hedera:testnet', asset: '0.0.0', maxAmountPerPayment: MAX_PER_CALL }] },
    });
    const requirement = required.accepts[0];
    log(`pay      ${Number(requirement.amount) / 1e8} HBAR to ${requirement.payTo} from ${accountId}, cap ${Number(MAX_PER_CALL) / 1e8} HBAR`);
    const payload = await client.createPaymentPayload(required);

    task = await say(url, {
        taskId: task.id, contextId: task.contextId, text: 'Payment for the agreed fill.', data: agreed,
        metadata: { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': payload },
    });
    const meta = task.status.message?.metadata ?? {};
    log(`agent    ${task.status.state}: ${task.status.message?.parts?.[0]?.text}`);
    if (task.status.state !== 'completed') {
        throw new Error(`payment not completed: ${meta['x402.payment.status']} ${meta['x402.payment.error'] ?? ''}`);
    }
    const receipt = meta['x402.payment.receipts'].at(-1);
    const quote = task.artifacts?.[0]?.parts?.find((p) => p.kind === 'data')?.data;

    const onLedger = await confirmSettlement(receipt.transaction, { payer: accountId, payTo: requirement.payTo, maxAmount: MAX_PER_CALL });
    log(onLedger.confirmed
        ? `ledger   ${onLedger.paid / 1e8} HBAR left ${accountId}, ${onLedger.received / 1e8} reached ${requirement.payTo} at ${onLedger.settledAt}  ${onLedger.mirror}`
        : `ledger   ${onLedger.confirmed === false ? 'NOT confirmed' : 'not checked'}: ${onLedger.reason}`);

    return { card, turns, task, agreed, quote, receipt, onLedger };
}

async function main() {
    console.log(`service  ${ORIGIN}`);
    const { quote, onLedger } = await negotiateAndSettle({ log: (m) => console.log(m) });
    console.log('');
    console.log('firm quote');
    console.log(`  fill        ${quote.fill.amountIn} in -> ${quote.fill.amountOut} out (at least ${quote.fill.minAmountOut}), ${quote.fill.direction}`);
    console.log(`  mandate     cap ${quote.mandate.maxAmountIn}, floor ${quote.mandate.minRate}, largest clearing now ${quote.mandate.largestClearingInputNow}`);
    console.log(`  read at     Sepolia block ${quote.readAt.blockNumber}, position ${quote.position.strategyHash}`);
    if (onLedger.confirmed !== true) process.exit(1);
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage || e.message || e));
        process.exit(1);
    });
}
