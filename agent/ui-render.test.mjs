// The hundred lines of the page that were shipped to every visitor and tested by nothing.
//
//   node --test agent/ui-render.test.mjs
//
// Coverage had `ui.mjs` at 5%: it is one long template string, so the escaping and the rendering
// inside it were unreachable from here. They live in `ui-render.mjs` now and are injected into the
// page by `.toString()`, so what these tests run is the same source the browser runs rather than a
// copy that agrees with it today.

import test from 'node:test';
import assert from 'node:assert/strict';

import { esc, link, renderMandate, asBrowserSource } from './ui-render.mjs';
import { page } from './ui.mjs';

test('escaping closes every hole that reaches innerHTML', () => {
    assert.equal(esc('<script>'), '&lt;script&gt;');
    assert.equal(esc('a&b'), 'a&amp;b');
    // Both quote forms, because the output is interpolated into attributes as well as into text,
    // and an unescaped apostrophe in a single-quoted attribute is the same hole as a double quote
    // in a double-quoted one.
    assert.equal(esc('"x"'), '&quot;x&quot;');
    assert.equal(esc("it's"), 'it&#39;s');
    // Non-strings are coerced rather than passed through, which is what makes it safe to call on a
    // field that is a number today and might not be tomorrow.
    assert.equal(esc(42), '42');
    assert.equal(esc(null), 'null');
    assert.equal(esc(undefined), 'undefined');
});

test('a decoded mandate cannot inject markup through any of its fields', () => {
    // The realistic path: a visitor pastes a program, the decoder derives strings from its bytes,
    // and those land in innerHTML. Every one of them goes through esc, and this is the assertion
    // that says so rather than the comment claiming it.
    const html = renderMandate({
        guarded: true,
        instructionCount: '<img src=x onerror=alert(1)>',
        mandate: {
            maxAmountInFormatted: '<b>17</b>',
            minRateFormatted: "1.92'><script>alert(1)</script>",
            feePercent: '<i>0.3</i>',
            curve: '<svg onload=alert(1)>',
            expiryISO: '2026-10-10T14:20:56.000Z',
            killSwitch: { label: '<b>agent</b>', registry: '0x94"58' },
        },
        instructions: [{ offset: 0, name: '<script>POLICY</script>' }],
        notes: ['<iframe src=evil>'],
    });

    assert.ok(!html.includes('<script>'), 'a script tag survived into the page');
    assert.ok(!html.includes('<img'), 'an img tag survived into the page');
    assert.ok(!html.includes('<svg'), 'an svg tag survived into the page');
    assert.ok(!html.includes('<iframe'), 'an iframe survived into the page');
    // Not "the word onerror is absent" — it is present, and correctly so. An escaped attribute is
    // inert text, and asserting otherwise would be asserting that the page strips input rather than
    // escapes it. What matters is that nothing reopens a tag around it, which the four checks above
    // cover. The escaped forms below say the same thing from the other side.
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the payload should survive as inert text');
    assert.ok(html.includes('&lt;script&gt;POLICY&lt;/script&gt;'));
    assert.ok(html.includes('&lt;iframe src=evil&gt;'));
    // And the attribute the registry lands in cannot be broken out of.
    assert.ok(!/<dd class="mono">[^<]*"[^<]*>/.test(html), 'a quote escaped its attribute');
});

test('a missing term reads as an absence, not as an empty cell', () => {
    // A blank next to "floor rate" and a position with no floor are the same pixel and opposite
    // facts. Each one says what the absence permits.
    const html = renderMandate({ guarded: false, mandate: {}, instructions: [], notes: [] });
    assert.match(html, /no cap — one trade may take the whole reserve/);
    assert.match(html, /no floor — any rate the curve produces/);
    assert.match(html, /never — only revocation ends this/);
    assert.match(html, /none — only the expiry and Aqua.dock\(\) end this grant/);
    assert.match(html, /not guarded/);
});

test('a kill switch is shown by name and registry when there is one', () => {
    const html = renderMandate({
        guarded: true,
        mandate: { killSwitch: { label: 'agent', registry: '0x9458' } },
        instructions: [],
        notes: [],
    });
    assert.match(html, /"agent" in 0x9458/);
});

test('only an https destination becomes a link', () => {
    assert.match(link('https://testnet.mirrornode.hedera.com/x', 'verify'), /<a href="https:\/\//);
    // A scheme is a capability. These are dropped rather than rendered inert, because a link that
    // does nothing is still a link somebody clicks.
    assert.equal(link('javascript:alert(1)', 'verify'), '');
    assert.equal(link('http://plain', 'verify'), '');
    assert.equal(link('data:text/html,<script>', 'verify'), '');
    assert.equal(link(undefined, 'verify'), '');
    assert.equal(link(null, 'verify'), '');
});

test('the page ships exactly this source, and only one copy of it', () => {
    // The point of the extraction. If the page ever carried its own second copy, these tests would
    // pass while the browser ran something else — which is the position the file was in before.
    const html = page({
        origin: 'https://example.test',
        price: 0.001,
        payTo: '0.0.1',
        topic: '0.0.2',
        facilitator: 'https://api.testnet.blocky402.com',
        network: 'hedera:testnet',
    });

    for (const fn of ['esc', 'link', 'renderMandate']) {
        const copies = html.split(`function ${fn}(`).length - 1;
        assert.equal(copies, 1, `the page carries ${copies} copies of ${fn}`);
    }
    assert.ok(html.includes(asBrowserSource().split('\n')[0]), 'the injected source is not the tested source');
});
