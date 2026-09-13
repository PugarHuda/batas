// The standing orders, read back from the Hedera mirror node.
//
//   node --test agent/subscribe.test.mjs
//
// Live on purpose. The claim is that the network paid the service on a schedule, after this process
// had exited, and that a payment the agent cancelled never ran. Only the public mirror node can say
// either; a stubbed row would prove the reader parses a row. The two orders below are the real ones
// made on testnet with `--create 3 --every 2` and `--create 2 --every 30` followed by `--cancel`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readOrders, describeSchedule, PAYER, PAYEE, TINYBAR_PER_PAYMENT, MEMO_PREFIX } from './subscribe.mjs';
import { MIRROR } from './hcs.mjs';

const PAID = { order: '1789303558', schedules: ['0.0.10523344', '0.0.10523346', '0.0.10523347'] };
const CANCELLED = { order: '1789303573', schedules: ['0.0.10523349', '0.0.10523350'] };

test('every payment of the standing order executed, and paid the service 0.001 HBAR', { timeout: 60_000 }, async () => {
    const payments = await readOrders({ order: PAID.order });
    assert.deepEqual(payments.map((p) => p.scheduleId), PAID.schedules);
    for (const p of payments) {
        assert.equal(p.state, 'executed', `${p.scheduleId} should have run at its due time`);
        assert.equal(p.waitForExpiry, true, 'held until due, not run the moment it was signed');
        assert.equal(p.result, 'SUCCESS');
        assert.match(p.transactionId, /^0\.0\.10388401-\d+-\d+$/, 'the payment is a transaction from the agent account');
        assert.equal(p.paid, TINYBAR_PER_PAYMENT);
    }
    // Spaced as ordered: each ran after the one before it, not all at once.
    const times = payments.map((p) => Number(p.executedTimestamp));
    assert.ok(times[0] < times[1] && times[1] < times[2]);
});

test('a schedule row on the mirror is the order it claims to be', { timeout: 30_000 }, async () => {
    const row = await (await fetch(`${MIRROR}/schedules/${PAID.schedules[0]}`)).json();
    assert.equal(row.creator_account_id, PAYER);
    assert.equal(row.payer_account_id, PAYER);
    assert.ok(row.admin_key, 'an order with no admin key could not be cancelled');
    assert.equal(row.memo, `${MEMO_PREFIX} 1/3 order ${PAID.order}`);
    // The executed transfer, read directly rather than through readOrders, moves the money the right way.
    const { transactions } = await (await fetch(`${MIRROR}/transactions?timestamp=${row.executed_timestamp}`)).json();
    const tx = transactions.find((t) => t.scheduled);
    assert.equal(tx.name, 'CRYPTOTRANSFER');
    assert.ok(tx.transfers.some((t) => t.account === PAYEE && t.amount === TINYBAR_PER_PAYMENT));
    assert.ok(tx.transfers.some((t) => t.account === PAYER && t.amount <= -TINYBAR_PER_PAYMENT));
});

test('a cancelled order was deleted before it paid anything', { timeout: 30_000 }, async () => {
    const payments = await readOrders({ order: CANCELLED.order });
    assert.deepEqual(payments.map((p) => [p.scheduleId, p.state]), CANCELLED.schedules.map((s) => [s, 'deleted']));
    assert.ok(payments.every((p) => !p.transactionId), 'a deleted schedule has no payment to show');
});

test('only schedules carrying the order memo are read as payments, and deleted wins over executed', () => {
    assert.equal(describeSchedule({ memo: 'someone else', schedule_id: '0.0.1' }), null);
    assert.equal(describeSchedule({ memo: `${MEMO_PREFIX} 1/3 order 12 extra`, schedule_id: '0.0.1' }), null);
    const base = { memo: `${MEMO_PREFIX} 2/3 order 42`, schedule_id: '0.0.9', expiration_time: '1789303800.000000000' };
    assert.deepEqual(
        { ...describeSchedule(base), dueAt: undefined },
        { scheduleId: '0.0.9', payment: 2, of: 3, order: '42', dueAt: undefined, state: 'pending', executedTimestamp: null, waitForExpiry: false },
    );
    assert.equal(describeSchedule({ ...base, executed_timestamp: '1.2' }).state, 'executed');
    assert.equal(describeSchedule({ ...base, deleted: true }).state, 'deleted');
    assert.equal(describeSchedule(base).dueAt, '2026-09-13T12:50:00.000Z');
});
