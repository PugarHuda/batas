// Tests for the HTS payment option: the token, its fee schedule, and a settlement that paid it.
//
// Everything here is read from the real testnet mirror node. The claim being tested is that the
// ledger, not this service, charges the fee; a stubbed mirror would only test that this file agrees
// with itself.

import test from 'node:test';
import assert from 'node:assert/strict';

import { HTS_TOKEN, PUBLISHER } from './deployment.mjs';
import { HTS_PRICE, HTS_FEE, confirmTokenSettlement } from './hts.mjs';
import { MIRROR, mirrorGet } from './hcs.mjs';

const AGENT = '0.0.10388401';
const BLOCKY402_FEE_PAYER = '0.0.7162784';
// A real x402 settlement in BIC through Blocky402, made by `node agent/hts-pay.mjs` after the fixed
// fee schedule was set: 1.00 BIC to the service plus the 0.01 BIC fee the ledger assessed.
const SETTLED = '0.0.7162784@1789303940.461488375';
// The first settlement, under the fractional fee the token was created with. It succeeded and
// assessed nothing, which is why the schedule is now a fixed fee. Kept so that finding stays checked.
const SETTLED_UNDER_FRACTIONAL = '0.0.7162784@1789303799.767974862';

test('the token is Batas Inspection Credit, held in treasury by the service account', async () => {
    const t = await (await mirrorGet(`${MIRROR}/tokens/${HTS_TOKEN}`)).json();
    assert.equal(t.name, 'Batas Inspection Credit');
    assert.equal(t.symbol, 'BIC');
    assert.equal(t.type, 'FUNGIBLE_COMMON');
    assert.equal(String(t.decimals), '2');
    assert.equal(t.treasury_account_id, PUBLISHER);
});

test('its custom fee schedule is a fixed fee in BIC collected by the service account', async () => {
    const t = await (await mirrorGet(`${MIRROR}/tokens/${HTS_TOKEN}`)).json();
    assert.ok(t.fee_schedule_key, 'a fee schedule key exists, so the schedule can only change by a public transaction');
    assert.deepEqual(t.custom_fees.fractional_fees, []);
    assert.equal(t.custom_fees.fixed_fees.length, 1);
    const [fee] = t.custom_fees.fixed_fees;
    assert.equal(fee.amount, HTS_FEE.amount);
    assert.equal(fee.denominating_token_id, HTS_TOKEN);
    assert.equal(fee.collector_account_id, PUBLISHER);
});

test('an x402 settlement in BIC moved the credits and the ledger assessed the custom fee', async () => {
    assert.ok(SETTLED.startsWith(`${BLOCKY402_FEE_PAYER}@`), 'the facilitator, not the payer, paid the network fee');
    const r = await confirmTokenSettlement(SETTLED, { payer: AGENT });
    assert.equal(r.confirmed, true, r.reason);
    assert.equal(r.fee, HTS_FEE.amount);
    assert.equal(r.paid, Number(HTS_PRICE) + HTS_FEE.amount);
    assert.equal(r.received, Number(HTS_PRICE) + HTS_FEE.amount, 'the service is payTo and collector, so it receives both');
    assert.deepEqual(r.assessedCustomFees.map((f) => [f.token_id, f.collector_account_id, f.effective_payer_account_ids]),
        [[HTS_TOKEN, PUBLISHER, [AGENT]]]);
});

test('a transfer that moved credits but assessed no fee is not confirmed', async () => {
    const r = await confirmTokenSettlement(SETTLED_UNDER_FRACTIONAL, { payer: AGENT });
    assert.equal(r.result, 'SUCCESS');
    assert.equal(r.received, Number(HTS_PRICE));
    assert.equal(r.confirmed, false);
    assert.match(r.reason, /no custom fee/);
});

test('the local 402 and the discovery manifest list HBAR first and BIC second', async (t) => {
    const [{ default: app }, { decodePaymentRequiredHeader }] = await Promise.all([import('./service.mjs'), import('@x402/core/http')]);
    // Port 0: the OS picks a free one, so this never collides with a running service or another
    // worktree's test run.
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => server.close());
    const origin = `http://127.0.0.1:${server.address().port}`;

    const res = await fetch(`${origin}/v1/mandate/explain`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ program: '0x00' }),
    });
    assert.equal(res.status, 402);
    const { accepts } = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED'));
    assert.equal(accepts[0].asset, '0.0.0', 'HBAR stays first, so a client taking the first option needs no association');
    const bic = accepts.find((a) => a.asset === HTS_TOKEN);
    assert.ok(bic, 'the 402 lists the BIC option');
    assert.equal(bic.amount, HTS_PRICE);
    assert.equal(bic.payTo, PUBLISHER);
    assert.equal(bic.network, 'hedera:testnet');
    assert.equal(bic.extra.feePayer, BLOCKY402_FEE_PAYER);

    const manifest = await (await fetch(`${origin}/.well-known/x402`)).json();
    assert.deepEqual(manifest.resources[0].accepts.map((a) => a.asset), ['0.0.0', HTS_TOKEN]);
});
