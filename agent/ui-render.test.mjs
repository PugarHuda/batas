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

import { esc, link, num, when, renderMandate, judgeAmount, renderHealth, asBrowserSource } from './ui-render.mjs';
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
    assert.match(html, /none — only the expiry, or the maker closing the position, ends this mandate/);
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

test('the floor carries its unit and an ISO expiry is a <time> in UTC', () => {
    const html = renderMandate({
        guarded: true,
        mandate: { minRateFormatted: '1.92', expiryISO: '2026-10-10T14:20:56.000Z' },
        instructions: [],
        notes: [],
    });
    assert.match(html, /<dt>floor<\/dt><dd class="mono">1\.<span class="frac">92<\/span> <span class="muted">B per A<\/span>/);
    assert.match(html, /<dt>cap<\/dt>/);
    assert.match(html, /<time datetime="2026-10-10T14:20:56.000Z">2026-10-10T14:20:56.000Z UTC<\/time>/);
    // A consensus timestamp is seconds, not ISO; it is not a <time> and gets no zone.
    assert.equal(when('1757000000.123456789'), '1757000000.123456789');
    assert.equal(when('<b>'), '&lt;b&gt;');
});

test('the morning report renders every field it is given and a dash for each it is not', () => {
    const html = renderHealth({
        status: 'warn',
        headroom: { marginalBps: 12.5, worstCaseOutflowB: '3.417000000000000000', worstCaseOutflowPctB: 0.17 },
        mandate: { hoursLeft: 41.3 },
        authority: { agentLastActedAt: '2026-09-13T06:00:00.000Z' },
        alerts: [
            { code: 'FLOOR_HEADROOM_LOW', severity: 'warn', message: 'only 12.5bps between spot after fee and the floor' },
            { code: '<b>x</b>', severity: 'critical', message: '<script>alert(1)</script>' },
        ],
        trades: { rows: [
            { tx: '0x' + 'ab'.repeat(32), taker: '0x' + 'cd'.repeat(20), amountIn: '5', amountOut: '9.8', bpsAboveFloor: 34.2, selfTrade: true },
            { tx: 'not a hash', taker: null, amountIn: null, amountOut: null, bpsAboveFloor: -3, selfTrade: false },
        ] },
    });
    assert.match(html, /<dt>status<\/dt><dd><span class="tag">warn<\/span>/);
    assert.match(html, /<dt>headroom<\/dt><dd class="mono">12\.5 bps/);
    assert.match(html, /<dt>worst case<\/dt><dd class="mono">3\.<span class="frac">417000000000000000<\/span> B .*0\.17% of the reserve/);
    assert.match(html, /<dt>hours left<\/dt><dd class="mono">41\.3 h/);
    assert.match(html, /<dt>agent last acted<\/dt><dd class="mono"><time datetime="2026-09-13T06:00:00.000Z">/);
    assert.match(html, /<li><span class="tag">warn<\/span> <code>FLOOR_HEADROOM_LOW<\/code> only 12\.5bps/);
    assert.ok(!html.includes('<script>') && !html.includes('<b>'), 'an alert injected markup');
    assert.match(html, /2 trades since the ship/);
    assert.match(html, /<a href="https:\/\/sepolia\.etherscan\.io\/tx\/0xabab[a-f0-9]+" rel="noopener">0xababab…abab<\/a>/);
    assert.match(html, /0xcdcdcd…cdcd <span class="tag muted">maker<\/span>/);
    assert.match(html, /<td class="mono yes">34\.2 bps<\/td>/);
    assert.match(html, /<td class="mono no">-3 bps<\/td>/);
    assert.match(html, /<th scope="col">tx<\/th>/);

    // The empty answer: nothing throws, every cell is a dash or an absence said out loud.
    const bare = renderHealth({ status: 'docked', alerts: [], trades: [] });
    assert.match(bare, /<span class="tag no">docked<\/span>/);
    assert.equal((bare.match(/<dd class="mono">—<\/dd>/g) || []).length, 3);
    assert.match(bare, /never<\/span>/);
    assert.match(bare, /no alerts/);
    assert.match(bare, /no trades since the ship/);
    assert.doesNotThrow(() => renderHealth(null));
    assert.doesNotThrow(() => renderHealth({}));
});

test('a long decimal keeps every digit and dims the tail', () => {
    assert.equal(num('7.162902849964033514'), '7.<span class="frac">162902849964033514</span>');
    assert.equal(num('7'), '7');
    // Escaped before it is split, so a non-number is inert text rather than markup.
    assert.equal(num('<b>1.5</b>'), '&lt;b&gt;1.<span class="frac">5&lt;/b&gt;</span>');
});

test('the amount box is arithmetic against the cap, and says so when there is none', () => {
    const m = { maxAmountInFormatted: '7.162902849964033514', expiry: 1791820918 };
    const now = 1789000000000; // before the expiry
    assert.equal(judgeAmount(m, '', now), null);
    assert.equal(judgeAmount(m, 'abc', now), null);
    assert.equal(judgeAmount(m, '-1', now), null);
    assert.equal(judgeAmount(m, '5', now).verdict, 'inside');
    assert.match(judgeAmount(m, '5', now).text, /inside the cap — 69\.8/);
    assert.equal(judgeAmount(m, '10', now).verdict, 'over');
    assert.match(judgeAmount(m, '10', now).text, /over the cap by 2\.8371/);
    // Inside the cap but past the expiry: nothing settles, and the box must not say "inside".
    assert.equal(judgeAmount(m, '5', 1800000000000).verdict, 'over');
    assert.match(judgeAmount(m, '5', 1800000000000).text, /expired/);
    assert.equal(judgeAmount({}, '5', now).verdict, 'uncapped');
    assert.equal(judgeAmount(null, '5', now).verdict, 'uncapped');
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

    for (const fn of ['esc', 'link', 'num', 'when', 'facts', 'renderMandate', 'judgeAmount', 'renderHealth']) {
        const copies = html.split(`function ${fn}(`).length - 1;
        assert.equal(copies, 1, `the page carries ${copies} copies of ${fn}`);
    }
    assert.ok(html.includes(asBrowserSource().split('\n')[0]), 'the injected source is not the tested source');
});
