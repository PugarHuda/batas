// Mobile, performance and accessibility QA for the one page this service serves to a person.
//
// Run with a config whose testMatch includes this file, e.g.
//   BATAS_QA_URL=http://localhost:4021 BATAS_QA_OUT=<dir> npx playwright test --config <cfg>
// It writes screenshots and a JSON report under BATAS_QA_OUT and asserts only the invariants that
// must hold everywhere; everything else is measured and reported, not judged here.
//
// Live-column responses are captured once from the real service and replayed into the device
// contexts, because the free routes are rate limited (60/min/IP) and each page load spends five.
// The perf and resilience tests hit the network for real.

import { test, expect, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BATAS_QA_URL || 'http://localhost:4021';
const OUT = process.env.BATAS_QA_OUT || path.resolve('qa-a11y-out');
fs.mkdirSync(OUT, { recursive: true });
const report = {};
const save = () => fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });

const ROUTES = {
    decode: ['POST', '/v1/mandate/decode'],
    publication: ['POST', '/v1/mandate/publication'],
    authority: ['GET', '/v1/agent/authority'],
    reputation: ['GET', '/v1/agent/reputation'],
    health: ['GET', '/v1/position/health'],
};
const fixturePath = path.join(OUT, 'fixtures.json');

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

async function captureFixtures(request) {
    if (fs.existsSync(fixturePath)) return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const out = {};
    for (const [k, [m, p]] of Object.entries(ROUTES)) {
        const r = m === 'POST' ? await request.post(BASE + p, { data: {} }) : await request.get(BASE + p);
        out[k] = { status: r.status(), body: await r.text() };
    }
    fs.writeFileSync(fixturePath, JSON.stringify(out, null, 2));
    return out;
}

async function replay(page, fx) {
    await page.route('**/v1/**', (route) => {
        const u = new URL(route.request().url()).pathname;
        const k = Object.keys(ROUTES).find((k) => ROUTES[k][1] === u);
        if (!k) return route.continue();
        return route.fulfill({ status: fx[k].status, contentType: 'application/json', body: fx[k].body });
    });
}

const settled = (page, t = 90_000) => page.waitForFunction(
    () => ['pub', 'auth', 'rep'].every((id) => !document.getElementById(id).classList.contains('spin'))
        && !document.getElementById('out').hidden,
    null, { timeout: t },
);

// Everything about the layout in one evaluate, so each device costs one round trip.
const audit = () => {
    const vis = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]');
    };
    const sel = (el) => {
        if (el.id) return '#' + el.id;
        const cls = [...el.classList].map((c) => '.' + c).join('');
        const parent = el.parentElement ? (el.parentElement.id ? '#' + el.parentElement.id + ' > ' : el.parentElement.tagName.toLowerCase() + ' > ') : '';
        return parent + el.tagName.toLowerCase() + cls;
    };
    const de = document.documentElement;
    const overflow = { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, overflows: de.scrollWidth > de.clientWidth };
    const offenders = overflow.overflows ? [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1 && vis(el))
        .slice(0, 12).map((el) => sel(el) + ' right=' + Math.round(el.getBoundingClientRect().right)) : [];
    const small = [];
    for (const el of document.querySelectorAll('body *')) {
        if (!vis(el) || el.classList.contains('sr')) continue;
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 12) small.push({ sel: sel(el), px: +fs.toFixed(2), text: el.textContent.trim().slice(0, 40) });
    }
    const targets = [];
    for (const el of document.querySelectorAll('button, a[href], input, textarea, [role=button]')) {
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 44 || r.height < 44) targets.push({ sel: sel(el), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || el.placeholder || '').trim().slice(0, 30) });
    }
    const tables = [...document.querySelectorAll('table')].map((t) => {
        let a = t.parentElement, scroller = null;
        while (a && a !== document.body) {
            const o = getComputedStyle(a).overflowX;
            if (o === 'auto' || o === 'scroll') { scroller = sel(a); break; }
            a = a.parentElement;
        }
        const r = t.getBoundingClientRect();
        return { sel: sel(t), width: Math.round(r.width), right: Math.round(r.right), viewport: de.clientWidth, scroller, clipped: r.right > de.clientWidth + 1 && !scroller, visible: vis(t) };
    });
    const fixed = [...document.querySelectorAll('body *')].filter((el) => ['fixed', 'sticky'].includes(getComputedStyle(el).position)).map(sel);
    const fill = document.querySelector('.bar .fill');
    return {
        overflow, offenders, small, targets, tables, fixed,
        fillAnimation: fill ? getComputedStyle(fill).animationName : null,
        bodyFont: getComputedStyle(document.body).fontSize,
        cols: getComputedStyle(document.querySelector('.cols')).gridTemplateColumns,
    };
};

const DEVICES = [
    ['iphone13', devices['iPhone 13']],
    ['pixel7', devices['Pixel 7']],
    ['ipad-portrait', devices['iPad (gen 7)']],
    ['ipad-landscape', devices['iPad (gen 7) landscape']],
    ['w320', { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
    ['desktop1440', { viewport: { width: 1440, height: 900 } }],
];

test('devices: layout, text size, tap targets, tables, inputs, both themes, reduced motion', async ({ browser, request }) => {
    const fx = await captureFixtures(request);
    report.devices = {};
    const runs = [];
    for (const [name, dev] of DEVICES) for (const scheme of ['light', 'dark']) runs.push([name, dev, scheme, false]);
    runs.push(['iphone13', devices['iPhone 13'], 'light', true]);
    runs.push(['desktop1440', DEVICES[5][1], 'dark', true]);
    for (const [name, dev, scheme, rm] of runs) {
        const key = `${name}-${scheme}${rm ? '-reduced' : ''}`;
        const ctx = await browser.newContext({ ...dev, colorScheme: scheme, reducedMotion: rm ? 'reduce' : 'no-preference' });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await replay(page, fx);
        await page.goto(BASE + '/');
        await settled(page);
        await page.waitForTimeout(1200); // bar animation (0.9s) finishes before the shot
        await shot(page, key);
        const a = await page.evaluate(audit);

        // The amount box and the textarea, driven the way a keyboard would.
        const amt = page.locator('#amt');
        await amt.scrollIntoViewIfNeeded();
        await amt.click();
        const kb = { amtRectAfterFocus: await amt.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, inView: r.top >= 0 && r.bottom <= innerHeight }; }) };
        await page.keyboard.type('5');
        kb.tryOutAfterType = await page.locator('#tryOut').textContent();
        kb.tryOutAria = await page.locator('#tryOut').getAttribute('aria-live');
        await page.keyboard.type('00000');
        kb.tryOutAfterOver = await page.locator('#tryOut').textContent();
        kb.amtInputmode = await amt.getAttribute('inputmode');
        kb.amtType = await amt.getAttribute('type');
        const prog = page.locator('#prog');
        await prog.click();
        kb.progValueLen = (await prog.inputValue()).length;
        await page.keyboard.press('Control+A');
        await page.keyboard.type('0xzz');
        kb.progValueAfterType = await prog.inputValue();
        kb.progFontPx = await prog.evaluate((el) => getComputedStyle(el).fontSize);
        kb.progHeight = await prog.evaluate((el) => Math.round(el.getBoundingClientRect().height));
        await page.locator('#go').click();
        await expect(page.locator('#out .err')).toBeVisible({ timeout: 15_000 });
        kb.badDecodeStatus = await page.locator('#status').textContent();
        kb.badDecodeHasRetry = await page.locator('#out button').count();
        await page.locator('#live').click();
        await expect(page.locator('#out dl.facts')).toBeVisible({ timeout: 15_000 });
        await ctx.close();
        report.devices[key] = { ...a, keyboard: kb, pageErrors: errors };
        save();
        expect(errors, key + ' page errors').toEqual([]);
    }
});

test('a11y: axe, headings, landmarks, names, live regions, focus, contrast, time, links, zoom', async ({ browser, request }) => {
    const fx = await captureFixtures(request);
    report.a11y = {};
    for (const scheme of ['light', 'dark']) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
        const page = await ctx.newPage();
        await page.addInitScript(() => {
            window.__status = [];
            document.addEventListener('DOMContentLoaded', () => {
                for (const el of document.querySelectorAll('[role=status], [aria-live]')) {
                    new MutationObserver(() => window.__status.push({ t: Math.round(performance.now()), id: el.id, live: el.getAttribute('aria-live') || el.getAttribute('role'), text: el.textContent.trim().slice(0, 80), len: el.textContent.trim().length }))
                        .observe(el, { childList: true, characterData: true, subtree: true });
                }
            });
        });
        await replay(page, fx);
        await page.goto(BASE + '/');
        await settled(page);
        const r = {};
        r.statusEvents = await page.evaluate(() => window.__status);
        r.statusRole = await page.getByRole('status').evaluateAll((els) => els.map((e) => ({ id: e.id, text: e.textContent.trim(), ariaLive: e.getAttribute('aria-live') })));

        await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js' });
        const axe = await page.evaluate(async () => {
            const res = await window.axe.run(document, { resultTypes: ['violations', 'incomplete'] });
            const pick = (v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 6).map((n) => ({ target: n.target.join(' '), summary: n.failureSummary && n.failureSummary.split('\n').slice(0, 3).join(' | ') })) });
            return { violations: res.violations.map(pick), incomplete: res.incomplete.map(pick) };
        });
        r.axe = axe;

        r.structure = await page.evaluate(() => {
            const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => !h.closest('[hidden]')).map((h) => h.tagName + ': ' + h.textContent.trim());
            const skips = [];
            let prev = 0;
            for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
                if (h.closest('[hidden]')) continue;
                const n = +h.tagName[1];
                if (n > prev + 1) skips.push(h.tagName + ' after H' + prev + ': ' + h.textContent.trim());
                prev = n;
            }
            const landmarks = [...document.querySelectorAll('main,nav,header,footer,aside,form,section[aria-label],section[aria-labelledby],[role=main],[role=navigation],[role=banner],[role=contentinfo],[role=region]')]
                .map((e) => e.tagName.toLowerCase() + (e.getAttribute('role') ? '[role=' + e.getAttribute('role') + ']' : '') + (e.parentElement === document.body ? ' (top-level)' : ' (inside ' + e.parentElement.tagName.toLowerCase() + ')'));
            const controls = [...document.querySelectorAll('input,textarea,select,button')].map((c) => {
                const lbl = c.labels && c.labels.length ? [...c.labels].map((l) => l.textContent.trim()).join('/') : '';
                return { sel: c.id ? '#' + c.id : c.tagName.toLowerCase() + ' "' + c.textContent.trim() + '"', name: lbl || c.getAttribute('aria-label') || c.textContent.trim() || '(none)', hidden: !!c.closest('[hidden]') };
            });
            const times = [...document.querySelectorAll('time')].map((t) => ({ datetime: t.getAttribute('datetime'), text: t.textContent }));
            const links = [...document.querySelectorAll('a[href]')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target') }));
            const imgs = [...document.querySelectorAll('img,svg')].map((i) => ({ tag: i.tagName, alt: i.getAttribute('alt'), ariaHidden: i.getAttribute('aria-hidden') }));
            const emoji = [...document.body.innerText.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]);
            const meta = {
                title: document.title,
                lang: document.documentElement.lang,
                description: document.querySelector('meta[name=description]')?.content ?? null,
                themeColor: document.querySelector('meta[name=theme-color]')?.content ?? null,
                icon: document.querySelector('link[rel~=icon]')?.href ?? null,
                viewport: document.querySelector('meta[name=viewport]')?.content ?? null,
                colorScheme: getComputedStyle(document.documentElement).colorScheme,
            };
            return { headings, skips, landmarks, controls, times, links, imgs, emoji, meta };
        });

        // Focus order and visibility, by pressing Tab through the page.
        await page.locator('body').press('Tab');
        const focus = [];
        for (let i = 0; i < 25; i++) {
            const f = await page.evaluate(() => {
                const el = document.activeElement;
                if (!el || el === document.body) return null;
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return { sel: (el.id ? '#' + el.id : el.tagName.toLowerCase()) + (el.textContent ? ' "' + el.textContent.trim().slice(0, 30) + '"' : ''), outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, boxShadow: cs.boxShadow !== 'none', inViewport: r.top >= 0 && r.bottom <= innerHeight, matchesFocusVisible: el.matches(':focus-visible') };
            });
            if (!f) break;
            focus.push(f);
            await page.keyboard.press('Tab');
        }
        r.focus = focus;

        // Every text/background pair actually painted.
        r.contrast = await page.evaluate(() => {
            const parse = (s) => { const m = s.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
            const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
            const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
            const bgOf = (el) => {
                let a = el, acc = null;
                while (a) {
                    const c = parse(getComputedStyle(a).backgroundColor);
                    if (c.a > 0) acc = acc ? over(acc, c) : c;
                    if (acc && acc.a >= 1) break;
                    a = a.parentElement;
                }
                return acc || { r: 255, g: 255, b: 255, a: 1 };
            };
            const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
            const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
            const pairs = new Map();
            const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !el.closest('[hidden]') && !el.classList.contains('sr'); };
            for (const el of document.querySelectorAll('body *')) {
                if (!vis(el)) continue;
                if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                const cs = getComputedStyle(el);
                const fg = parse(cs.color);
                const bg = bgOf(el);
                const fgc = fg.a < 1 ? over(fg, bg) : fg;
                const size = parseFloat(cs.fontSize), weight = +cs.fontWeight;
                const large = size >= 24 || (size >= 18.66 && weight >= 700);
                const k = hex(fgc) + '/' + hex(bg) + '/' + (large ? 'L' : 'N');
                const rt = ratio(fgc, bg);
                if (!pairs.has(k)) pairs.set(k, { fg: hex(fgc), bg: hex(bg), ratio: +rt.toFixed(2), large, pass: rt >= (large ? 3 : 4.5), size: +size.toFixed(1), weight, example: (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : '')) + ' "' + el.textContent.trim().slice(0, 30) + '"', count: 0 });
                pairs.get(k).count++;
            }
            // Placeholder and the selection colours are painted too, but only via pseudo-elements.
            const ta = document.getElementById('prog');
            const ph = parse(getComputedStyle(ta, '::placeholder').color), tabg = bgOf(ta);
            const phc = ph.a < 1 ? over(ph, tabg) : ph;
            const s = getComputedStyle(document.body, '::selection');
            const sf = parse(s.color), sb = parse(s.backgroundColor);
            return {
                pairs: [...pairs.values()].sort((a, b) => a.ratio - b.ratio),
                placeholder: { fg: hex(phc), bg: hex(tabg), ratio: +ratio(phc, tabg).toFixed(2) },
                selection: sb.a > 0 ? { fg: hex(sf), bg: hex(sb), ratio: +ratio(sf, sb).toFixed(2) } : null,
            };
        });

        // The amount verdict colours: yes/no on the panel.
        await page.locator('#amt').fill('5');
        r.tryOutColor = await page.locator('#tryOut').evaluate((el) => getComputedStyle(el).color + ' class=' + el.className);
        await shot(page, 'a11y-desktop-' + scheme);
        await ctx.close();
        report.a11y[scheme] = r;
        save();
    }

    // Zoom: 200% and 400% of a 1280-wide window are 640 and 320 CSS px. Browser zoom scales the
    // CSS viewport down; Playwright cannot set Chrome's zoom level, so the viewport stands in.
    report.zoom = {};
    for (const [z, w] of [['200', 640], ['400', 320]]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: Math.round(900 * w / 1280) }, colorScheme: 'light' });
        const page = await ctx.newPage();
        await replay(page, fx);
        await page.goto(BASE + '/');
        await settled(page);
        await page.waitForTimeout(1200);
        await shot(page, 'zoom-' + z);
        report.zoom[z] = await page.evaluate(audit);
        await ctx.close();
    }
    // Also real CSS zoom via CDP, which scales the layout viewport as the browser's zoom does.
    for (const [z, f] of [['200-cdp', 2], ['400-cdp', 4]]) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
        const page = await ctx.newPage();
        await replay(page, fx);
        await page.goto(BASE + '/');
        await settled(page);
        await page.evaluate((f) => { document.documentElement.style.zoom = String(f); }, f);
        await page.waitForTimeout(600);
        await shot(page, 'zoom-' + z);
        report.zoom[z] = await page.evaluate(audit);
        await ctx.close();
    }
    save();
});

test('perf: cold load, requests, column timings, long tasks, meta', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
        window.__lt = [];
        try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }))).observe({ type: 'longtask', buffered: true }); } catch {}
    });
    const reqs = [];
    const seen = new Map();
    page.on('request', (rq) => { const k = rq.method() + ' ' + rq.url(); seen.set(k, (seen.get(k) || 0) + 1); reqs.push({ k, t: Date.now(), status: null }); });
    page.on('response', async (rs) => { const e = reqs.find((r) => r.k === rs.request().method() + ' ' + rs.url() && r.status === null); if (e) { e.status = rs.status(); e.ms = Date.now() - e.t; try { e.size = (await rs.body()).length; } catch {} } });
    page.on('requestfailed', (rq) => { const e = reqs.find((r) => r.k === rq.method() + ' ' + rq.url() && r.status === null); if (e) e.status = 'FAILED ' + rq.failure()?.errorText; });
    const t0 = Date.now();
    await page.goto(BASE + '/', { waitUntil: 'load' });
    const columns = {};
    await Promise.all([['pub', '#pub'], ['auth', '#auth'], ['rep', '#rep'], ['out', '#out'], ['health', '#health']].map(async ([k, s]) => {
        try {
            await page.waitForFunction((s) => { const el = document.querySelector(s); return el && !el.classList.contains('spin') && !el.hidden; }, s, { timeout: 120_000 });
            columns[k] = { ms: Date.now() - t0, state: await page.locator(s).evaluate((el) => el.querySelector('.err') ? 'error: ' + el.querySelector('.err').textContent : 'ok') };
        } catch { columns[k] = { ms: null, state: 'not resolved in 120s (or hidden)' }; }
    }));
    await page.waitForTimeout(1000);
    const nav = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0].toJSON();
        const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
        return { ...Object.fromEntries(Object.entries(n).filter(([k, v]) => typeof v === 'number').map(([k, v]) => [k, Math.round(v)])), paint, longTasks: window.__lt, resources: performance.getEntriesByType('resource').length };
    });
    report.perf = { base: BASE, nav, columns, requests: reqs.map((r) => ({ ...r, t: undefined })), repeated: [...seen].filter(([, n]) => n > 1), count: reqs.length };
    await ctx.close();
    save();
});

test('resilience: slow network shows skeletons; offline mid-load shows errors with retry; retry recovers', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const held = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    // Hold every API call until told, which is what a slow link looks like from the page.
    await page.route('**/v1/**', async (route) => { held.push(route.request().url()); await gate; await route.continue().catch(() => {}); });
    await page.goto(BASE + '/');
    await page.waitForTimeout(1500);
    const r = {};
    r.duringSlow = await page.evaluate(() => ({
        skeletons: [...document.querySelectorAll('.spin')].map((e) => e.id),
        ariaBusy: [...document.querySelectorAll('[aria-busy=true]')].map((e) => e.id),
        status: document.getElementById('status').textContent,
        decodeDisabled: document.getElementById('go').disabled,
        outHidden: document.getElementById('out').hidden,
        healthHidden: document.getElementById('health').hidden,
    }));
    await shot(page, 'resilience-1-slow-skeleton');
    // Go offline while the requests are still in flight, then let them through — they fail.
    await ctx.setOffline(true);
    release();
    await page.waitForFunction(() => ['pub', 'auth', 'rep'].every((id) => !document.getElementById(id).classList.contains('spin')), null, { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    r.afterOffline = await page.evaluate(() => ({
        errors: [...document.querySelectorAll('.err')].map((e) => (e.closest('[id]')?.id || '?') + ': ' + e.textContent),
        retryButtons: [...document.querySelectorAll('button')].filter((b) => /again/.test(b.textContent)).map((b) => b.closest('[id]')?.id),
        stillSkeleton: [...document.querySelectorAll('.spin')].map((e) => e.id),
        status: document.getElementById('status').textContent,
        decodeDisabled: document.getElementById('go').disabled,
        outHidden: document.getElementById('out').hidden,
        outText: document.getElementById('out').textContent.trim().slice(0, 160),
        healthHidden: document.getElementById('health').hidden,
        tryHidden: document.getElementById('try').hidden,
        progValue: document.getElementById('prog').value,
    }));
    await shot(page, 'resilience-2-offline-errors');
    // Back online: click every retry, and the decode's own recovery.
    await ctx.setOffline(false);
    await page.unroute('**/v1/**');
    for (const b of await page.locator('button:has-text("try again")').all()) await b.click();
    await page.locator('#live').click();
    await page.waitForFunction(() => ['pub', 'auth', 'rep'].every((id) => !document.getElementById(id).classList.contains('spin') && !document.getElementById(id).querySelector('.err')) && document.querySelector('#out dl.facts'), null, { timeout: 120_000 }).catch(() => {});
    r.afterRetry = await page.evaluate(() => ({
        errors: [...document.querySelectorAll('.err')].map((e) => (e.closest('[id]')?.id || '?') + ': ' + e.textContent),
        resolved: ['pub', 'auth', 'rep'].filter((id) => !document.getElementById(id).classList.contains('spin') && !document.getElementById(id).querySelector('.err')),
        outHasFacts: !!document.querySelector('#out dl.facts'),
        healthHidden: document.getElementById('health').hidden,
        status: document.getElementById('status').textContent,
    }));
    await shot(page, 'resilience-3-after-retry');
    await ctx.close();

    // A request that never answers: is there a client-side timeout?
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page2 = await ctx2.newPage();
    await page2.route('**/v1/**', () => { /* never resolve */ });
    await page2.goto(BASE + '/');
    await page2.waitForTimeout(30_000);
    r.hang30s = await page2.evaluate(() => ({
        skeletons: [...document.querySelectorAll('.spin')].map((e) => e.id),
        status: document.getElementById('status').textContent,
        decodeDisabled: document.getElementById('go').disabled,
        liveDisabled: document.getElementById('live').disabled,
    }));
    await shot(page2, 'resilience-4-hang-30s');
    await ctx2.close();
    report.resilience = r;
    save();
});

test('print: the comparison table and the live position on paper', async ({ browser, request }) => {
    const fx = await captureFixtures(request);
    report.print = {};
    for (const scheme of ['light', 'dark']) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
        const page = await ctx.newPage();
        await replay(page, fx);
        await page.goto(BASE + '/');
        await settled(page);
        await page.emulateMedia({ media: 'print' });
        await page.waitForTimeout(1200);
        await shot(page, 'print-' + scheme);
        report.print[scheme] = await page.evaluate(() => {
            const vis = (s) => { const el = document.querySelector(s); if (!el) return 'missing'; const r = el.getBoundingClientRect(); return r.height > 0 && !el.closest('[hidden]') ? 'visible h=' + Math.round(r.height) : 'hidden'; };
            return {
                bodyBg: getComputedStyle(document.body).backgroundColor,
                bodyColor: getComputedStyle(document.body).color,
                compare: vis('table.compare'), bars: vis('.bars'), fillWidth: getComputedStyle(document.querySelector('.bar .fill')).width,
                auth: vis('#auth dl.facts'), pub: vis('#pub'), rep: vis('#rep'), out: vis('#out dl.facts'), health: vis('#healthOut'),
                textarea: vis('#prog'), buttons: vis('#go'), printRules: [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => r.media && /print/.test(r.media.mediaText)).length,
                textareaScrollHidden: (() => { const t = document.getElementById('prog'); return t.scrollHeight > t.clientHeight; })(),
            };
        });
        await page.pdf({ path: path.join(OUT, 'print-' + scheme + '.pdf'), format: 'A4', printBackground: true });
        await ctx.close();
    }
    save();
});
