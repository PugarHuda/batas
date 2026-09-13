import { test, expect } from '@playwright/test';

// The one page, held to what it says and to whom. `service.spec.mjs` pins that a browser gets HTML
// and nothing else does; this pins what the HTML is — the terms it uses, the attribution the
// SwapVM/Aqua licence requires in a UI, and that a route the host may not serve yet is not an
// error a visitor sees.

// The instrument lives at /app now; / is the landing. The pins below are about the instrument.
const html = (request) => request.get('/app', { headers: { Accept: 'text/html' } }).then((r) => r.text());

test('the page uses the canonical terms and carries the licence attribution', async ({ request }) => {
    const body = await html(request);
    expect(body).toContain('<h3>Kill switch</h3>');
    expect(body).toContain('<dt>mandate name</dt>');
    expect(body).not.toMatch(/<strong>Authority<\/strong>|<dt>name<\/dt>|max input|floor rate/);
    expect(body).toContain('Powered by SwapVM — © Degensoft Ltd 2025 · Powered by Aqua — © Degensoft Ltd 2025');
});

test('the page is reachable by keyboard and screen reader, not only by eye', async ({ request }) => {
    const body = await html(request);
    expect(body).toContain('<label for="prog">');
    expect(body).toContain('aria-describedby="prog-hint"');
    expect(body).toContain('id="status" class="muted" role="status"');
    expect(body).not.toContain('aria-live="polite" aria-busy');
    expect(body).toMatch(/<th scope="col">Question<\/th>/);
    expect(body).toContain('<span class="sr"> (held the floor)</span>');
    expect(body).toContain('--edge:');
    expect(body).not.toContain('outline: none');
    for (const href of ['https://github.com/PugarHuda/batas', 'https://hashscan.io/testnet/topic/']) {
        expect(body, href).toMatch(new RegExp(`href="${href}[^"]*" rel="noopener"`));
    }
});

test('the live columns and the morning report render, and a missing route is not an error', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/app');
    await page.waitForFunction(
        () => ['pub', 'auth', 'rep'].every((id) => !document.getElementById(id).classList.contains('spin')),
        null, { timeout: 90_000 },
    );
    // The chain may not answer from where this runs; what is pinned is that the page says which —
    // the facts table in the new terms, or the error path with its recovery — never a blank.
    const out = page.locator('#out dl.facts, #out .err');
    await expect(out.first()).toBeVisible({ timeout: 90_000 });
    if (await page.locator('#out dl.facts').count()) {
        await expect(page.locator('#out dl.facts')).toContainText('B per A');
        await expect(page.locator('#out dl.facts')).not.toContainText(/max input|floor rate/);
    }
    await expect(page.locator('#auth')).toContainText(/held|revoked|expired|could not read/);

    const health = await request.get('/v1/position/health');
    if (health.ok()) {
        await expect(page.locator('#health')).toBeVisible({ timeout: 90_000 });
        await expect(page.locator('#healthOut dl.facts dt').first()).toHaveText('status');
        expect(await page.locator('#healthOut dl.facts dt').count()).toBe(5);
    } else {
        // A route the host does not serve yet is not the visitor's problem: the section hides itself.
        await page.waitForTimeout(500);
        await expect(page.locator('#health')).toBeHidden();
    }
    expect(page.locator('#health .err')).toHaveCount(0);
    expect(errors).toEqual([]);
});


// --- the landing --------------------------------------------------------------------------------
//
// Two rooms, and a visitor must be able to tell which one they are in and get to the other. The
// landing makes the case; the app does the work. What is pinned here is the split itself, that the
// landing's numbers are the measured ones, and that its chart is drawn from the chain, not a mock.

test('the landing and the app are different pages that lead to each other', async ({ request }) => {
    const landing = await request.get('/', { headers: { Accept: 'text/html' } }).then((r) => r.text());
    const app = await html(request);
    expect(landing).not.toEqual(app);
    expect(landing).toContain('href="/app"');
    expect(app).toContain('href="/"');
    expect(landing).toContain('Powered by SwapVM — © Degensoft Ltd 2025 · Powered by Aqua — © Degensoft Ltd 2025');
    // The measured result, not a rounded or illustrative one.
    for (const figure of ['1,667.53', '271.86', '975 gas']) expect(landing, figure).toContain(figure);
    expect(landing).not.toContain('outline: none');
});

test('the landing draws its envelope from the live position, and says so when it cannot', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /Check the live position/ })).toHaveAttribute('href', '/app');
    // Either the chart and its probe, or a stated failure — never a blank plate.
    const drawn = page.locator('#envBody svg.env, #envBody .loading');
    await expect(drawn.first()).toBeVisible({ timeout: 90_000 });
    if (await page.locator('#envBody svg.env').count()) {
        // A range input cannot be typed into; set it the way a drag does, value then an input event.
        const setSize = (v) => page.locator('#size').evaluate((el, value) => {
            el.value = value === 'max' ? el.max : value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, v);
        await setSize('0');
        await expect(page.locator('#readout')).toContainText(/inside the envelope/);
        await setSize('max');
        await expect(page.locator('#readout')).toContainText(/settlement refuses/);
    }
    expect(errors).toEqual([]);
});

test('the fonts are served from here, cached, and nothing is fetched from a third party', async ({ page, request }) => {
    const font = await request.get('/assets/fonts/b612-400.woff2');
    expect(font.status()).toBe(200);
    expect(font.headers()['content-type']).toContain('font/woff2');
    expect(font.headers()['cache-control']).toContain('immutable');
    expect((await request.get('/assets/fonts/nope.woff2')).status()).toBe(404);

    const foreign = [];
    page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1') && !r.url().startsWith('data:')) foreign.push(r.url()); });
    await page.goto('/');
    await page.goto('/app');
    expect(foreign).toEqual([]);
});
