import { defineConfig } from '@playwright/test';

// API tests only. The service under test is an HTTP paywall, so there is nothing to render and no
// browser is launched — Playwright is here for its request fixture, its server lifecycle handling
// and its reporting, not for a page.
export default defineConfig({
    testDir: './qa',
    fullyParallel: false,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: process.env.BATAS_SERVICE_URL || 'http://127.0.0.1:4021',
        extraHTTPHeaders: { 'Content-Type': 'application/json' },
    },
    webServer: {
        command: 'node agent/service.mjs',
        url: 'http://127.0.0.1:4021/',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        stdout: 'pipe',
        stderr: 'pipe',
    },
});
