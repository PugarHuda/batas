import { test, expect } from '@playwright/test';

// The two pages at their edges: a health route that fails or refuses, a network that crawls, a
// visitor with no mouse, a phone held at 320px or a desktop at 200%, a visitor who asked for less
// motion, a program that is not one, and every link a visitor can follow out of the chrome.
//
// The local config gives the free routes a brake of twelve a minute, and /app alone spends five
// per load. So the real answers are read once, at the start, and replayed into the pages whose
// subject is layout or keyboard rather than the chain; the tests whose subject IS what the service
// says (the slow real read, the decode of a bad program) go to the network for real. Nine free
// requests in all.
//
// The brake is one bucket per caller, keyed on X-Forwarded-For, and service.spec.mjs empties the
// loopback bucket on purpose while it runs in a parallel worker. Arriving as a caller of its own
// (a documentation-range address) keeps this suite from being starved by that test, and keeps
// its nine requests from pushing that suite's other tests over the brake.
test.use({ extraHTTPHeaders: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.21' } });
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const FREE = {
    '/v1/mandate/decode': ['POST', {}],
    '/v1/mandate/publication': ['POST', {}],
    '/v1/agent/authority': ['GET'],
    '/v1/agent/reputation': ['GET'],
    '/v1/position/health': ['GET'],
    '/v1/agent/name': ['GET'],
};

/** @type {Record<string, { status: number, body: string }>} */
let live;

test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    live = {};
    for (const [path, [method, data]] of Object.entries(FREE)) {
        const r = method === 'POST' ? await request.post(path, { data }) : await request.get(path);
        live[path] = { status: r.status(), body: await r.text() };
    }
});

// Both pages read the ENS name on every load. Replayed in every test, so the name panel does not
// spend the nine real requests this suite budgets for the tests whose subject is the service. A
// test's own route, registered later, still takes precedence.
test.beforeEach(async ({ page }) => {
    await page.route('**/v1/agent/name', (route) => route.fulfill({ status: live['/v1/agent/name'].status, contentType: 'application/json', body: live['/v1/agent/name'].body }));
});

// The chart, the slider and the facts only exist when the chain answered. If it did not, the
// tests that need them cannot say anything about the page, and saying so beats a confusing failure.
const needLive = (...paths) => {
    for (const p of paths) expect(live[p].status, `the live ${p} read failed from here: ${live[p].body}`).toBe(200);
};

// Every free route answers from the captured real response; anything else reaches the service.
const replay = (page) => page.route('**/v1/**', (route) => {
    const hit = live[new URL(route.request().url()).pathname];
    return hit ? route.fulfill({ status: hit.status, contentType: 'application/json', body: hit.body }) : route.fallback();
});

// What the page itself got wrong. Chromium also logs "Failed to load resource" for any 4xx/5xx
// fetch — that is the browser reporting the response the test injected, not the page misbehaving.
const watchErrors = (page) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
        if (m.type() === 'error' && !/^Failed to load resource: the server responded with a status of \d+/.test(m.text())) errors.push('console: ' + m.text());
    });
    return errors;
};

const landingDrawn = async (page) => {
    await expect(page.locator('#envBody svg.env')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#pCap')).not.toHaveText('—');
};

const appSettled = (page) => page.waitForFunction(
    () => ['pub', 'auth', 'rep'].every((id) => !document.getElementById(id).classList.contains('spin'))
        && !document.getElementById('out').hidden && !document.getElementById('health').hidden,
    null, { timeout: 30_000 },
);

// --- the health route failing -------------------------------------------------------------------

for (const [status, body] of [
    [500, { error: 'upstream exploded' }],
    // The body the service's own brake sends, so the page is tested against the refusal it will get.
    [429, { error: 'too many free requests; at most 60 per 60s', retryAfterSeconds: 60 }],
]) {
    test(`the landing states a ${status} from the health route instead of a blank plate`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.route('**/v1/position/health', (route) => route.fulfill({
            status, contentType: 'application/json', body: JSON.stringify(body),
            headers: status === 429 ? { 'Retry-After': '60' } : {},
        }));
        await page.goto('/');
        await expect(page.locator('#asOf')).toHaveText('could not read');
        const plate = page.locator('#envBody');
        await expect(plate).toContainText('The live position could not be read from here');
        await expect(plate).toContainText(body.error);
        await expect(plate.getByRole('link', { name: 'Open the app' })).toHaveAttribute('href', '/app');
        await expect(page.locator('#envBody svg')).toHaveCount(0);
        await expect(page.locator('#plateSrc')).toHaveText('unavailable');
        for (const id of ['#lPub', '#lAuth', '#lRep']) await expect(page.locator(id)).toHaveText('could not read');
        expect(errors).toEqual([]);
    });
}

test('a health route that answers something other than JSON is still a stated failure', async ({ page }) => {
    const errors = watchErrors(page);
    await page.route('**/v1/position/health', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad gateway</h1>' }));
    await page.goto('/');
    await expect(page.locator('#envBody')).toContainText('could not be read from here (HTTP 502)');
    expect(errors).toEqual([]);
});

// --- a slow network -----------------------------------------------------------------------------

test('on a slow network the landing says it is reading, then shows what it read', async ({ page }) => {
    const errors = watchErrors(page);
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route('**/v1/position/health', async (route) => { await held; await route.fallback(); });
    await page.goto('/');
    // Held for as long as the assertions take: the loading state is what a slow visitor sees.
    await expect(page.locator('#envBody .loading')).toHaveText('Reading the live position from Sepolia.');
    await expect(page.locator('#asOf')).toHaveText('reading Sepolia…');
    await expect(page.locator('#lPub')).toContainText('reading the mirror node');
    await page.waitForTimeout(2_500);
    await expect(page.locator('#envBody .loading')).toBeVisible();
    release();
    // The real read, after the delay: the chart, or the page's stated failure — never the spinner text.
    await expect(page.locator('#asOf')).not.toHaveText('reading Sepolia…', { timeout: 60_000 });
    await expect(page.locator('#envBody svg.env, #envBody .loading:has-text("could not be read")').first()).toBeVisible();
    expect(errors).toEqual([]);
});

test('on a slow network the app shows its skeletons, then the columns', async ({ page }) => {
    needLive(...Object.keys(FREE));
    const errors = watchErrors(page);
    await page.route('**/v1/**', async (route) => {
        const hit = live[new URL(route.request().url()).pathname];
        if (!hit) return route.fallback();
        await new Promise((r) => setTimeout(r, 2_000));
        await route.fulfill({ status: hit.status, contentType: 'application/json', body: hit.body });
    });
    await page.goto('/app');
    for (const id of ['#pub', '#auth', '#rep']) {
        await expect(page.locator(id)).toHaveClass(/spin/);
        await expect(page.locator(id)).toHaveAttribute('aria-busy', 'true');
    }
    await expect(page.locator('#status')).toHaveText('reading…');
    await expect(page.locator('#go')).toBeDisabled();
    await appSettled(page);
    for (const id of ['#pub', '#auth', '#rep']) await expect(page.locator(id)).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('#go')).toBeEnabled();
    expect(errors).toEqual([]);
});

// --- keyboard only ------------------------------------------------------------------------------

// Tabs through the page from the top and reports, for every control a mouse could use, whether Tab
// reached it and whether the element Tab landed on drew a focus indicator.
async function tabThrough(page) {
    const expected = await page.evaluate(() => {
        const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]');
        const all = [...document.querySelectorAll('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])')]
            .filter((el) => shown(el) && !el.disabled);
        all.forEach((el, i) => el.setAttribute('data-qa-tab', String(i)));
        return all.map((el) => (el.id ? '#' + el.id : el.tagName.toLowerCase()) + ' ' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40));
    });
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    const reached = new Set();
    const unmarked = [];
    for (let i = 0; i < expected.length + 10; i++) {
        await page.keyboard.press('Tab');
        const f = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const cs = getComputedStyle(el);
            const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1) || (cs.boxShadow !== 'none' && /\d+px \d+px/.test(cs.boxShadow));
            return { tab: el.getAttribute('data-qa-tab'), ring, name: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') };
        });
        if (!f) break;
        if (f.tab !== null && reached.has(f.tab)) break;
        if (f.tab !== null) reached.add(f.tab);
        if (!f.ring) unmarked.push(f.name);
    }
    const missed = expected.filter((_, i) => !reached.has(String(i)));
    return { expected, missed, unmarked };
}

test('the landing: every control reachable by Tab, each with a visible focus ring, and the slider works by arrow key', async ({ page }) => {
    needLive('/v1/position/health');
    const errors = watchErrors(page);
    await replay(page);
    await page.goto('/');
    await landingDrawn(page);

    const { expected, missed, unmarked } = await tabThrough(page);
    expect(expected.length).toBeGreaterThan(8);
    expect(missed, 'controls Tab never reached').toEqual([]);
    expect(unmarked, 'focused without a visible indicator').toEqual([]);

    const size = page.locator('#size');
    await size.focus();
    await page.keyboard.press('Home');
    await expect(page.locator('#sizeOut')).toHaveText(/^0\.00 A → 0\.00 B$/);
    await expect(page.locator('#readout')).toContainText(/inside/);
    const before = await page.locator('#sizeOut').textContent();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('#sizeOut')).not.toHaveText(before);
    expect(Number(await size.inputValue())).toBeGreaterThan(0);
    // The marker moves with the readout, not only the text.
    const cx = await page.locator('#mk').getAttribute('cx');
    await page.keyboard.press('End');
    await expect(page.locator('#readout')).toContainText('settlement refuses');
    expect(await page.locator('#mk').getAttribute('cx')).not.toBe(cx);
    expect(errors).toEqual([]);
});

test('the app: every control reachable by Tab, each with a visible focus ring, and Enter decodes', async ({ page }) => {
    needLive('/v1/mandate/decode', '/v1/position/health');
    const errors = watchErrors(page);
    await replay(page);
    await page.goto('/app');
    await appSettled(page);

    const { expected, missed, unmarked } = await tabThrough(page);
    for (const id of ['#prog', '#go', '#live', '#amt']) expect(expected.some((e) => e.startsWith(id + ' ')), id).toBe(true);
    expect(missed, 'controls Tab never reached').toEqual([]);
    expect(unmarked, 'focused without a visible indicator').toEqual([]);

    // The amount box answers as it is typed into, and the Decode button is a real button.
    await page.locator('#amt').focus();
    await page.keyboard.type('1');
    await expect(page.locator('#tryOut')).not.toHaveText('');
    await page.locator('#go').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#status')).toHaveText('decoded the pasted program');
    expect(errors).toEqual([]);
});

// --- the decode panel, given nonsense -----------------------------------------------------------

test('the decode panel says what is wrong with an invalid program, and an empty one reads the live position', async ({ page }) => {
    needLive('/v1/mandate/decode');
    const errors = watchErrors(page);
    // Only the page's own load is replayed; every decode typed afterwards goes to the service.
    let loads = 0;
    await page.route('**/v1/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/v1/mandate/decode' && loads++ > 0) return route.fallback();
        const hit = live[path];
        return hit ? route.fulfill({ status: hit.status, contentType: 'application/json', body: hit.body }) : route.fallback();
    });
    await page.goto('/app');
    await appSettled(page);
    await expect(page.locator('#try')).toBeVisible();

    for (const [program, says] of [
        ['not hex at all', 'program must be a 0x hex string'],
        ['0x1234', 'instruction at byte 0 claims 52 arg bytes but only 0 remain'],
    ]) {
        await page.locator('#prog').fill(program);
        await page.locator('#go').click();
        await expect(page.locator('#out .err')).toHaveText(says, { timeout: 15_000 });
        await expect(page.locator('#out')).toContainText('clear the box to read the live position');
        await expect(page.locator('#try')).toBeHidden();
        await expect(page.locator('#status')).toHaveText('');
        await expect(page.locator('#go')).toBeEnabled();
        // The bad bytes stay where the visitor typed them, to be corrected rather than retyped.
        await expect(page.locator('#prog')).toHaveValue(program);
    }

    // Whitespace is empty: the page must send no program at all, and the service reads the live one.
    await page.locator('#prog').fill('   \n  ');
    const sent = page.waitForRequest((r) => r.url().endsWith('/v1/mandate/decode'));
    await page.locator('#go').click();
    expect((await sent).postDataJSON()).toEqual({});
    await expect(page.locator('#status')).toHaveText(/decoded the live position on Sepolia|^$/, { timeout: 60_000 });
    await expect(page.locator('#out dl.facts, #out .err').first()).toBeVisible();
    if (await page.locator('#out dl.facts').count()) {
        await expect(page.locator('#status')).toHaveText('decoded the live position on Sepolia');
        await expect(page.locator('#prog')).toHaveValue(/^0x21/);
        await expect(page.locator('#try')).toBeVisible();
    }
    expect(errors).toEqual([]);
});

// --- reflow -------------------------------------------------------------------------------------

// A 1280px window at 200% zoom lays out at 640 CSS pixels; 320 is the WCAG reflow width, and a
// small phone. Neither may scroll sideways.
for (const [label, viewport] of [['200% zoom', { width: 640, height: 800 }], ['a 320px viewport', { width: 320, height: 640 }]]) {
    for (const path of ['/', '/app']) {
        test(`${path} at ${label} does not scroll sideways`, async ({ page }) => {
            needLive('/v1/position/health', '/v1/mandate/decode');
            await page.setViewportSize(viewport);
            await replay(page);
            await page.goto(path);
            if (path === '/') await landingDrawn(page); else await appSettled(page);
            const over = await page.evaluate(() => {
                const de = document.documentElement;
                const offenders = [...document.querySelectorAll('body *')]
                    .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1 && el.getClientRects().length && !el.closest('.sr, [hidden]'))
                    .slice(0, 6).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + [...el.classList].join('.'));
                return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, offenders };
            });
            expect(over.scrollWidth, `wider than the viewport: ${over.offenders.join(', ')}`).toBeLessThanOrEqual(over.clientWidth);
        });
    }
}

// --- reduced motion -----------------------------------------------------------------------------

const motion = () => {
    const longest = (list) => Math.max(...list.split(',').map((s) => parseFloat(s) * (s.trim().endsWith('ms') ? 0.001 : 1)));
    const moving = [];
    for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        const anim = cs.animationName !== 'none' ? longest(cs.animationDuration) : 0;
        const trans = longest(cs.transitionDuration);
        if (anim > 0.01 || trans > 0.01) moving.push(el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ` anim=${anim}s trans=${trans}s`);
    }
    return moving;
};

test('a visitor who asked for less motion gets none, on both pages', async ({ page }) => {
    needLive('/v1/position/health', '/v1/mandate/decode');
    await replay(page);
    // First without the preference, so the check is known to see the motion it is meant to remove.
    await page.goto('/app');
    await appSettled(page);
    expect((await page.evaluate(motion)).length).toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const path of ['/', '/app']) {
        await page.goto(path);
        if (path === '/') await landingDrawn(page); else await appSettled(page);
        expect(await page.evaluate(motion), path).toEqual([]);
    }
});

// --- where the chrome's links go ----------------------------------------------------------------

test('every link in the top bar and footer of both pages resolves on this service', async ({ page, request }) => {
    await page.route('**/v1/**', (route) => route.abort());
    const checked = new Map();
    for (const path of ['/', '/app']) {
        await page.goto(path);
        const hrefs = await page.locator('header.bar-top a[href], footer a[href]').evaluateAll((as) => as.map((a) => a.href));
        expect(hrefs.length, path).toBeGreaterThan(4);
        for (const href of hrefs) {
            const url = new URL(href);
            if (url.origin !== new URL(page.url()).origin || checked.has(href)) continue;
            // As a browser asks for it, since that is who follows these links.
            const res = await request.get(url.pathname + url.search, { headers: { Accept: 'text/html,application/json;q=0.9' } });
            checked.set(href, res.status());
            expect(res.status(), `${href} from ${path}`).toBeLessThan(400);
            if (url.hash) {
                await page.goto(href);
                await expect(page.locator(url.hash), `${href} from ${path}`).toHaveCount(1);
                await page.goto(path);
            }
            // A link that says JSON must hand a browser JSON, not the landing it is standing on.
            if (/as JSON/.test(await page.locator(`a[href="${url.pathname + url.search}"]`).first().textContent().catch(() => ''))) {
                expect(res.headers()['content-type'], href).toContain('application/json');
            }
        }
    }
    expect([...checked.keys()].map((h) => new URL(h).pathname + new URL(h).search + new URL(h).hash).sort())
        .toEqual(expect.arrayContaining(['/', '/#cost', '/#envelope', '/#proof', '/?format=json', '/app']));
});
