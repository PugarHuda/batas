// A standing order: the agent prepays the service for monitoring, on a schedule the network keeps.
//
//   node agent/subscribe.mjs --create 3 --every 2    three payments of 0.001 HBAR, two minutes apart
//   node agent/subscribe.mjs --status                every payment, read back from the mirror node
//   node agent/subscribe.mjs --cancel                delete the payments that have not happened yet
//
// x402 sells one answer per call. Watching a position is not one call, it is a standing arrangement,
// and paying for it by re-running a client every few minutes needs a machine that stays awake and
// keeps a key hot. Hedera Scheduled Transactions move that job to the network: each payment is a
// TransferTransaction wrapped in a ScheduleCreateTransaction with `waitForExpiry`, signed once when
// the order is made, and executed by consensus at its expiration time whether or not this process
// is still running. The admin key stays with the agent, so every payment that has not yet executed
// can be deleted — a subscription the payer cannot cancel would be a debit, not an order.
//
// This is a recurring payment beside x402, not through it. Nothing here touches Blocky402 or any
// facilitator: these are plain HBAR transfers from the agent account (HEDERA_AGENT_ID) to the
// service account, and the mirror node is the only record of them. The per-call x402 route is
// unchanged and still settles through Blocky402.

import 'dotenv/config';
import { MIRROR, mirrorGet } from './hcs.mjs';
import { PUBLISHER } from './deployment.mjs';

export const PAYER = process.env.HEDERA_AGENT_ID || '0.0.10388401';
export const PAYEE = PUBLISHER;
export const TINYBAR_PER_PAYMENT = 100_000; // 0.001 HBAR, the same price as one paid inspection

// The memo is how a standing order is found again without keeping a file: the mirror node lists
// every schedule the payer created, and this prefix picks out the ones that are payments of an
// order, which payment each one is, and which order it belongs to.
export const MEMO_PREFIX = 'Batas monitoring allowance';
const MEMO = new RegExp(`^${MEMO_PREFIX} (\\d+)/(\\d+) order (\\d+)$`);

/**
 * One mirror-node schedule row, as a payment of a standing order, or null if it is not one.
 *
 * Deleted is checked before executed on purpose: the mirror can only report one of them for a
 * schedule that really happened, and a deleted schedule never paid anything.
 */
export function describeSchedule(row) {
    const m = MEMO.exec(row?.memo ?? '');
    if (!m) return null;
    return {
        scheduleId: row.schedule_id,
        payment: Number(m[1]),
        of: Number(m[2]),
        order: m[3],
        dueAt: row.expiration_time ? new Date(Number(row.expiration_time.split('.')[0]) * 1000).toISOString() : null,
        state: row.deleted ? 'deleted' : row.executed_timestamp ? 'executed' : 'pending',
        executedTimestamp: row.executed_timestamp ?? null,
        waitForExpiry: row.wait_for_expiry === true,
    };
}

async function mirrorJson(path) {
    const res = await mirrorGet(`${MIRROR}${path}`);
    if (!res.ok) throw new Error(`mirror node answered ${res.status} for ${path}`);
    return res.json();
}

/**
 * Every payment of every standing order the payer has made, oldest first, with the transaction
 * that paid each executed one.
 *
 * The executed transaction is found by its consensus timestamp: the schedule row records when it
 * ran, and the transaction at that instant flagged `scheduled` is the payment itself.
 */
export async function readOrders({ payer = PAYER, order } = {}) {
    // ponytail: one page of 100 schedules; follow links.next when a payer has made more than that.
    const { schedules = [] } = await mirrorJson(`/schedules?account.id=${payer}&order=asc&limit=100`);
    const payments = schedules.map(describeSchedule).filter((p) => p && (!order || p.order === String(order)));
    for (const p of payments) {
        if (p.state !== 'executed') continue;
        const { transactions = [] } = await mirrorJson(`/transactions?timestamp=${p.executedTimestamp}`);
        const tx = transactions.find((t) => t.scheduled === true);
        p.transactionId = tx?.transaction_id ?? null;
        p.result = tx?.result ?? null;
        p.paid = tx?.transfers?.find((t) => t.account === PAYEE)?.amount ?? null;
    }
    return payments;
}

// The SDK is loaded only on the paths that sign, the same reason hcs.mjs gives: reading the order
// back needs nothing but fetch.
async function client() {
    const id = process.env.HEDERA_AGENT_ID;
    const key = process.env.HEDERA_AGENT_KEY;
    if (!id || !key) throw new Error('HEDERA_AGENT_ID and HEDERA_AGENT_KEY are required to create or cancel an order');
    const sdk = await import('@hiero-ledger/sdk');
    const priv = key.startsWith('302') ? sdk.PrivateKey.fromStringDer(key) : sdk.PrivateKey.fromStringECDSA(key);
    return { sdk, priv, client: sdk.Client.forTestnet().setOperator(sdk.AccountId.fromString(id), priv) };
}

export async function createOrder(count, everyMinutes) {
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('--create takes a whole number of payments, 1 to 20');
    if (!(everyMinutes > 0)) throw new Error('--every takes a positive number of minutes');
    const { sdk, priv, client: c } = await client();
    const order = String(Math.floor(Date.now() / 1000));
    const created = [];
    try {
        for (let i = 1; i <= count; i++) {
            const dueMs = Date.now() + i * everyMinutes * 60_000;
            const transfer = new sdk.TransferTransaction()
                .addHbarTransfer(PAYER, sdk.Hbar.fromTinybars(-TINYBAR_PER_PAYMENT))
                .addHbarTransfer(PAYEE, sdk.Hbar.fromTinybars(TINYBAR_PER_PAYMENT));
            // Signing the create with the payer's key is what authorises the transfer: the network
            // counts signatures on the ScheduleCreate toward the scheduled transaction, so nothing
            // needs to sign again when the payment falls due. waitForExpiry holds execution until
            // the due time instead of running it the moment it is fully signed.
            const receipt = await (await new sdk.ScheduleCreateTransaction()
                .setScheduledTransaction(transfer)
                .setScheduleMemo(`${MEMO_PREFIX} ${i}/${count} order ${order}`)
                .setAdminKey(priv.publicKey)
                .setPayerAccountId(sdk.AccountId.fromString(PAYER))
                .setExpirationTime(sdk.Timestamp.fromDate(new Date(dueMs)))
                .setWaitForExpiry(true)
                .execute(c)).getReceipt(c);
            const scheduleId = receipt.scheduleId.toString();
            created.push({ scheduleId, payment: i, dueAt: new Date(dueMs).toISOString() });
            console.log(`  ${i}/${count}  ${scheduleId}  due ${new Date(dueMs).toISOString()}`);
        }
    } finally {
        c.close();
    }
    return { order, created };
}

/** Delete every payment of the order (the newest one, by default) that has not run yet. */
export async function cancelOrder({ order } = {}) {
    const payments = await readOrders();
    const target = order ?? payments.at(-1)?.order;
    const pending = payments.filter((p) => p.order === target && p.state === 'pending');
    if (pending.length === 0) {
        console.log(target ? `  order ${target} has nothing pending to cancel` : '  no standing order to cancel');
        return [];
    }
    const { sdk, client: c } = await client();
    try {
        for (const p of pending) {
            // The admin key set at creation is the operator key, so the operator's signature on the
            // delete is the whole authorisation.
            const receipt = await (await new sdk.ScheduleDeleteTransaction()
                .setScheduleId(sdk.ScheduleId.fromString(p.scheduleId))
                .execute(c)).getReceipt(c);
            console.log(`  ${p.payment}/${p.of}  ${p.scheduleId}  ${receipt.status.toString()}`);
        }
    } finally {
        c.close();
    }
    return pending.map((p) => p.scheduleId);
}

function printStatus(payments) {
    if (payments.length === 0) return console.log(`  no standing orders from ${PAYER}`);
    let last;
    for (const p of payments) {
        if (p.order !== last) console.log(`\n  order ${p.order}  ${PAYER} -> ${PAYEE}, ${TINYBAR_PER_PAYMENT / 1e8} HBAR each`);
        last = p.order;
        const tail = p.state === 'executed' ? `${p.transactionId}  ${p.result}` : p.state === 'pending' ? `due ${p.dueAt}` : '';
        console.log(`    ${p.payment}/${p.of}  ${p.scheduleId.padEnd(14)} ${p.state.padEnd(9)} ${tail}`);
    }
    console.log(`\n  ${MIRROR}/schedules?account.id=${PAYER}`);
}

async function main() {
    const argv = process.argv.slice(2);
    const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
    if (argv.includes('--create')) {
        const { order } = await createOrder(Number(arg('--create')), Number(arg('--every') ?? 5));
        console.log(`\n  standing order ${order} created. node agent/subscribe.mjs --status to watch it pay.`);
    } else if (argv.includes('--cancel')) {
        await cancelOrder({ order: arg('--order') });
    } else if (argv.includes('--status')) {
        printStatus(await readOrders({ order: arg('--order') }));
    } else {
        console.log('usage: node agent/subscribe.mjs --create N --every MINUTES | --status [--order ID] | --cancel [--order ID]');
        process.exitCode = 1;
    }
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.message ?? e));
        process.exitCode = 1;
    });
}
