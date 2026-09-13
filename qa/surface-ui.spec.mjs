import { test, expect } from '@playwright/test';

// The four capability panels on both pages, populated from real answers: the ENS name from this
// service's chain read, the x402 manifest and agent card this service publishes, and the directory
// entry, token and payment trail from the public Hedera mirror node. Nothing is replayed here: the
// subject is that the live reads arrive and land where a judge looks, on a desktop and on a phone.
//
// Each viewport arrives as a caller of its own (a documentation-range address), because the local
// brake allows twelve free requests a minute and one landing plus one app load spends eight.
test.setTimeout(180_000);

const MIRROR = 'https://testnet.mirrornode.hedera.com/api/v1';

// The expected figures, read the way the page reads them, so a changed price or a new payment
// changes the expectation rather than failing the test.
async function truth(request) {
    const manifest = await (await request.get('/.well-known/x402')).json();
    const metered = manifest.resources[0].metered;
    const hb = (t) => (Number(t) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    const page = await (await request.get(`${MIRROR}/topics/0.0.10394165/messages?order=desc&limit=100`, { headers: {} })).json();
    const payments = page.messages
        .map((m) => { try { return JSON.parse(Buffer.from(m.message, 'base64').toString('utf8')); } catch { return null; } })
        .filter((p) => p?.kind === 'batas.payment');
    return { range: `${hb(metered.min)} – ${hb(metered.max)} HBAR`, payments };
}

const settled = (page) => page.waitForFunction(
    () => ['sName', 'sPrice', 'sReach', 'sTrail'].every((id) => !document.getElementById(id).hasAttribute('aria-busy')),
    null, { timeout: 90_000 },
);

for (const [label, viewport, ip] of [
    ['desktop', { width: 1280, height: 900 }, '198.51.100.61'],
    ['a 400px phone', { width: 400, height: 860 }, '198.51.100.62'],
]) {
    test.describe(label, () => {
        test.use({ viewport, extraHTTPHeaders: { 'X-Forwarded-For': ip } });

        for (const path of ['/', '/app']) {
            test(`${path} shows the ENS name, the metered price, A2A with the directory, and the payment trail`, async ({ page, request }) => {
                const errors = [];
                page.on('pageerror', (e) => errors.push(e.message));
                const expected = await truth(request);
                await page.goto(path);
                // The loading state is in the served markup, before any read returns.
                await settled(page);

                const name = page.locator('#sName');
                await expect(name).toContainText('agent.batas.eth');
                await expect(name).toContainText('holds both ways');
                await expect(name.locator('a[href="https://sepolia.etherscan.io/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/10123"]')).toHaveText('ERC-8004 #10123');
                await expect(name.locator('a[href="https://sepolia.etherscan.io/address/0x671C506Aaa2a123bE802Fe51975Ca9515AEC2516"]')).toHaveCount(1);
                await expect(name.locator('.records li')).not.toHaveCount(0);
                await expect(name).toContainText('agent-registration[');

                const price = page.locator('#sPrice');
                await expect(price).toContainText(expected.range);
                for (const part of ['decode', 'per instruction', 'publication lookup', 'authority check', 'operator identity']) await expect(price).toContainText(part);
                await expect(price.locator('.assets li')).toHaveCount(2);
                await expect(price).toContainText('HBAR');
                await expect(price).toContainText(/1\.00 BIC/);
                await expect(price).toContainText(/custom fee 0\.01 BIC to 0\.0\.10388560/);
                // The fare row reads the same manifest; no flat price is left on either page.
                await expect(page.locator('[data-x402-range]')).toHaveText(expected.range);
                expect(await page.content()).not.toMatch(/from 0\.\d+ HBAR/);

                const reach = page.locator('#sReach');
                await expect(reach).toContainText('/a2a');
                await expect(reach).toContainText('a2a-x402, required');
                await expect(reach).toContainText('listed');
                await expect(reach).toContainText('0.0.6913983');
                await expect(reach).toContainText('#384');
                await expect(reach.locator(`a[href="${MIRROR}/topics/0.0.6913983/messages/384"]`)).toHaveCount(1);

                const trail = page.locator('#sTrail');
                await expect(trail).toContainText(`${expected.payments.length} payment record`);
                await expect(trail.locator('.trail li')).toHaveCount(Math.min(5, expected.payments.length));
                if (expected.payments.length) {
                    const [id, rest] = expected.payments[0].transaction.split('@');
                    await expect(trail.locator('.trail li').first().locator(`a[href="${MIRROR}/transactions/${id}-${rest.replace('.', '-')}"]`)).toHaveCount(1);
                }

                const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
                expect(wide, 'the page scrolls sideways').toBeLessThanOrEqual(0);
                expect(errors).toEqual([]);
            });
        }
    });
}

test('a panel that cannot read says what failed and reads again when asked', async ({ page }) => {
    let refuse = true;
    // This service's own routes only: a glob of **/v1/** would also catch the mirror's /api/v1/.
    await page.route(/^http:\/\/127\.0\.0\.1:\d+\/v1\//, (route) => route.abort());
    await page.route(`${MIRROR}/topics/0.0.10394165/messages**`, (route) => (refuse ? route.abort() : route.fallback()));
    await page.goto('/');
    await expect(page.locator('#sTrail')).toContainText('could not read the payment trail');
    await expect(page.locator('#sTrail')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('#sName')).toContainText('could not read the ENS name');
    refuse = false;
    await page.locator('#sTrail').getByRole('button', { name: 'try again' }).click();
    await expect(page.locator('#sTrail .trail-head')).toContainText('payment record', { timeout: 60_000 });
});
