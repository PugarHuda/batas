// The capability panels' rendering, against the real mirror node and hostile strings.
//
//   node --test agent/surface-render.test.mjs
//
// The functions run in both pages with the page's own `esc` in scope, so the test puts the tested
// escape, ui-render's, in that same scope rather than shipping a second copy to the browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import { esc } from './ui-render.mjs';
import {
    hbar, units, consensusISO, b64json, out, renderName, meteredRange, renderPrice, renderReach,
    paymentRecords, renderTrail, surfaceSource, HOL_LISTING, HTS_TOKEN_ID,
} from './surface-render.mjs';
import { landing } from './landing.mjs';
import { page } from './ui.mjs';

globalThis.esc = esc;
const MIRROR = 'https://testnet.mirrornode.hedera.com/api/v1';
const json = async (url) => (await fetch(url)).json();

test('figures keep every digit and never go exponential', () => {
    assert.equal(hbar('94000'), '0.00094');
    assert.equal(hbar('370000'), '0.0037');
    assert.equal(hbar('100000000'), '1');
    assert.equal(units('100', '2'), '1.00');
    assert.equal(consensusISO('1789305897.407588950'), '2026-09-13 13:24 UTC');
    assert.equal(consensusISO('nope'), '—');
    assert.equal(b64json('not base64 json'), null);
});

test('only https becomes a link, and nothing a response carries reopens a tag', () => {
    assert.equal(out('javascript:alert(1)', 'x'), 'x');
    const html = renderName({
        name: '<script>x</script>', address: '"><img src=x>', resolver: null,
        text: { '<b>k</b>': 'javascript:alert(1)', url: 'https://ok.example/"onmouseover=' },
        erc8004: { registry: 'eip155:1:0xnot', agentId: '<i>', linked: false },
    });
    for (const tag of ['<script>', '<img', '<b>k', '<i>']) assert.ok(!html.includes(tag), tag + ' survived');
    assert.ok(!html.includes('href="javascript'), 'a javascript: href survived');
    assert.match(html, /does not hold/);
});

test('the live payment trail on the mirror node parses and renders with both transaction links', async () => {
    const pageOf = await json(`${MIRROR}/topics/0.0.10394165/messages?order=desc&limit=100`);
    const records = paymentRecords(pageOf.messages);
    assert.ok(records.every((r) => r.kind === 'batas.payment'));
    const html = renderTrail(records, '0.0.10394165', null);
    assert.match(html, new RegExp(`>${records.length}</span> payment record`));
    for (const r of records.slice(0, 5)) {
        const [id, rest] = r.transaction.split('@');
        assert.ok(html.includes(`${MIRROR}/transactions/${id}-${rest.replace('.', '-')}`), r.transaction);
        assert.ok(html.includes(`https://hashscan.io/testnet/transaction/${r.at}`));
    }
});

test('the live token and directory entry render the custom fee and the listing', async () => {
    const token = await json(`${MIRROR}/tokens/${HTS_TOKEN_ID}`);
    const manifest = {
        resources: [{
            accepts: [{ asset: '0.0.0', amount: '370000', network: 'hedera:testnet', payTo: '0.0.10388560' }, { asset: HTS_TOKEN_ID, amount: '100', payTo: '0.0.10388560' }],
            metered: { min: '94000', max: '370000', rates: { decode: 40000, perInstruction: 1000, instructionCap: 256 } },
        }],
    };
    assert.equal(meteredRange(manifest), '0.00094 – 0.0037 HBAR');
    const price = renderPrice(manifest, token);
    assert.match(price, /1\.00 BIC/);
    assert.match(price, /custom fee <span class="fig">0\.01 BIC<\/span> to 0\.0\.10388560/);
    assert.match(price, /per instruction, at most 256/);

    const msg = await json(`${MIRROR}/topics/${HOL_LISTING.topic}/messages/${HOL_LISTING.sequence}`);
    const reach = renderReach({ url: 'https://batas-one.vercel.app/a2a', protocolVersion: '0.3.0', capabilities: { extensions: [{ uri: 'https://github.com/google-a2a/a2a-x402/v0.1', required: true }] }, skills: [] }, msg, HOL_LISTING);
    assert.match(reach, /state inside">listed/);
    assert.match(reach, /a2a-x402, required/);
    // A registration for some other account is not this agent's listing.
    assert.match(renderReach({}, msg, { ...HOL_LISTING, account: '0.0.1' }), /not the expected registration/);
});

test('both pages ship this source once, and neither prints a flat price', () => {
    const args = { origin: 'x', price: 0.00094, payTo: '0.0.1', topic: '0.0.2', facilitator: 'https://f', network: 'hedera:testnet' };
    for (const html of [landing(args), page(args)]) {
        assert.equal(html.split('function renderTrail(').length - 1, 1);
        assert.ok(html.includes(surfaceSource().split('\n')[0]));
        assert.doesNotMatch(html, /from [\d.]+ HBAR/);
        for (const id of ['sName', 'sPrice', 'sReach', 'sTrail']) assert.match(html, new RegExp(`id="${id}" aria-busy="true"`));
    }
});
