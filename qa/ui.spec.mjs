import { test, expect } from '@playwright/test';

// The one page, held to what it says and to whom. `service.spec.mjs` pins that a browser gets HTML
// and nothing else does; this pins what the HTML is — the terms it uses, the attribution the
// SwapVM/Aqua licence requires in a UI, and that a route the host may not serve yet is not an
// error a visitor sees.

const html = (request) => request.get('/', { headers: { Accept: 'text/html' } }).then((r) => r.text());

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
    await page.goto('/');
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
