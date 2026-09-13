// An API consumer wiring the service into a bot, trusting /openapi.json and nothing else.
//
// Runs against whatever baseURL the project gives it. Findings are collected rather than thrown so one
// run reports everything; hard failures use expect.soft. Rate-limiter probes are local only.

import { test as base, expect } from '@playwright/test';

const LIVE_PROGRAM =
    '0x212100000000000000006367be30fcbd45ea00000000000000001aeff914e72b45e8802005006acd0476222e945800Bd6CDd60521B64a12D7b3F12fC90916a6B39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E056167656e74700300753050000208000000006aa5dc37';

const findings = [];
const timings = [];
const note = (sev, what) => findings.push({ sev, what });
const short = (s, n = 160) => String(s).replace(/\s+/g, ' ').slice(0, n);

// One context per test, with its own forwarded address so the free brake counts each test separately
// (the service keys its bucket on X-Forwarded-For; production overwrites that header, so there it is
// shared and the spec stays under the window).
const test = base.extend({
    api: async ({ playwright, baseURL }, use, info) => {
        const who = `10.${(info.workerIndex % 200)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
        const ctx = await playwright.request.newContext({
            baseURL,
            extraHTTPHeaders: { 'x-forwarded-for': who },
            ignoreHTTPSErrors: true,
        });
        const isProd = !baseURL.includes('127.0.0.1');
        const call = async (method, url, opts = {}) => {
            const t0 = Date.now();
            const res = await ctx.fetch(url, { method, maxRedirects: 0, ...opts });
            const ms = Date.now() - t0;
            const text = await res.text();
            let json;
            try { json = JSON.parse(text); } catch { json = undefined; }
            timings.push({ env: isProd ? 'prod' : 'local', method, url: url.split('?')[0], status: res.status(), ms });
            return { res, status: res.status(), headers: res.headers(), text, json, ms };
        };
        await use({ call, isProd, who, ctx });
        await ctx.dispose();
    },
});

// --- the smallest JSON-schema checker the document needs -------------------------------------------

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
}

function check(schema, value, path, defs, out = { errors: [], undocumented: [] }) {
    if (!schema) return out;
    if (schema.$ref) schema = defs[schema.$ref.split('/').pop()];
    if (schema.allOf) { for (const s of schema.allOf) check(s, value, path, defs, out); return out; }
    const types = [].concat(schema.type ?? []);
    const t = typeOf(value);
    if (types.length && !types.includes(t) && !(t === 'integer' && types.includes('number'))) {
        out.errors.push(`${path}: is ${t}, documented ${types.join('|')}`);
        return out;
    }
    if (schema.enum && !schema.enum.includes(value)) out.errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
    if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) out.errors.push(`${path}: ${short(value, 40)} fails ${schema.pattern}`);
    if (t === 'object') {
        for (const r of schema.required ?? []) if (!(r in value)) out.errors.push(`${path}: required "${r}" missing`);
        for (const [k, v] of Object.entries(value)) {
            if (schema.properties?.[k]) check(schema.properties[k], v, `${path}.${k}`, defs, out);
            else if (schema.properties) out.undocumented.push(`${path}.${k}`);
        }
    }
    if (t === 'array' && schema.items) value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, defs, out));
    return out;
}

const isJsonError = (r) => /^application\/json/.test(r.headers['content-type'] ?? '') && r.json && typeof r.json.error === 'string';

function expectClientError(r, label, allowed = [400, 404, 405, 413, 415, 422]) {
    const ok = allowed.includes(r.status) && isJsonError(r);
    expect.soft(ok, `${label}: expected 4xx JSON {error}, got ${r.status} ${short(r.headers['content-type'])} ${short(r.text)}`).toBe(true);
    if (!ok) note(r.status >= 500 ? 'HIGH' : 'MEDIUM', `${label} -> ${r.status} ${short(r.headers['content-type'], 40)} ${short(r.text)}`);
    return ok;
}

// --- 1. contract conformance --------------------------------------------------------------------------

test('1. every documented route answers as documented', async ({ api }) => {
    const doc = (await api.call('GET', '/openapi.json')).json;
    expect(doc?.openapi).toBe('3.1.0');
    const defs = doc.components.schemas;
    const inputs = {
        'post /v1/mandate/decode': { data: { program: LIVE_PROGRAM } },
        'post /v1/mandate/publication': { data: { program: LIVE_PROGRAM } },
        'post /v1/mandate/explain': { data: { program: LIVE_PROGRAM } },
        'post /mcp': { data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'qa', version: '0' } } }, headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' } },
    };
    for (const [path, ops] of Object.entries(doc.paths)) {
        for (const [method, op] of Object.entries(ops)) {
            const key = `${method} ${path}`;
            const r = await api.call(method.toUpperCase(), path, inputs[key] ?? {});
            const documented = Object.keys(op.responses).map(Number);
            expect.soft(documented, `${key}: status ${r.status} is not a documented response (${documented})`).toContain(r.status);
            if (!documented.includes(r.status)) note('HIGH', `${key} answered ${r.status}, doc lists ${documented}: ${short(r.text)}`);
            const ct = r.headers['content-type'] ?? '';
            expect.soft(ct, `${key}: content-type`).toMatch(/^application\/json/);
            const schema = op.responses[r.status]?.content?.['application/json']?.schema;
            if (schema && r.json !== undefined) {
                const out = check(schema, r.json, key, defs);
                for (const e of out.errors) { note('MEDIUM', `schema: ${e}`); }
                expect.soft(out.errors, `${key}: schema violations`).toEqual([]);
                if (out.undocumented.length) note('LOW', `${key} ${r.status}: fields in reality not in doc: ${out.undocumented.join(', ')}`);
            }
            if (r.status === 402) {
                const hdr = r.headers['payment-required'];
                expect.soft(hdr, `${key}: PAYMENT-REQUIRED header`).toBeTruthy();
            }
        }
    }
    // A decode with no program reads the live position; the doc says `source` says which one.
    const live = await api.call('POST', '/v1/mandate/decode', { data: {} });
    expect.soft(live.status, 'decode without program').toBe(200);
    if (live.json) expect.soft(live.json.source, 'source of a live read').toMatch(/^live position 0x/);
});

// --- 2. error shapes ----------------------------------------------------------------------------------

test('2. wrong method, no body, wrong content-type, malformed bodies', async ({ api }) => {
    let r;
    r = await api.call('GET', '/v1/mandate/decode');
    expectClientError(r, 'GET on POST route /v1/mandate/decode');
    if (r.status === 404) note('LOW', `GET /v1/mandate/decode is 404 not 405 (no Allow header: ${r.headers.allow ?? 'none'})`);
    r = await api.call('POST', '/v1/agent/authority', { data: {} });
    expectClientError(r, 'POST on GET route /v1/agent/authority');
    r = await api.call('GET', '/openapi.json?foo=bar&program=zzz');
    expect.soft(r.status, 'unknown query params on /openapi.json').toBe(200);
    r = await api.call('GET', '/v1/agent/reputation?nonsense=1&agentId=10123');
    expect.soft(r.status, 'unknown query param alongside a valid one').toBe(200);

    // No body at all on a free POST: doc says requestBody not required for free routes, so this is
    // a live read, and must be 200 or a 502 with upstream:true.
    r = await api.call('POST', '/v1/mandate/decode', { headers: { 'content-type': 'application/json' } });
    expect.soft([200, 502], `POST decode with no body: ${r.status} ${short(r.text)}`).toContain(r.status);

    // text/plain body carrying JSON: is it read, ignored, or refused?
    r = await api.call('POST', '/v1/mandate/decode', { data: '{"program":"not-hex"}', headers: { 'content-type': 'text/plain' } });
    if (r.status === 200) note('MEDIUM', `text/plain body {"program":"not-hex"} on /v1/mandate/decode was silently ignored: 200 with source=${r.json?.source} (the caller asked about bytes they sent, got the live position)`);
    else expectClientError(r, 'text/plain body');

    r = await api.call('POST', '/v1/mandate/decode', { data: '{"program": "0x', headers: { 'content-type': 'application/json' } });
    expectClientError(r, 'malformed JSON', [400]);

    r = await api.call('POST', '/v1/mandate/decode', { data: '[1,2,3]', headers: { 'content-type': 'application/json' } });
    if (r.status === 200) note('MEDIUM', `JSON array body on /v1/mandate/decode accepted: 200 source=${r.json?.source}`);
    else expectClientError(r, 'JSON array body');

    r = await api.call('POST', '/v1/mandate/decode', { data: '"0x00"', headers: { 'content-type': 'application/json' } });
    if (r.status === 200) note('LOW', `JSON string body on /v1/mandate/decode accepted: 200 source=${r.json?.source}`);

    const twoMB = JSON.stringify({ program: '0x' + '00'.repeat(1_000_000) });
    r = await api.call('POST', '/v1/mandate/decode', { data: twoMB, headers: { 'content-type': 'application/json' } });
    expectClientError(r, '2 MB body', [413]);
    if (r.status === 413) note('LOW', `413 is answered for a >256kb body but /openapi.json documents only 400/429/502 on free routes: ${short(r.text)}`);
});

test('2. program edge values', async ({ api }) => {
    const cases = [
        ['program as number', { program: 123 }, [400]],
        ['program uppercase hex', { program: LIVE_PROGRAM.toUpperCase().replace(/^0X/, '0x') }, [200]],
        ['program 0X prefix', { program: '0X' + LIVE_PROGRAM.slice(2) }, [400]],
        ['program with whitespace', { program: ' ' + LIVE_PROGRAM + ' ' }, [400]],
        ['program of 1 byte', { program: '0x00' }, [400, 422]],
        ['program of 10,000 bytes', { program: '0x' + '00'.repeat(10_000) }, [400, 422]],
        ['program odd nibbles', { program: '0x212' }, [400, 422]],
        ['program null', { program: null }, [200, 502]],
        ['program true', { program: true }, [400]],
        ['program object', { program: { a: 1 } }, [400]],
    ];
    for (const [label, data, expected] of cases) {
        const r = await api.call('POST', '/v1/mandate/decode', { data });
        const ok = expected.includes(r.status) && (r.status === 200 || isJsonError(r));
        expect.soft(ok, `${label}: expected ${expected}, got ${r.status} ${short(r.text)}`).toBe(true);
        if (!ok) note(r.status >= 500 ? 'HIGH' : 'MEDIUM', `decode ${label} -> ${r.status} ${short(r.text)} (expected ${expected})`);
        if (r.status === 502 && r.json?.upstream) note('HIGH', `decode ${label}: caller's bytes reported as upstream:true 502 -> ${short(r.text)}`);
    }
});

test('2. label and agentId edge values', async ({ api }) => {
    const labels = [
        ['unicode label', 'ägent🙂', [200, 502]],
        ['300-char label', 'a'.repeat(300), [200, 502]],
        ['empty label', '', [200, 502]],
    ];
    for (const [label, value, expected] of labels) {
        const r = await api.call('GET', `/v1/agent/authority?label=${encodeURIComponent(value)}`);
        const ok = expected.includes(r.status) && r.json && (r.status === 200 ? typeof r.json.valid === 'boolean' : typeof r.json.error === 'string');
        expect.soft(ok, `${label}: got ${r.status} ${short(r.text)}`).toBe(true);
        if (!ok) note('MEDIUM', `authority ${label} -> ${r.status} ${short(r.text)}`);
        if (r.status === 200 && value === '' && r.json.label !== 'agent') note('LOW', `empty label answered label=${r.json.label}`);
        if (r.status === 200 && value === 'a'.repeat(300) && r.json.valid === true) note('HIGH', `a 300-char label reports valid:true`);
    }
    const r2 = await api.call('GET', '/v1/agent/authority?grantedUntil=abc');
    expect.soft([200, 400], `grantedUntil=abc: ${r2.status} ${short(r2.text)}`).toContain(r2.status);
    if (r2.status === 200) note('LOW', `grantedUntil=abc accepted (NaN) -> 200 reason="${r2.json?.reason}" revoked=${r2.json?.revoked}`);

    const ids = [
        ['negative agentId', '-1'], ['huge agentId', '9'.repeat(80)], ['non-numeric agentId', 'abc'],
        ['float agentId', '1.5'], ['agentId 0x hex', '0x10'], ['agentId array', '1&agentId=2'],
    ];
    for (const [label, value] of ids) {
        const r = await api.call('GET', `/v1/agent/reputation?agentId=${value}`);
        if (r.status === 200) {
            note('MEDIUM', `reputation ${label} (${value}) -> 200 ${short(r.text)}`);
        } else {
            const ok = [400, 502].includes(r.status) && isJsonError(r);
            expect.soft(ok, `${label}: ${r.status} ${short(r.text)}`).toBe(true);
            if (!ok) note('HIGH', `reputation ${label} -> ${r.status} ${short(r.text)}`);
            else if (r.status === 502) note('MEDIUM', `reputation ${label} -> 502 upstream:${r.json.upstream} for a caller mistake: ${short(r.text)}`);
        }
    }
});

// --- 3. headers -----------------------------------------------------------------------------------------

test('3. CORS, cache, security headers, framing', async ({ api }) => {
    const o = { headers: { origin: 'https://example.com' } };
    const pre = await api.call('OPTIONS', '/v1/mandate/decode', { headers: { origin: 'https://example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    const acao = pre.headers['access-control-allow-origin'];
    note(acao ? 'INFO' : 'MEDIUM', `CORS preflight OPTIONS /v1/mandate/decode -> ${pre.status}, Access-Control-Allow-Origin=${acao ?? 'absent'}, Allow=${pre.headers.allow ?? 'absent'}, body=${short(pre.text, 80)}`);
    const get = await api.call('GET', '/openapi.json', o);
    if (!get.headers['access-control-allow-origin']) note('MEDIUM', `GET /openapi.json with Origin: no Access-Control-Allow-Origin — a browser-based agent/UI on another origin cannot read the free routes`);

    for (const path of ['/openapi.json', '/.well-known/x402', '/.well-known/agent-card.json', '/']) {
        const r = await api.call('GET', path, { headers: { accept: 'application/json' } });
        const h = r.headers;
        const line = `${path}: cache-control=${h['cache-control'] ?? 'absent'} etag=${h.etag ? 'yes' : 'no'} vary=${h.vary ?? 'absent'} x-content-type-options=${h['x-content-type-options'] ?? 'absent'} content-length=${h['content-length'] ?? 'chunked/absent'} transfer-encoding=${h['transfer-encoding'] ?? '-'}`;
        note('INFO', line);
        expect.soft(h['x-content-type-options'], `${path} nosniff`).toBe('nosniff');
        if (path === '/' && !/accept/i.test(h.vary ?? '')) note('MEDIUM', `GET / does not Vary: Accept, and it serves HTML or JSON on Accept`);
        if (!h['cache-control']) note('LOW', `${path} is a constant document with no Cache-Control`);
    }
    // GET / with a browser Accept must be HTML; with */* JSON
    const html = await api.call('GET', '/', { headers: { accept: 'text/html,application/xhtml+xml' } });
    expect.soft(html.headers['content-type'], 'browser gets HTML at /').toMatch(/text\/html/);
    const any = await api.call('GET', '/', { headers: { accept: '*/*' } });
    expect.soft(any.headers['content-type'], '*/* gets JSON at /').toMatch(/application\/json/);
    const p = await api.call('POST', '/v1/mandate/decode', { data: { program: LIVE_PROGRAM } });
    note('INFO', `POST decode: content-length=${p.headers['content-length'] ?? 'absent'} transfer-encoding=${p.headers['transfer-encoding'] ?? '-'} etag=${p.headers.etag ?? '-'}`);
});

// --- 4. rate limiter (local only) ------------------------------------------------------------------

test('4. free brake: where 429 begins, what shares it, whether it recovers', async ({ api }) => {
    test.skip(api.isProd, 'not hammering production');
    test.setTimeout(200_000);
    let first429 = null;
    let r;
    for (let i = 1; i <= 70; i++) {
        r = await api.call('POST', '/v1/mandate/decode', { data: { program: LIVE_PROGRAM } });
        if (r.status === 429 && first429 === null) {
            first429 = i;
            expect.soft(r.headers['retry-after'], '429 carries Retry-After').toBeTruthy();
            expect.soft(r.json?.retryAfterSeconds, '429 body retryAfterSeconds').toEqual(expect.any(Number));
            note('INFO', `429 began at request #${i}; Retry-After=${r.headers['retry-after']} body=${short(r.text)}`);
        }
    }
    expect.soft(first429, '429 should begin at #61 with the default limit of 60').toBe(61);
    if (first429 === null) note('HIGH', 'no 429 after 70 quick free requests');
    const mcp = await api.call('POST', '/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' } });
    note('INFO', `/mcp while limited -> ${mcp.status} (shares the bucket: ${mcp.status === 429})`);
    const oa = await api.call('GET', '/openapi.json');
    note('INFO', `/openapi.json while limited -> ${oa.status} (counts: ${oa.status === 429})`);
    const auth = await api.call('GET', '/v1/agent/authority');
    note('INFO', `/v1/agent/authority while limited -> ${auth.status} (one bucket across free routes: ${auth.status === 429})`);
    const paid = await api.call('POST', '/v1/mandate/explain', { data: { program: LIVE_PROGRAM } });
    note('INFO', `/v1/mandate/explain while limited -> ${paid.status} (paid route outside the brake: ${paid.status === 402})`);

    // Second client, same second: separate bucket?
    const other = await api.ctx.fetch('/v1/mandate/decode', { method: 'POST', data: { program: LIVE_PROGRAM }, headers: { 'x-forwarded-for': '10.99.99.99' } });
    note('INFO', `another forwarded address while limited -> ${other.status()} (per-caller: ${other.status() === 200})`);

    await new Promise((f) => setTimeout(f, 61_000));
    const after = await api.call('POST', '/v1/mandate/decode', { data: { program: LIVE_PROGRAM } });
    expect.soft(after.status, 'recovers after the window').toBe(200);
    note('INFO', `61s later -> ${after.status}`);
});

// --- 5. the 402 flow without paying -------------------------------------------------------------------

test('5. 402 matches the discovery manifest; garbage signature is not a 500', async ({ api }) => {
    const manifest = (await api.call('GET', '/.well-known/x402')).json;
    const r = await api.call('POST', '/v1/mandate/explain', { data: { program: LIVE_PROGRAM } });
    expect.soft(r.status).toBe(402);
    const hdr = r.headers['payment-required'];
    expect.soft(hdr, 'PAYMENT-REQUIRED').toBeTruthy();
    const fromHeader = hdr ? JSON.parse(Buffer.from(hdr, 'base64').toString('utf8')) : null;
    note('INFO', `402 body=${short(r.text, 400)}`);
    note('INFO', `402 header=${short(JSON.stringify(fromHeader), 400)}`);
    expect.soft(r.json?.x402Version, '402 body carries x402Version').toBe(2);
    if (JSON.stringify(r.json) !== JSON.stringify(fromHeader)) note('LOW', `402 body and PAYMENT-REQUIRED header differ: body keys ${Object.keys(r.json ?? {})} vs header keys ${Object.keys(fromHeader ?? {})}`);
    const req = fromHeader ?? r.json;
    const acc = req?.accepts?.[0];
    const man = manifest?.resources?.[0];
    const manAcc = man?.accepts?.[0];
    expect.soft(acc?.amount, 'amount').toBe(manAcc?.amount);
    expect.soft(acc?.asset, 'asset').toBe(manAcc?.asset);
    expect.soft(acc?.network, 'network').toBe(manAcc?.network);
    expect.soft(acc?.payTo, 'payTo').toBe(manAcc?.payTo);
    expect.soft(acc?.scheme, 'scheme').toBe(manAcc?.scheme);
    const resource = req?.resource?.url ?? acc?.resource ?? req?.accepts?.[0]?.resource;
    note('INFO', `402 resource=${JSON.stringify(req?.resource ?? acc?.resource)} manifest url=${man?.url}`);
    expect.soft(resource, 'resource url is https').toMatch(/^https:\/\//);
    expect.soft(resource, 'resource url equals manifest').toBe(man?.url);
    if (acc?.maxTimeoutSeconds) note('INFO', `maxTimeoutSeconds=${acc.maxTimeoutSeconds}`);

    for (const [label, sig] of [['garbage', 'not-base64-!!'], ['base64 junk', Buffer.from('{"x402Version":2,"junk":true}').toString('base64')], ['huge', 'A'.repeat(20_000)]]) {
        const g = await api.call('POST', '/v1/mandate/explain', { data: { program: LIVE_PROGRAM }, headers: { 'payment-signature': sig, 'content-type': 'application/json' } });
        note(g.status >= 500 ? 'HIGH' : 'INFO', `PAYMENT-SIGNATURE ${label} -> ${g.status} ${short(g.headers['content-type'], 30)} ${short(g.text, 300)}`);
        expect.soft(g.status, `garbage signature (${label}) must not be 5xx`).toBeLessThan(500);
        expect.soft(g.headers['content-type'] ?? '', `garbage signature (${label}) answer is JSON`).toMatch(/application\/json/);
    }
    // legacy header name
    const x = await api.call('POST', '/v1/mandate/explain', { data: { program: LIVE_PROGRAM }, headers: { 'x-payment': 'garbage', 'content-type': 'application/json' } });
    note(x.status >= 500 ? 'HIGH' : 'INFO', `X-PAYMENT garbage -> ${x.status} ${short(x.text, 200)}`);
});

// --- 6. /mcp as a client ---------------------------------------------------------------------------------

test('6. MCP over HTTP is JSON-RPC-shaped in every case', async ({ api }) => {
    const H = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    const shaped = (r, label) => {
        const ok = r.json && r.json.jsonrpc === '2.0' && ('result' in r.json || 'error' in r.json);
        expect.soft(ok, `${label}: not JSON-RPC shaped: ${r.status} ${short(r.headers['content-type'], 40)} ${short(r.text, 300)}`).toBe(true);
        if (!ok) note('MEDIUM', `/mcp ${label} -> ${r.status} ${short(r.headers['content-type'], 40)} ${short(r.text, 200)}`);
        return ok;
    };
    let r = await api.call('POST', '/mcp', { data: rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'qa', version: '0' } }), headers: H });
    shaped(r, 'initialize');
    note('INFO', `mcp initialize -> ${r.status} ${short(r.text, 250)} session=${r.headers['mcp-session-id'] ?? 'none'}`);

    r = await api.call('POST', '/mcp', { data: rpc('tools/list'), headers: H });
    shaped(r, 'tools/list');
    const tools = r.json?.result?.tools?.map((t) => t.name) ?? [];
    note('INFO', `mcp tools/list -> ${r.status} tools=${tools.join(',')} ${r.json?.error ? short(JSON.stringify(r.json.error)) : ''}`);

    r = await api.call('POST', '/mcp', { data: rpc('tools/call', { name: 'read_mandate', arguments: { program: LIVE_PROGRAM } }), headers: H });
    shaped(r, 'tools/call read_mandate with program');
    expect.soft(r.json?.result?.structuredContent?.mandate ?? r.json?.error, 'read_mandate answered').toBeTruthy();
    note('INFO', `mcp read_mandate(program) -> ${r.status} isError=${r.json?.result?.isError} keys=${Object.keys(r.json?.result?.structuredContent ?? {})} ${r.json?.error ? short(JSON.stringify(r.json.error)) : ''}`);

    r = await api.call('POST', '/mcp', { data: rpc('tools/call', { name: 'read_mandate', arguments: {} }), headers: H });
    shaped(r, 'tools/call read_mandate without program');
    note('INFO', `mcp read_mandate() -> ${r.status} isError=${r.json?.result?.isError} source=${r.json?.result?.structuredContent?.source} ${r.json?.result?.isError ? short(r.json.result.content?.[0]?.text) : ''}`);

    r = await api.call('POST', '/mcp', { data: rpc('tools/call', { name: 'read_mandate', arguments: { program: 'zzz' } }), headers: H });
    shaped(r, 'tools/call read_mandate bad program');
    note('INFO', `mcp read_mandate(zzz) -> ${r.status} isError=${r.json?.result?.isError} ${short(r.json?.result?.content?.[0]?.text ?? JSON.stringify(r.json?.error))}`);

    r = await api.call('POST', '/mcp', { data: rpc('tools/call', { name: 'no_such_tool', arguments: {} }), headers: H });
    shaped(r, 'tools/call unknown tool');
    note('INFO', `mcp unknown tool -> ${r.status} ${short(r.text, 200)}`);

    r = await api.call('POST', '/mcp', { data: '{"jsonrpc":"2.0","id":', headers: H });
    shaped(r, 'malformed JSON');
    note(r.json?.jsonrpc ? 'INFO' : 'MEDIUM', `mcp malformed JSON -> ${r.status} ${short(r.text, 200)}`);

    r = await api.call('POST', '/mcp', { data: { hello: 'world' }, headers: H });
    shaped(r, 'not a JSON-RPC message');
    note('INFO', `mcp {hello} -> ${r.status} ${short(r.text, 200)}`);

    r = await api.call('POST', '/mcp', { data: rpc('tools/list'), headers: { 'content-type': 'application/json' } });
    shaped(r, 'missing Accept');
    note('INFO', `mcp missing Accept -> ${r.status} ${short(r.text, 200)}`);

    r = await api.call('POST', '/mcp', { data: rpc('tools/list'), headers: { 'content-type': 'application/json', accept: 'application/json' } });
    note('INFO', `mcp Accept: application/json only -> ${r.status} ${short(r.text, 160)}`);

    r = await api.call('GET', '/mcp', { headers: H });
    note('INFO', `GET /mcp -> ${r.status} ${short(r.text, 120)}`);

    r = await api.call('POST', '/mcp', { data: [rpc('tools/list', undefined, 1), rpc('ping', undefined, 2)], headers: H });
    note('INFO', `mcp batch -> ${r.status} ${short(r.text, 200)}`);
});

// --- 7. idempotency and consistency ----------------------------------------------------------------------

test('7. decode is deterministic; authority agrees with health; publication agrees with the mirror', async ({ api }) => {
    const bodies = [];
    for (let i = 0; i < 3; i++) bodies.push((await api.call('POST', '/v1/mandate/decode', { data: { program: LIVE_PROGRAM } })).text);
    expect.soft(new Set(bodies).size, 'three decodes identical').toBe(1);
    if (new Set(bodies).size !== 1) note('MEDIUM', `decode not byte-identical across 3 calls`);

    const a = await api.call('GET', '/v1/agent/authority');
    const h = await api.call('GET', '/v1/position/health');
    if (a.status === 200 && h.status === 200) {
        const ha = h.json.authority ?? {};
        const same = a.json.valid === ha.valid && a.json.revoked === ha.revoked && a.json.expiry === ha.expiry && a.json.label === ha.label;
        expect.soft(same, `authority vs health.authority: ${short(a.text, 200)} vs ${short(JSON.stringify(ha), 200)}`).toBe(true);
        if (!same) note('MEDIUM', `/v1/agent/authority and /v1/position/health.authority disagree: ${short(a.text, 200)} vs ${short(JSON.stringify(ha), 200)}`);
        note('INFO', `health status=${h.json.status} alerts=${JSON.stringify(h.json.alerts).slice(0, 200)} authority.valid=${a.json.valid} reason=${a.json.reason}`);
    } else {
        note('MEDIUM', `authority ${a.status} ${short(a.text)} / health ${h.status} ${short(h.text)}`);
    }

    const p = await api.call('POST', '/v1/mandate/publication', { data: { program: LIVE_PROGRAM } });
    note('INFO', `publication -> ${p.status} ${short(p.text, 300)}`);
    if (p.status === 200 && p.json.published === true) {
        expect.soft(p.json.mirror, 'mirror URL is https').toMatch(/^https:\/\//);
        const m = await api.ctx.fetch(p.json.mirror);
        const mj = await m.json();
        expect.soft(mj.sequence_number, 'mirror sequence number').toBe(p.json.sequenceNumber);
        expect.soft(mj.consensus_timestamp, 'mirror consensus timestamp').toBe(p.json.consensusTimestamp);
        expect.soft(mj.payer_account_id, 'mirror payer').toBe(p.json.payer);
        const rec = JSON.parse(Buffer.from(mj.message, 'base64').toString('utf8'));
        expect.soft(rec.program, 'mirror program bytes').toBe(LIVE_PROGRAM.toLowerCase());
        if (mj.sequence_number !== p.json.sequenceNumber) note('HIGH', `publication sequence ${p.json.sequenceNumber} but mirror says ${mj.sequence_number}`);
    } else if (p.status === 200) {
        note('MEDIUM', `live program not published according to the service: ${short(p.text, 300)}`);
    }
});

test.afterAll(async () => {
    const env = timings[0]?.env ?? '?';
    const byRoute = new Map();
    for (const t of timings) {
        const k = `${t.method} ${t.url}`;
        const e = byRoute.get(k) ?? { cold: null, warm: [], statuses: new Set() };
        if (e.cold === null) e.cold = t.ms; else e.warm.push(t.ms);
        e.statuses.add(t.status);
        byRoute.set(k, e);
    }
    const rows = [...byRoute].map(([k, e]) => `${k.padEnd(36)} cold ${String(e.cold).padStart(6)}ms  warm(median of ${e.warm.length}) ${e.warm.length ? String(e.warm.sort((a, b) => a - b)[Math.floor(e.warm.length / 2)]).padStart(6) : '     -'}ms  statuses ${[...e.statuses].join(',')}`);
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
    const fl = findings.sort((a, b) => order[a.sev] - order[b.sev]).map((f) => `[${f.sev}] ${f.what}`);
    const report = `\n===== ${env} TIMINGS =====\n${rows.join('\n')}\n\n===== ${env} FINDINGS =====\n${fl.join('\n')}\n`;
    console.log(report);
    // The report is already on stdout; the file is a convenience for whoever wants to diff two
    // runs. Opt in with BATAS_QA_OUT rather than writing to somebody's machine by default — this
    // line used to carry an absolute path into a temp directory that no longer exists.
    if (process.env.BATAS_QA_OUT) {
        const { appendFileSync, mkdirSync } = await import('node:fs');
        mkdirSync(process.env.BATAS_QA_OUT, { recursive: true });
        appendFileSync(`${process.env.BATAS_QA_OUT}/report-${env}.txt`, report);
    }
});
