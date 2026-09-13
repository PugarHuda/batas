// Hostile browser probe: XSS across every render path, link injection, DoS inputs.
// Standalone (not part of the project's playwright config). Run: node browser.mjs
import { chromium } from '@playwright/test';
import { toProgram } from '../agent/swapvm.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:4021';
// Screenshots are evidence for a human reading the run, not part of the assertion. Opt in with
// BATAS_QA_OUT; this used to be an absolute path into a temp directory from one machine.
const SHOTS = process.env.BATAS_QA_OUT || null;
const XSS = `<img src=x onerror=window.__xss=(window.__xss||0)+1>`;
const results = [];
const log = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// A program whose mandate label carries an XSS payload (40 bytes, under the 214/255 cap).
const evilLabel = `${XSS}"</script>'&`;
const evilProgram = toProgram({
    maxAmountIn: 10n ** 18n, minRateE18: 15n * 10n ** 17n,
    expiry: Math.floor(Date.now() / 1000) + 3600, feeBps: 30000n, salt: 1n,
    tokenIn: '0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B',
    tokenOut: '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81',
    nameRegistry: '0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B',
    nameHolder: '0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E',
    nameLabel: evilLabel,
});

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
let dialogFired = false;
page.on('dialog', (d) => { dialogFired = true; d.dismiss().catch(() => {}); });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// ---- Intercept every JSON route with malicious payloads BEFORE navigating. ----
const evilStr = XSS + `"'><svg/onload=window.__xss=1>`;
async function route(url, json) {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) }));
}
// decode: feed a mandate with malicious strings in every string-ish field + notes + instructions
await page.route('**/v1/mandate/decode', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
        source: evilStr, program: '0x' + '41'.repeat(4),
        guarded: true, instructionCount: 2,
        instructions: [
            { offset: evilStr, name: evilStr, args: evilStr },
            { offset: 1, name: '<script>window.__xss=1</script>', args: '0x' + evilStr },
        ],
        mandate: {
            maxAmountInFormatted: evilStr, minRateFormatted: evilStr,
            feePercent: evilStr, curve: evilStr, expiryISO: evilStr, direction: 'aToB',
            killSwitch: { label: XSS, registry: evilStr },
            maxAmountIn: '1', minRateE18: '1', expiry: 9999999999,
        },
        notes: [XSS, `<svg onload=window.__xss=1>`, evilStr],
    }),
}));
await route('**/v1/mandate/publication', {
    published: true, publishedAt: evilStr, consensusTimestamp: evilStr,
    sequenceNumber: evilStr, topic: evilStr,
    mirror: `javascript:window.__xss=1//`, // link() must refuse
});
await route('**/v1/agent/authority', {
    label: XSS, valid: false, revoked: true, reason: evilStr, expiry: 9999999999,
});
await route('**/v1/agent/reputation', {
    feedbackCount: evilStr, clientCount: evilStr, summaryValue: evilStr,
});
await route('**/v1/position/health', {
    status: evilStr,
    headroom: { marginalBps: evilStr, worstCaseOutflowB: evilStr, worstCaseOutflowPctB: evilStr },
    mandate: { hoursLeft: evilStr },
    authority: { agentLastActedAt: evilStr },
    alerts: [{ severity: evilStr, code: evilStr, message: XSS }],
    trades: { rows: [
        { tx: `javascript:alert(1)`, taker: evilStr, amountIn: evilStr, amountOut: evilStr, bpsAboveFloor: evilStr, selfTrade: true },
        { tx: `"><img src=x onerror=window.__xss=1>`, taker: XSS, amountIn: XSS, amountOut: XSS, bpsAboveFloor: XSS },
    ] },
});

await page.goto(BASE + '/', { waitUntil: 'load' });
// Trigger decode of the pasted evil program too (real backend path, not intercept)
await page.waitForTimeout(3500);

// Also paste the real evil program and decode via the real service (unrouted would hit intercept;
// so unroute decode first to exercise the genuine server render).
await page.unroute('**/v1/mandate/decode');
await page.fill('#prog', evilProgram);
await page.click('#go');
await page.waitForTimeout(1500);

const xssFlag = await page.evaluate(() => window.__xss || 0);
log('no script executed from any injected field (window.__xss unset)', !xssFlag, `__xss=${xssFlag}`);
log('no dialog (alert) fired', !dialogFired);
log('no uncaught page errors from malicious payloads', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

// Link injection: the publication mirror was javascript: — assert no anchor points at it.
const badAnchors = await page.evaluate(() => {
    const bad = [];
    for (const a of document.querySelectorAll('a')) {
        const h = (a.getAttribute('href') || '');
        if (/^(javascript|data):/i.test(h.trim()) || h.trim().startsWith('//')) bad.push(h);
    }
    return bad;
});
log('no javascript:/data:/protocol-relative anchors rendered', badAnchors.length === 0, badAnchors.join(', '));

// Did the malicious image/svg get injected as live DOM anywhere (would mean unescaped HTML)?
const injected = await page.evaluate(() => ({
    imgs: [...document.querySelectorAll('img')].filter((i) => i.getAttribute('src') === 'x').length,
    svgs: document.querySelectorAll('svg[onload]').length,
    // The payload text should appear escaped as literal text somewhere (proof it rendered as text)
    literal: document.body.innerText.includes('<img src=x onerror='),
}));
log('payload not parsed into live <img src=x> element', injected.imgs === 0, `imgs=${injected.imgs}`);
log('payload not parsed into live <svg onload> element', injected.svgs === 0, `svgs=${injected.svgs}`);
log('payload survives as escaped literal text (rendered, not executed)', injected.literal, `literalText=${injected.literal}`);

if (SHOTS) await page.screenshot({ path: `${SHOTS}/xss-rendered.png`, fullPage: true }).catch(() => {});

// ---- DoS inputs ----
await page.unrouteAll?.();
// 1MB program in textarea + decode (invalid hex → should be a fast 400/parse path, not a hang)
const big = '0x' + 'ab'.repeat(500_000); // ~1MB hex
let t0 = Date.now();
await page.fill('#prog', big);
await page.click('#go');
await page.waitForFunction(() => document.getElementById('status').textContent !== 'reading…', null, { timeout: 20000 }).catch(() => {});
const bigMs = Date.now() - t0;
log('1MB textarea program returns/handled within 20s', bigMs < 20000, `${bigMs}ms`);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(0);
