// The page's rendering, in a file a test can import.
//
// These run in the browser, and they were unreachable by anything here: `ui.mjs` is one long
// template string, so the hundred lines of DOM logic inside it — including the escaping — were
// shipped to every visitor and exercised by nothing. Coverage put the file at 5%.
//
// They live here now and are injected into the page by `.toString()`, which is why they are written
// as standalone declarations: no imports, no module scope, nothing captured. What node runs in the
// test is the same source the browser runs, rather than a copy that agrees with it today.

/**
 * Escape before anything reaches `innerHTML`.
 *
 * Including the fields that are numbers today. They are derived from bytes a visitor pasted into
 * the box, and "this one happens to be formatUnits output" is a property of the current decoder
 * rather than of the boundary. The escape belongs at the boundary.
 */
export function esc(s) {
    return String(s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
}

/**
 * A link, but only to somewhere a link may point.
 *
 * A scheme is a capability, and one arriving in a response body is not the place to hand out
 * `javascript:` — even when that body is written by our own code today.
 */
export function link(href, label) {
    return String(href ?? '').startsWith('https://')
        ? `<p style="margin:.8rem 0 0"><a href="${esc(href)}" rel="noopener">${esc(label)}</a></p>`
        : '';
}

/**
 * An 18-decimal number a person can scan.
 *
 * `7.162902849964033514` is the truth and stays on the page in full; the eye needs the `7.16` and
 * the rest dimmed, not hidden. Escaped first, then split, so a field that is not a number today is
 * still inert text.
 */
export function num(s) {
    const [whole, frac] = esc(s).split('.');
    return frac == null ? whole : whole + '.<span class="frac">' + frac + '</span>';
}

/**
 * An ISO timestamp as a <time>, with the zone said out loud. Anything that is not one — a
 * consensus timestamp in seconds, a dash — stays plain escaped text.
 */
export function when(s) {
    const t = esc(s);
    return /^\d{4}-\d\d-\d\dT/.test(t) ? '<time datetime="' + t + '">' + t + ' UTC</time>' : t;
}

/** [label, html, mono] rows as the hairline facts table. Mono is for values, not prose about them. */
export function facts(rows) {
    return '<dl class="facts">' + rows.map(([k, v, mono]) =>
        '<dt>' + k + '</dt><dd' + (mono ? ' class="mono"' : '') + '>' + v + '</dd>').join('') + '</dl>';
}

/** The decoded mandate as a table of facts, its instruction listing, and any notes. */
export function renderMandate(a) {
    const m = (a && a.mandate) || {};
    const guarded = a && a.guarded
        ? '<span class="tag yes">guarded</span>'
        : '<span class="tag no">not guarded</span>';
    // Declared in here rather than beside esc: the page carries these functions by `.toString()`,
    // so anything renderMandate calls must be one of the injected functions or live inside it.
    const cap = (v, unit) => (v == null
        ? '<span class="no">no cap — one trade may take the whole reserve</span>'
        : num(v) + (unit ? ' <span class="muted">' + unit + '</span>' : ''));
    const floor = (v, unit) => (v == null
        ? '<span class="no">no floor — any rate the curve produces</span>'
        : num(v) + ' <span class="muted">' + unit + '</span>');
    // A band's top-level cap and floor are null, because a cap in A and a cap in B are not one
    // number. Rendered as they stand, they would read "no cap" on a position capped both ways, so
    // a band shows each side's terms, in that side's own tokens, instead.
    const sides = Array.isArray(m.sides) && m.sides.length ? m.sides : null;
    const terms = sides
        ? sides.flatMap((s, i) => {
            const inA = s.direction === 'aToB';
            const [tin, tout] = inA ? ['A', 'B'] : ['B', 'A'];
            const dir = ' <span class="muted">side ' + (i + 1) + ', ' + esc(s.direction) + ': ' + tin + ' in, ' + tout + ' out</span>';
            return [
                ['cap', cap(s.maxAmountInFormatted, tin) + dir, s.maxAmountInFormatted != null],
                ['floor', floor(s.minRateFormatted, tout + ' per ' + tin) + dir, s.minRateFormatted != null],
            ];
        })
        : [
            ['cap', cap(m.maxAmountInFormatted, null), m.maxAmountInFormatted != null],
            ['floor', floor(m.minRateFormatted, 'B per A'), m.minRateFormatted != null],
        ];
    const rows = [
        ['guard', guarded + ' <span class="muted">PolicyEnvelope outermost, so later instructions run inside it</span>', false],
        ...terms,
        ['fee', m.feePercent == null ? '—' : esc(m.feePercent) + '%', true],
        ['curve', m.curve == null ? '—' : esc(m.curve), false],
        ['expires', m.expiryISO == null
            ? '<span class="no">never — only revocation ends this</span>' : when(m.expiryISO), m.expiryISO != null],
        ['kill switch', m.killSwitch == null
            ? '<span class="muted">none — only the expiry, or the maker closing the position, ends this mandate</span>'
            : `"${esc(m.killSwitch.label)}" in ${esc(m.killSwitch.registry)}`, m.killSwitch != null],
    ];
    let html = facts(rows);
    const ins = (a && a.instructions) || [];
    const count = a && a.instructionCount != null ? a.instructionCount : ins.length;
    html += '<table class="ins"><caption>' + esc(count) + ' instruction' + (String(count) === '1' ? '' : 's')
        + ' <span class="muted args-h">— offset, opcode, argument bytes</span></caption><tbody>'
        + ins.map((i) => '<tr><td class="off">' + esc(i.offset) + '</td><td class="nm">' + esc(i.name)
            + '</td><td class="args">' + (i.args ? esc(i.args) : '') + '</td></tr>').join('')
        + '</tbody></table>';
    for (const n of (a && a.notes) || []) html += '<p class="note">' + esc(n) + '</p>';
    return html;
}

/**
 * Whether an amount is inside the cap. Arithmetic on the decoded terms, not a quote.
 *
 * The floor is judged at settlement against the live reserves, which the decode does not carry,
 * so this says nothing about the floor and the page says so next to it. `now` is a parameter so
 * a test can stand at a chosen moment.
 */
export function judgeAmount(m, text, now = Date.now()) {
    const amount = Number(text);
    if (text == null || String(text).trim() === '' || !Number.isFinite(amount) || amount < 0) return null;
    const short = (x) => String(Number(x.toPrecision(6)));
    if (!m || m.maxAmountInFormatted == null) {
        return { verdict: 'uncapped', text: 'no cap to check — nothing in this mandate bounds one trade' };
    }
    const cap = Number(m.maxAmountInFormatted);
    const expired = m.expiry != null && Number(m.expiry) * 1000 < now;
    if (amount > cap) {
        return { verdict: 'over', text: 'over the cap by ' + short(amount - cap) + ' — the settlement refuses this' };
    }
    const share = cap > 0 ? ' — ' + String(Number(((100 * amount) / cap).toPrecision(3))) + '% of it' : '';
    return expired
        ? { verdict: 'over', text: 'inside the cap' + share + ', but the mandate has expired — nothing settles' }
        : { verdict: 'inside', text: 'inside the cap' + share };
}

/**
 * The morning report: five facts in the same table as the decode, then what is wrong, then what
 * traded. `h` is the JSON of `GET /v1/position/health`; every field may be missing, and a missing
 * one reads as a dash rather than as a broken cell.
 */
export function renderHealth(h) {
    h = h || {};
    const hd = h.headroom || {};
    const short = (x) => (String(x).length > 14 ? esc(String(x).slice(0, 8)) + '…' + esc(String(x).slice(-4)) : esc(x));
    const tone = h.status === 'ok' ? ' yes' : (h.status === 'critical' || h.status === 'docked') ? ' no' : '';
    const hours = h.mandate && h.mandate.hoursLeft != null ? h.mandate.hoursLeft
        : h.terms && h.terms.expiry != null ? Math.round((Number(h.terms.expiry) - Date.now() / 1000) / 360) / 10 : null;
    const acted = h.authority && h.authority.agentLastActedAt;
    let html = facts([
        ['status', '<span class="tag' + tone + '">' + esc(h.status == null ? 'unknown' : h.status) + '</span>', false],
        ['headroom', hd.marginalBps == null ? '—'
            : esc(hd.marginalBps) + ' bps <span class="muted">spot after fee, above the floor</span>', true],
        ['worst case', hd.worstCaseOutflowB == null ? '—'
            : num(hd.worstCaseOutflowB) + ' B <span class="muted">out of one trade at the cap · '
            + esc(hd.worstCaseOutflowPctB) + '% of the reserve</span>', true],
        ['hours left', hours == null ? '—' : esc(hours) + ' h', true],
        ['agent last acted', acted ? when(acted) : '<span class="muted">never</span>', !!acted],
    ]);
    const alerts = h.alerts || [];
    html += alerts.length
        ? '<ul class="alerts">' + alerts.map((a) => '<li><span class="tag'
            + (a.severity === 'critical' ? ' no' : a.severity === 'info' ? ' muted' : '') + '">' + esc(a.severity)
            + '</span> <code>' + esc(a.code) + '</code> ' + esc(a.message) + '</li>').join('') + '</ul>'
        : '<p class="muted small" style="margin:1rem 0 0">no alerts</p>';
    const trades = (h.trades && h.trades.rows) || (Array.isArray(h.trades) ? h.trades : []);
    if (!trades.length) return html + '<p class="muted small" style="margin:.4rem 0 0">no trades since the ship</p>';
    html += '<div class="scroll"><table class="health"><caption>' + esc(trades.length) + ' trade'
        + (trades.length === 1 ? '' : 's') + ' since the ship</caption><thead><tr>'
        + ['tx', 'taker', 'in', 'out', 'above floor'].map((c) => '<th scope="col">' + c + '</th>').join('')
        + '</tr></thead><tbody>'
        + trades.map((t) => '<tr><td class="mono">'
            + (/^0x[0-9a-fA-F]{64}$/.test(String(t.tx))
                ? '<a href="https://sepolia.etherscan.io/tx/' + esc(t.tx) + '" rel="noopener">' + short(t.tx) + '</a>'
                : short(t.tx == null ? '—' : t.tx))
            + '</td><td class="mono">' + short(t.taker == null ? '—' : t.taker)
            + (t.selfTrade ? ' <span class="tag muted">maker</span>' : '')
            + '</td><td class="mono">' + (t.amountIn == null ? '—' : num(t.amountIn))
            + '</td><td class="mono">' + (t.amountOut == null ? '—' : num(t.amountOut))
            + '</td><td class="mono' + (t.bpsAboveFloor == null ? '' : t.bpsAboveFloor < 0 ? ' no' : ' yes') + '">'
            + (t.bpsAboveFloor == null ? '—' : esc(t.bpsAboveFloor) + ' bps') + '</td></tr>').join('')
        + '</tbody></table></div>';
    return html;
}

/** All of them, as source, for the page to carry. */
export const asBrowserSource = () => [esc, link, num, when, facts, renderMandate, judgeAmount, renderHealth]
    .map((f) => f.toString()).join('\n\n');
