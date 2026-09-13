// Request-level hostile probe. Run: BASE=... node qa/hostile-req.mjs
import { salt } from '../agent/swapvm.mjs';
const BASE = process.env.BASE || 'http://127.0.0.1:4021';
const out = [];
const rec = (name, detail) => { out.push({ name, detail }); console.log(`• ${name}\n    ${detail}`); };

async function req(path, { method = 'GET', headers = {}, body } = {}) {
    const t0 = Date.now();
    const r = await fetch(BASE + path, { method, headers, body });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - t0, headers: Object.fromEntries(r.headers), text };
}

// 1. Prototype pollution
{
    const r = await req('/v1/mandate/decode', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"y"}},"program":"0x21210000"}' });
    rec('proto pollution', `status=${r.status} Object.prototype.polluted=${({}).polluted} .polluted2=${({}).polluted2}`);
}

// 2. 10k-instruction decode timing (all read, first 256 listed)
{
    const prog = '0x' + salt(1n).slice(2).repeat(10000);
    const body = JSON.stringify({ program: prog });
    const r = await req('/v1/mandate/decode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    let j = {}; try { j = JSON.parse(r.text); } catch {}
    rec('10k-instruction decode', `bodyKB=${(body.length / 1024) | 0} status=${r.status} time=${r.ms}ms count=${j.instructionCount} listed=${j.instructions?.length}`);
}

// 3. Oversized body (>256kb)
{
    const body = JSON.stringify({ program: '0x' + 'ab'.repeat(500_000) });
    const r = await req('/v1/mandate/decode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    rec('1MB body', `bodyKB=${(body.length / 1024) | 0} status=${r.status} time=${r.ms}ms body=${r.text.slice(0, 120)}`);
}

// 4. Path traversal / secret files
for (const p of ['/docs/../agent/service.mjs', '/.env', '/.env.example', '/api/', '/agent/service.mjs',
    '/verification/', '/package.json', '/.git/HEAD', '/../package.json', '/%2e%2e/package.json']) {
    const r = await req(p);
    const ct = r.headers['content-type'] || '';
    rec(`GET ${p}`, `status=${r.status} ct=${ct} body=${r.text.slice(0, 80).replace(/\n/g, ' ')}`);
}

// 5. Header injection via label / CRLF in query
{
    const r = await req('/v1/agent/authority?label=' + encodeURIComponent('x"><b>\r\nX-Injected: 1'));
    rec('CRLF/label header injection', `status=${r.status} X-Injected header present=${'x-injected' in r.headers} labelInBody=${r.text.slice(0, 120)}`);
}

// 6. Host header spoof — does it change resource: in 402 or links on /
{
    const r = await req('/v1/mandate/explain', { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example.com' }, body: '{}' });
    rec('402 resource under spoofed Host', `status=${r.status} body=${r.text.slice(0, 300)}`);
    const h = await req('/', { headers: { Host: 'evil.example.com', Accept: 'text/html' } });
    rec('/ links under spoofed Host', `evilInBody=${h.text.includes('evil.example.com')} hasVercelOrigin=${h.text.includes('batas-one.vercel.app')}`);
}

// 7. HTTP method override headers
{
    const r = await req('/v1/mandate/explain', { method: 'GET', headers: { 'X-HTTP-Method-Override': 'POST', 'X-Method-Override': 'POST' } });
    rec('method override on paid route (GET)', `status=${r.status} body=${r.text.slice(0, 100)}`);
}

// 8. Info leak surfaces
{
    const r = await req('/');
    rec('headers on /', `x-powered-by=${r.headers['x-powered-by'] ?? '(absent)'} server=${r.headers['server'] ?? '(absent)'} xcto=${r.headers['x-content-type-options']} referrer=${r.headers['referrer-policy']} xfo=${r.headers['x-frame-options'] ?? '(absent)'} csp=${r.headers['content-security-policy'] ?? '(absent)'}`);
    // trigger a 500? unknown. Try a body-parser charset error
    const c = await req('/v1/mandate/decode', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=nope' }, body: '{"program":"0x21"}' });
    rec('bad charset body', `status=${c.status} body=${c.text.slice(0, 120)}`);
    // does an upstream error leak the RPC URL / keys?
    const a = await req('/v1/agent/authority');
    rec('authority body (RPC/key leak check)', `status=${a.status} leaksRpcKey=${/alchemy|infura|apikey|key=|\bhttps?:\/\/[^\s"]+\/v[0-9]\/[A-Za-z0-9_-]{20,}/i.test(a.text)} body=${a.text.slice(0, 200)}`);
}

// 9. Cache headers on /
{
    const html = await req('/', { headers: { Accept: 'text/html' } });
    const json = await req('/', { headers: { Accept: 'application/json' } });
    rec('Vary/cache on /', `vary=${html.headers['vary']} cache-control=${html.headers['cache-control'] ?? '(absent)'} age=${html.headers['age'] ?? '(absent)'} htmlIsHtml=${html.text.startsWith('<!doctype')} jsonIsJson=${json.text.startsWith('{')}`);
}

console.log('\n--- done ---');
