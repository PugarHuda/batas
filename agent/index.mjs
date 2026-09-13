// Batas as a library.
//
//   import { decode, explain, lookupMandate, client } from 'batas';
//
// Everything here is a re-export of a module that already exists; nothing is constructed on
// import. A client that reaches the network is built when you call `client()`, and the payment
// libraries load on the first paid call, not before.

export { decodeProgram as decode, explain, toProgram, decideMandate, volatilityBudget, clearsFloor, OP } from './swapvm.mjs';
export { lookupMandate, lookupRevocations } from './hcs.mjs';
export { mandateNameStatus, classifyName } from './ens.mjs';
export { resolveAgent, vouchesFor } from './erc8004.mjs';
export { readReputation, feedbackFromTrade } from './reputation.mjs';
export { latestProgramOnChain, programFromStrategy } from './position.mjs';
export { decodeAnswer, publicationAnswer, authorityAnswer, reputationAnswer, nameAnswer, paymentsAnswer } from './free.mjs';
export * as deployment from './deployment.mjs';

/**
 * The deployed service over plain fetch: the free routes, and the paid one behind a payment.
 *
 * The free calls need nothing. `inspect` settles HBAR, so it takes the account to pay from (or
 * reads HEDERA_AGENT_ID / HEDERA_AGENT_KEY) and loads the x402 client only when called.
 */
export function client(origin = 'https://batas-one.vercel.app') {
    const answer = async (res) => {
        const body = await res.json();
        if (!res.ok) throw Object.assign(new Error(body.error ?? `service returned ${res.status}`), { status: res.status, body });
        return body;
    };
    const post = async (path, body) => answer(await fetch(`${origin}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
    const get = async (path, query) => answer(await fetch(`${origin}${path}?${new URLSearchParams(query)}`));
    return {
        decode: (program) => post('/v1/mandate/decode', { program }),
        publication: (program) => post('/v1/mandate/publication', { program }),
        authority: ({ label, grantedUntil } = {}) => get('/v1/agent/authority', { ...(label && { label }), ...(grantedUntil && { grantedUntil }) }),
        reputation: ({ agentId } = {}) => get('/v1/agent/reputation', agentId ? { agentId } : {}),
        name: ({ name } = {}) => get('/v1/agent/name', name ? { name } : {}),
        // `limit` is sent whenever it is given, so an out-of-range one is refused by the service
        // rather than silently replaced by the default.
        payments: ({ payer, limit } = {}) => get('/v1/payments', { ...(payer && { payer }), ...(limit !== undefined && { limit }) }),
        inspect: async (program, opts = {}) => (await import('./inspect.mjs')).payForExplanation(program, { ...opts, origin }),
    };
}
