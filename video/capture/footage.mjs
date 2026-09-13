// Records the browser footage for the demo video: the live site and the public explorers, each clip
// its own Playwright context so every clip is a separate 1920x1080 recording that starts on a
// loaded page. Nothing here is staged; the pages are the deployed service and third-party explorers.
//
//   node capture/footage.mjs [clipName...]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'public', 'footage');
const tmp = path.join(out, 'raw');
mkdirSync(tmp, { recursive: true });

const SITE = 'https://batas-one.vercel.app';
const ETHERSCAN = 'https://sepolia.etherscan.io';
const wait = (page, ms) => page.waitForTimeout(ms);

// Scrolls in small steps so the motion reads on video; a jump cut inside one page loses the viewer.
async function glide(page, to, ms = 2500) {
    const from = await page.evaluate(() => window.scrollY);
    const steps = Math.max(1, Math.round(ms / 40));
    for (let i = 1; i <= steps; i++) {
        const y = from + ((to - from) * (1 - Math.cos((Math.PI * i) / steps))) / 2;
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await wait(page, 40);
    }
}
const topOf = (page, sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().top + window.scrollY, sel);

async function explorer(page, url, extra, marks) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await wait(page, 6000);
    // HashScan opens a cookie dialog over the data; declining it is what a visitor would do first.
    const reject = page.getByRole('button', { name: /^reject$/i });
    if (await reject.isVisible().catch(() => false)) { await reject.click(); await wait(page, 1000); }
    marks?.push({ t: marks.clock(), event: 'loaded' });
    if (extra) await extra(page);
    await wait(page, 3000);
}

// A raw JSON response is one unbroken line of 10px text, unreadable once framed in a video. Chromium's
// own Pretty-print toggle indents it and a page zoom enlarges it; the response itself is untouched.
async function readableJson(page, scrollTo) {
    const toggle = page.getByLabel(/pretty-print/i);
    if (await toggle.isVisible().catch(() => false)) await toggle.check();
    await page.evaluate(() => { document.body.style.zoom = '1.7'; });
    await wait(page, 2500);
    await glide(page, scrollTo, 3500);
}

// GitHub renders a long README slowly; wait for the text itself, then glide to it.
async function toReadmeText(page, marks, needle, holdMs) {
    await page.goto('https://github.com/PugarHuda/batas', { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction((n) => document.body.innerText.includes(n), needle, { timeout: 60000 });
    await wait(page, 2000);
    marks.push({ t: marks.clock(), event: 'loaded' });
    const y = await page.evaluate((n) => {
        const el = [...document.querySelectorAll('pre, h2, h3')].find((x) => x.textContent.includes(n));
        return el ? el.getBoundingClientRect().top + window.scrollY - 160 : 0;
    }, needle);
    await glide(page, y, 3000);
    marks.push({ t: marks.clock(), event: `at ${needle}` });
    await wait(page, holdMs);
}

const clips = {
    // The hero, then the envelope probe moved through all three regions the readout names.
    async hero(page, marks) {
        await page.goto(SITE, { waitUntil: 'networkidle' });
        await page.waitForSelector('#size', { timeout: 60000 });
        await wait(page, 4000);
        await glide(page, (await topOf(page, '#envelope')) - 90, 3000);
        await wait(page, 1500);
        const max = Number(await page.getAttribute('#size', 'max'));
        let last = '';
        for (let i = 0; i <= 160; i++) {
            const v = (max * i) / 160;
            await page.evaluate((x) => { const s = document.querySelector('#size'); s.value = x; s.dispatchEvent(new Event('input', { bubbles: true })); }, v);
            const text = (await page.textContent('#readout')).trim().replace(/\s+/g, ' ');
            if (text !== last) { marks.push({ t: marks.clock(), readout: text, size: v }); last = text; }
            await wait(page, 70);
        }
        await wait(page, 2500);
    },
    async proof(page) {
        await page.goto(SITE, { waitUntil: 'networkidle' });
        await wait(page, 2000);
        await glide(page, (await topOf(page, '#proof')) - 60, 3000);
        await wait(page, 5000);
        await glide(page, (await topOf(page, '#cost')) - 60, 3000);
        await wait(page, 5000);
    },
    async app(page) {
        await page.goto(`${SITE}/app`, { waitUntil: 'domcontentloaded' });
        await wait(page, 12000);
        const h = await page.evaluate(() => document.body.scrollHeight);
        await glide(page, h * 0.25, 4000);
        await wait(page, 4000);
        await glide(page, h * 0.5, 4000);
        await wait(page, 4000);
        await glide(page, h * 0.75, 4000);
        await wait(page, 3000);
    },
    ship: (p) => explorer(p, `${ETHERSCAN}/tx/0x9408b60a7bfc5345f9909153f5d5bf97feb193b5716f3c0fae21c33b89830060`, (pg) => glide(pg, 500, 2500)),
    swap: (p) => explorer(p, `${ETHERSCAN}/tx/0x8cdec703361527046d60199bae327b8db7e784d55622897eace87b51c5909275`, (pg) => glide(pg, 500, 2500)),
    register: (p) => explorer(p, `${ETHERSCAN}/tx/0xe01d01d37a649db0a3573ad435913bf9530a594f5789d792d2ac22cee7dcb12f`, (pg) => glide(pg, 400, 2500)),
    registry: (p) => explorer(p, `${ETHERSCAN}/address/0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B`, (pg) => glide(pg, 450, 2500)),
    grant: (p) => explorer(p, `${ETHERSCAN}/tx/0x3da4cc3543bad065175d920bdb63ca5deb6e1c54b8e7d78b7f5ac68a03f0e1cc`, (pg) => glide(pg, 400, 2000)),
    textwrite: (p) => explorer(p, `${ETHERSCAN}/tx/0x09ab95bb180c7e7df8e5419c340b8ac5e23714522536e60647c23de3600276d2`, (pg) => glide(pg, 400, 2000)),
    resolver: (p) => explorer(p, `${ETHERSCAN}/address/0x671C506Aaa2a123bE802Fe51975Ca9515AEC2516`, (pg) => glide(pg, 400, 2000)),
    alias: (p) => explorer(p, `${ETHERSCAN}/tx/0x9d141f7051223969d48f49fce404b785780d21a7d1f4d6ba7778b5ec58eaa413`, (pg) => glide(pg, 400, 2000)),
    uri: (p) => explorer(p, `${ETHERSCAN}/tx/0x224e89f82d0cddf795f19f80abf7b33753ebfb7401bcccc8fbcde0653662d43c`, (pg) => glide(pg, 400, 2000)),
    aqua: (p) => explorer(p, `${ETHERSCAN}/address/0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`),
    token: (p, m) => explorer(p, 'https://hashscan.io/testnet/token/0.0.10523367', (pg) => wait(pg, 4000).then(() => glide(pg, 600, 3000)), m),
    schedule: (p, m) => explorer(p, 'https://hashscan.io/testnet/schedule/0.0.10523344', (pg) => wait(pg, 3000).then(() => glide(pg, 400, 2500)), m),
    mirror: (p) => explorer(p, 'https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10394165/messages?order=desc&limit=3', (pg) => readableJson(pg, 700)),
    name: (p) => explorer(p, `${SITE}/v1/agent/name`, (pg) => readableJson(pg, 500)),
    x402: (p) => explorer(p, `${SITE}/.well-known/x402`, (pg) => readableJson(pg, 700)),
    card: (p) => explorer(p, `${SITE}/.well-known/agent-card.json`, (pg) => readableJson(pg, 700)),
    // The kill switch's recorded run, as the README publishes it, rather than a fresh revoke of the
    // live name that other people are relying on.
    killswitch: (page, marks) => toReadmeText(page, marks, 'quote 1 A, name revoked', 16000),
    async readme(page, marks) {
        await toReadmeText(page, marks, 'Running it', 3000);
        for (const heading of ['The answer', 'Paying for what the bytecode says']) {
            const y = await page.evaluate((h) => {
                const el = [...document.querySelectorAll('h2, h3')].find((n) => n.textContent.trim().startsWith(h));
                return el ? el.getBoundingClientRect().top + window.scrollY - 160 : null;
            }, heading);
            if (y !== null) { await glide(page, y, 2000); marks.push({ t: marks.clock(), event: `at ${heading}` }); await wait(page, 2500); }
        }
    },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(clips);
const browser = await chromium.launch();
for (const name of names) {
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        recordVideo: { dir: tmp, size: { width: 1920, height: 1080 } },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        colorScheme: 'light',
    });
    const page = await context.newPage();
    const started = Date.now();
    const marks = [];
    marks.clock = () => Date.now() - started;
    try {
        await clips[name](page, marks);
    } catch (e) {
        console.error(`[${name}] ${e.message}`);
    }
    const video = page.video();
    await context.close();
    const webm = await video.path();
    const mp4 = path.join(out, `${name}.mp4`);
    // Playwright's webm carries no reliable duration, so each clip is re-encoded once to h264 here
    // and the composition only ever reads a seekable mp4.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', mp4]);
    rmSync(webm);
    writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ name, recordedAt: new Date(started).toISOString(), durationMs: Date.now() - started, marks }, null, 1));
    console.log(`[${name}] ${Date.now() - started} ms`);
}
await browser.close();
