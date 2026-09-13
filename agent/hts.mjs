// Batas Inspection Credit: an HTS token with a custom fee schedule, accepted by the paid inspection.
//
//   node agent/hts.mjs --create        once: create the token, associate the agent, fund it
//   node agent/hts.mjs --fund 100      send the paying agent more credits from the treasury
//   node agent/hts.mjs --status        the token, its fee schedule and its balances, from the mirror
//
// HBAR stays the first way to pay, because it needs no association. The credit exists for the other
// half of the Hedera story: a token whose fee schedule the network enforces on every transfer. Every
// x402 settlement in BIC pays the fractional fee to the service account as an assessed custom fee on
// the same transaction, and the mirror node records it, so the fee is a fact about the ledger rather
// than a line in this service's books.

import 'dotenv/config';

import { HTS_TOKEN, PUBLISHER } from './deployment.mjs';
import { MIRROR, mirrorGet } from './hcs.mjs';

export const HTS_SYMBOL = 'BIC';
export const HTS_DECIMALS = 2;
// 1.00 BIC per answer, in the token's smallest unit, which is the unit x402 amounts are stated in.
export const HTS_PRICE = process.env.BATAS_HTS_PRICE || '100';
// 1%, at least one unit so a small price can never round the fee to nothing, and charged on top of
// the transfer (exclusive) so the payer pays it. A fee deducted from what the receiver gets would
// fall on the service account, which collects it and is therefore exempt: nothing would be assessed.
export const HTS_FEE = { numerator: 1, denominator: 100, min: 1, max: 100 };

/** The payment option the paywall lists after HBAR, in the middleware's route config shape. */
export function htsAccept(payTo) {
    return { scheme: 'exact', network: 'hedera:testnet', price: { asset: HTS_TOKEN, amount: HTS_PRICE }, payTo };
}

/** The same option as the discovery manifest states it: asset and amount rather than a price. */
export function htsManifestAccept(payTo) {
    return { scheme: 'exact', network: 'hedera:testnet', asset: HTS_TOKEN, amount: HTS_PRICE, payTo };
}

/**
 * Read one settlement in the token back from the mirror node.
 *
 * The facilitator checks only the transfer body: `amount` from payer to payTo. The fee schedule is
 * applied by the network at consensus, so the only place to see that it was actually paid is the
 * record, where `assessed_custom_fees` names the collector, the amount and who effectively paid it.
 * `confirmed` is true only when the transaction succeeded, the credits reached payTo, and a fee in
 * the token was assessed to the collector on the payer. Null means the mirror could not answer, which
 * is not the same as nothing having happened.
 */
export async function confirmTokenSettlement(transaction, {
    payer, payTo = PUBLISHER, token = HTS_TOKEN, collector = PUBLISHER, attempts = 8, delayMs = 1500,
} = {}) {
    const parts = /^(\d+\.\d+\.\d+)[@-](\d+)[.-](\d+)$/.exec(String(transaction ?? ''));
    if (!parts) return { confirmed: false, reason: `not a Hedera transaction id: ${transaction}` };
    const id = `${parts[1]}-${parts[2]}-${parts[3]}`;
    const url = `${MIRROR}/transactions/${id}`;

    // A settlement reaches the mirror a few seconds after consensus, so a 404 is asked again.
    let res;
    for (let i = 0; i < attempts; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
        res = await mirrorGet(url);
        if (res.status !== 404) break;
    }
    if (!res.ok) return { confirmed: null, transaction: id, reason: `mirror node ${res.status}` };
    const rows = (await res.json()).transactions ?? [];
    const tx = rows.find((t) => !t.parent_consensus_timestamp && !(t.nonce > 0)) ?? rows[0];
    if (!tx) return { confirmed: null, transaction: id, reason: 'the mirror node returned no record for this id' };

    const moves = (tx.token_transfers ?? []).filter((t) => t.token_id === token);
    const net = (account) => moves.filter((t) => t.account === account).reduce((s, t) => s + Number(t.amount), 0);
    const fee = (tx.assessed_custom_fees ?? [])
        .filter((f) => f.token_id === token && f.collector_account_id === collector)
        .filter((f) => !payer || (f.effective_payer_account_ids ?? []).includes(payer))
        .reduce((s, f) => s + Number(f.amount), 0);
    const facts = {
        transaction: id,
        result: tx.result,
        consensusTimestamp: tx.consensus_timestamp,
        token,
        paid: payer ? -net(payer) : null,
        received: net(payTo),
        fee,
        assessedCustomFees: tx.assessed_custom_fees ?? [],
        mirror: url,
    };
    if (tx.result !== 'SUCCESS') return { confirmed: false, ...facts, reason: `the transaction did not succeed: ${tx.result}` };
    if (!(facts.received > 0)) return { confirmed: false, ...facts, reason: `no ${token} reached ${payTo}` };
    if (!(fee > 0)) return { confirmed: false, ...facts, reason: `no custom fee in ${token} was assessed to ${collector}` };
    return { confirmed: true, ...facts };
}

// The SDK is loaded only here, on the write path: the paywall imports this file for its payment
// option, and a signing SDK has no business in the deployed service's cold start.
async function operator(id, key) {
    if (!id || !key) throw new Error('HEDERA_SERVICE_ID/KEY and HEDERA_AGENT_ID/KEY are required to create or fund the token');
    const { Client, PrivateKey, AccountId } = await import('@hiero-ledger/sdk');
    // Portal accounts hand out ECDSA keys as DER or as raw hex; accept either.
    const priv = key.startsWith('302') ? PrivateKey.fromStringDer(key) : PrivateKey.fromStringECDSA(key);
    return { client: Client.forTestnet().setOperator(AccountId.fromString(id), priv), priv, id };
}

async function create() {
    const sdk = await import('@hiero-ledger/sdk');
    const service = await operator(process.env.HEDERA_SERVICE_ID, process.env.HEDERA_SERVICE_KEY);
    const agent = await operator(process.env.HEDERA_AGENT_ID, process.env.HEDERA_AGENT_KEY);
    const pub = service.priv.publicKey;

    const fee = new sdk.CustomFractionalFee()
        .setNumerator(HTS_FEE.numerator).setDenominator(HTS_FEE.denominator)
        .setMin(HTS_FEE.min).setMax(HTS_FEE.max)
        .setAssessmentMethod(sdk.FeeAssessmentMethod.Exclusive)
        .setFeeCollectorAccountId(service.id);
    // The service account is treasury and collector, so the fee lands where the price does. The fee
    // schedule key is kept so the schedule can only ever change in public, by a transaction.
    const created = await new sdk.TokenCreateTransaction()
        .setTokenName('Batas Inspection Credit')
        .setTokenSymbol(HTS_SYMBOL)
        .setTokenMemo('Pays for Batas mandate inspection over x402')
        .setDecimals(HTS_DECIMALS)
        .setInitialSupply(1_000_000 * 10 ** HTS_DECIMALS)
        .setTokenType(sdk.TokenType.FungibleCommon)
        .setTreasuryAccountId(service.id)
        .setAdminKey(pub).setSupplyKey(pub).setFeeScheduleKey(pub)
        .setCustomFees([fee])
        .execute(service.client);
    const receipt = await created.getReceipt(service.client);
    const token = receipt.tokenId.toString();
    console.log(`token     ${token}  created in ${created.transactionId}`);

    // Explicit, even though the agent account has unlimited auto-association: that is a setting that
    // can change, and a payment that depends on it would start failing the day it does.
    const assoc = await new sdk.TokenAssociateTransaction().setAccountId(agent.id).setTokenIds([token]).execute(agent.client);
    await assoc.getReceipt(agent.client);
    console.log(`associate ${agent.id}  ${assoc.transactionId}`);
    service.client.close();
    agent.client.close();
    await fund(token, 1000);
    console.log(`\nset HTS_TOKEN to ${token} in agent/deployment.mjs`);
}

async function fund(token, whole) {
    if (!token) throw new Error('no token: run --create first and set HTS_TOKEN in agent/deployment.mjs');
    const sdk = await import('@hiero-ledger/sdk');
    const service = await operator(process.env.HEDERA_SERVICE_ID, process.env.HEDERA_SERVICE_KEY);
    const agentId = process.env.HEDERA_AGENT_ID;
    const units = Math.round(Number(whole) * 10 ** HTS_DECIMALS);
    const tx = await new sdk.TransferTransaction()
        .addTokenTransfer(token, service.id, -units)
        .addTokenTransfer(token, agentId, units)
        .execute(service.client);
    await tx.getReceipt(service.client);
    console.log(`fund      ${whole} ${HTS_SYMBOL} to ${agentId}  ${tx.transactionId}`);
    service.client.close();
}

export async function status(token = HTS_TOKEN) {
    const t = await (await mirrorGet(`${MIRROR}/tokens/${token}`)).json();
    console.log(`token     ${t.token_id}  ${t.name} (${t.symbol}), ${t.decimals} decimals, treasury ${t.treasury_account_id}`);
    for (const f of t.custom_fees?.fractional_fees ?? []) {
        console.log(`fee       ${f.amount.numerator}/${f.amount.denominator}, min ${f.minimum}, max ${f.maximum}, `
            + `${f.net_of_transfers ? 'paid on top by the sender' : 'taken out of the transfer'}, to ${f.collector_account_id}`);
    }
    const b = await (await mirrorGet(`${MIRROR}/tokens/${token}/balances`)).json();
    for (const row of b.balances ?? []) console.log(`balance   ${row.account}  ${row.balance / 10 ** t.decimals} ${t.symbol}`);
    return t;
}

// Only run when invoked directly; the paywall imports this file for htsAccept.
if (import.meta.filename === process.argv[1]) {
    const [flag, arg] = process.argv.slice(2);
    const run = flag === '--create' ? create()
        : flag === '--fund' ? fund(HTS_TOKEN, arg || 100)
            : flag === '--status' ? status(arg || HTS_TOKEN)
                : Promise.reject(new Error('usage: node agent/hts.mjs --create | --fund <BIC> | --status'));
    run.then(() => process.exit(0), (e) => { console.error(String(e.message || e)); process.exit(1); });
}
