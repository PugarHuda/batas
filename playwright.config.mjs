import { defineConfig } from '@playwright/test';

// API tests only. The service under test is an HTTP paywall, so there is nothing to render and no
// browser is launched — Playwright is here for its request fixture, its server lifecycle handling
// and its reporting, not for a page.
export default defineConfig({
    testDir: './qa',
    fullyParallel: false,
    // Two suites. `local` runs against a server this config starts; `production` runs against the
    // deployment the ERC-8004 registration points at, and needs no server of its own.
    projects: [
        { name: 'local', testMatch: /service\.spec\.mjs/ },
        { name: 'production', testMatch: /production\.spec\.mjs/ },
    ],
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
