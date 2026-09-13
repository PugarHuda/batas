// The four capabilities a visitor could not see from either page: the ENS identity, how the paid
// answer is priced and paid, how another agent reaches this one, and the ledger of payments made.
//
// Both pages carry these panels, so the rendering lives once, here, and is injected into each page
// by `.toString()` exactly as ui-render.mjs is: standalone declarations, no imports, no module
// scope. The one name they borrow is `esc`, which both pages already define, so a second escape
// function never ships. What node tests is what the browser runs.
//
// Every figure is read as the page loads: the name and the ENSIP-25 link from this service, the
// price from the x402 manifest this service publishes to indexers, the agent card from where A2A
// clients read it, and the directory entry, the token's fee schedule and the payment records from
// the public Hedera mirror node, directly, so the page is not the only witness to its own ledger.

/** Where the Hashgraph Online listing landed: registry topic and sequence, written by agent/hol.mjs. */
export const HOL_LISTING = { topic: '0.0.6913983', sequence: 384, account: '0.0.10388401' };
export const HTS_TOKEN_ID = '0.0.10523367';

export function readJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
        if (json == null) throw new Error('the answer was not JSON');
        return json;
    });
}

/** Tinybars as HBAR, every digit kept and no exponent: 94000 is 0.00094, not 9.4e-4. */
export function hbar(tinybars) {
    return (Number(tinybars) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

/** A token amount in its smallest unit, at the token's own decimals. */
export function units(amount, decimals) {
    const d = Number(decimals) || 0;
    return (Number(amount) / 10 ** d).toFixed(d);
}

/** A mirror-node consensus timestamp ("seconds.nanos") as an ISO minute in UTC. */
export function consensusISO(ts) {
    const s = Number(String(ts).split('.')[0]);
    return Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
}

/** An HCS message body, which is base64 of UTF-8 JSON; anything else is null rather than a throw. */
export function b64json(b64) {
    try {
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0))));
    } catch {
        return null;
    }
}

/** Only an https destination becomes a link, and every label is escaped. */
export function out(href, label) {
    return /^https:\/\//.test(String(href)) ? '<a href="' + esc(href) + '" rel="noopener">' + esc(label) + '</a>' : esc(label);
}

export function register(rows) {
    return '<dl class="reg">' + rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('') + '</dl>';
}

/** GET /v1/agent/name: the name, where it resolves, its text records, and whether ENSIP-25 holds both ways. */
export function renderName(n) {
    const hex = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a));
    const scan = (a) => (hex(a) ? out('https://sepolia.etherscan.io/address/' + a, a) : '<span class="state never">none</span>');
    const e = (n && n.erc8004) || {};
    const [, chain, registry] = String(e.registry || '').split(':');
    const nft = chain === '11155111' && hex(registry) && /^\d+$/.test(String(e.agentId))
        ? out('https://sepolia.etherscan.io/nft/' + registry + '/' + e.agentId, 'ERC-8004 #' + e.agentId)
        : 'ERC-8004 #' + esc(e.agentId ?? '?');
    const link = e.linked
        ? '<span class="state inside">holds both ways</span>'
        : '<span class="state never">does not hold' + (e.forward ? '' : ' · no record on the name') + (e.reverse ? '' : ' · the registration does not name it') + '</span>';
    const records = Object.entries((n && n.text) || {}).map(([k, v]) => {
        const first = String(v).split('\n')[0];
        const value = /^https:\/\//.test(first) ? out(first, first) : esc(first) + (String(v).includes('\n') ? ' …' : '');
        return '<li><code>' + esc(k) + '</code> ' + value + '</li>';
    }).join('');
    return register([
        ['name', '<b>' + esc(n && n.name) + '</b>'],
        ['address', scan(n && n.address)],
        ['resolver', scan(n && n.resolver)],
        ['ENSIP-25', link + '<br>' + nft],
    ]) + '<ul class="records" aria-label="text records">' + (records || '<li class="muted">no text records</li>') + '</ul>';
}

/** "0.00094 – 0.0037 HBAR", from the manifest's own bounds. */
export function meteredRange(manifest) {
    const m = ((manifest && manifest.resources) || [])[0];
    if (!m || !m.metered) throw new Error('the manifest names no metered resource');
    return hbar(m.metered.min) + ' – ' + hbar(m.metered.max) + ' HBAR';
}

/** The x402 manifest and the token the second asset is: the range, what builds the bill, and both assets. */
export function renderPrice(manifest, token) {
    const r = ((manifest && manifest.resources) || [])[0];
    const range = meteredRange(manifest);
    const rates = r.metered.rates || {};
    const named = { decode: 'decode', perInstruction: 'per instruction', publication: 'publication lookup', authority: 'authority check', operator: 'operator identity' };
    const parts = Object.entries(rates).filter(([k]) => k !== 'instructionCap').map(([k, v]) =>
        '<li><span>' + esc(named[k] || k) + (k === 'perInstruction' && rates.instructionCap ? ', at most ' + esc(rates.instructionCap) : '') + '</span>'
        + '<span class="fig">' + esc(hbar(v)) + ' HBAR</span></li>').join('');
    const ok = token && !token.error;
    const assets = (r.accepts || []).map((a) => {
        if (a.asset === '0.0.0') return '<li><b>HBAR</b> <span class="fig">at most ' + esc(hbar(a.amount)) + '</span> <span class="muted">on ' + esc(a.network) + '</span></li>';
        const mine = ok && token.token_id === a.asset;
        const fees = mine ? ((token.custom_fees && token.custom_fees.fixed_fees) || []).map((f) =>
            'custom fee <span class="fig">' + esc(units(f.amount, token.decimals)) + ' ' + esc(token.symbol) + '</span> to ' + esc(f.collector_account_id) + ' on every transfer, assessed by the network').join('; ') : '';
        return '<li><b>' + (mine ? esc(token.symbol) : 'token') + '</b> ' + out('https://hashscan.io/testnet/token/' + a.asset, a.asset)
            + ' <span class="fig">' + (mine ? esc(units(a.amount, token.decimals)) + ' ' + esc(token.symbol) : esc(a.amount) + ' units') + '</span>'
            + '<br><span class="muted">' + (mine ? (fees || 'no custom fee on the schedule') : 'fee schedule could not be read: ' + esc(token && token.error)) + '</span></li>';
    }).join('');
    return register([
        ['per call', '<b class="fig">' + esc(range) + '</b> <span class="muted">metered by the work the body asks for</span>'],
        ['pay to', out('https://hashscan.io/testnet/account/' + ((r.accepts || [])[0] || {}).payTo, ((r.accepts || [])[0] || {}).payTo)],
    ]) + '<ul class="rates" aria-label="what builds the bill">' + parts + '</ul>'
        + '<ul class="assets" aria-label="accepted assets">' + assets + '</ul>';
}

/** The A2A agent card and the Hashgraph Online registry message that lists this agent. */
export function renderReach(card, message, listing) {
    const exts = (card && card.capabilities && card.capabilities.extensions) || [];
    const x = exts.find((e) => /a2a-x402/.test(String(e.uri)));
    const m = b64json(message && message.message) || {};
    const listed = m.p === 'hcs-10' && m.op === 'register' && m.account_id === listing.account && Number(message.sequence_number) === listing.sequence;
    const mirror = 'https://testnet.mirrornode.hedera.com/api/v1/topics/' + listing.topic + '/messages/' + listing.sequence;
    return register([
        // URLs in the text face, not the mono: B612 Mono sets a colon and a full stop in a digit-wide
        // cell, and "https: //batas-one. vercel. app" reads as a broken address.
        ['A2A', '<b>' + esc(card && card.url) + '</b> <span class="muted">JSON-RPC, protocol ' + esc(card && card.protocolVersion) + '</span>'],
        ['extension', x
            ? '<span class="state inside">a2a-x402' + (x.required ? ', required' : '') + '</span> ' + out(x.uri, x.uri)
            : '<span class="state never">the card carries no a2a-x402 extension</span>'],
        ['skills', '<span class="fig">' + esc(((card && card.skills) || []).length) + '</span> · <a href="/.well-known/agent-card.json">agent card</a>'],
        ['directory', (listed ? '<span class="state inside">listed</span>' : '<span class="state never">not the expected registration</span>')
            + ' Hashgraph Online HCS-10, topic ' + esc(listing.topic) + ' <span class="fig">#' + esc(message && message.sequence_number) + '</span>'],
        ['registered', '<span class="fig">' + esc(consensusISO(message && message.consensus_timestamp)) + '</span> by ' + esc(m.account_id ?? '?')],
        ['verify', out(mirror, 'mirror node') + ' · ' + out('https://hashscan.io/testnet/topic/' + listing.topic, 'HashScan')],
    ]);
}

/** The batas.payment records among a topic's messages, newest first as the mirror returned them. */
export function paymentRecords(messages) {
    return (messages || []).map((m) => {
        const p = b64json(m.message);
        return p && p.kind === 'batas.payment' ? Object.assign({}, p, { seq: m.sequence_number, at: m.consensus_timestamp }) : null;
    }).filter(Boolean);
}

export function renderTrail(records, topic, token) {
    const head = '<p class="trail-head"><span class="fig">' + esc(records.length) + '</span> payment record' + (records.length === 1 ? '' : 's')
        + ' on topic ' + out('https://hashscan.io/testnet/topic/' + topic, topic) + ', read from the public mirror node</p>';
    if (!records.length) return head + '<p class="muted">No payment has been recorded on the topic yet.</p>';
    return head + '<ol class="trail">' + records.slice(0, 5).map((p) => {
        const tx = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(String(p.transaction));
        const amount = p.asset === '0.0.0' ? hbar(p.amount) + ' HBAR'
            : token && token.token_id === p.asset ? units(p.amount, token.decimals) + ' ' + token.symbol : p.amount + ' units of ' + p.asset;
        return '<li><span class="t">' + esc(consensusISO(p.at)) + '</span>'
            + '<span class="fig amt">' + esc(amount) + '</span>'
            + '<span>' + esc(p.payer) + ' paid ' + esc(p.payTo)
            + '<br>' + (tx ? out('https://testnet.mirrornode.hedera.com/api/v1/transactions/' + tx[1] + '-' + tx[2] + '-' + tx[3], 'payment ' + p.transaction) : esc(p.transaction))
            + ' · ' + out('https://hashscan.io/testnet/transaction/' + p.at, 'record #' + p.seq) + '</span></li>';
    }).join('') + '</ol>';
}

/**
 * One panel: a caution mark while it reads, the answer, or what failed and a way to ask again.
 * `aria-busy` is set only while a read is in flight, so a finished panel is never announced as loading.
 */
export function panel(id, what, load, again, onFail) {
    const el = document.getElementById(id);
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = '<span class="state caution">reading ' + esc(what) + '</span>';
    return load().then((html) => { el.innerHTML = html; }, (e) => {
        el.innerHTML = '<p class="state never">could not read ' + esc(what) + ': ' + esc(e && e.message) + '</p>'
            + '<button type="button" class="' + esc(again) + '">try again</button>';
        el.querySelector('button').addEventListener('click', () => panel(id, what, load, again, onFail));
        if (onFail) onFail(e);
    }).finally(() => el.removeAttribute('aria-busy'));
}

/** Reads all four panels at once. `o` is { topic, token, listing, again }. */
export function loadSurface(o) {
    const mirror = 'https://testnet.mirrornode.hedera.com/api/v1';
    // The fee schedule feeds two panels; read once, and a failure is carried as a value so the price
    // still shows when only the token lookup failed.
    const token = readJson(mirror + '/tokens/' + o.token).catch((e) => ({ error: e.message }));
    const ranges = (text) => document.querySelectorAll('[data-x402-range]').forEach((el) => { el.textContent = text; });
    panel('sName', 'the ENS name', () => readJson('/v1/agent/name').then(renderName), o.again);
    panel('sPrice', 'the x402 manifest', async () => {
        const m = await readJson('/.well-known/x402');
        ranges(meteredRange(m));
        return renderPrice(m, await token);
    }, o.again, () => ranges('metered; the manifest could not be read'));
    panel('sReach', 'the agent card and the directory', async () => {
        const [card, msg] = await Promise.all([
            readJson('/.well-known/agent-card.json'),
            readJson(mirror + '/topics/' + o.listing.topic + '/messages/' + o.listing.sequence),
        ]);
        return renderReach(card, msg, o.listing);
    }, o.again);
    // ponytail: the newest hundred messages cover the topic today (17); follow links.next when it outgrows that.
    panel('sTrail', 'the payment trail', async () => {
        const page = await readJson(mirror + '/topics/' + o.topic + '/messages?order=desc&limit=100');
        return renderTrail(paymentRecords(page.messages), o.topic, await token);
    }, o.again);
}

export const surfaceSource = () => [readJson, hbar, units, consensusISO, b64json, out, register, renderName, meteredRange,
    renderPrice, renderReach, paymentRecords, renderTrail, panel, loadSurface].map((f) => f.toString()).join('\n\n');
