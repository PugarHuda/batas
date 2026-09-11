// The page's rendering, in a file a test can import.
//
// These three run in the browser, and they were unreachable by anything here: `ui.mjs` is one long
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
        ? `<p style="margin:.8rem 0 0"><a href="${esc(href)}">${esc(label)}</a></p>`
        : '';
}

/** The decoded mandate as a definition list, its instruction listing, and any notes. */
export function renderMandate(a) {
    const m = (a && a.mandate) || {};
    const guarded = a && a.guarded
        ? '<span class="tag yes">guarded</span>'
        : '<span class="tag no">not guarded</span>';
    const rows = [
        ['guard', guarded + ' <span class="muted">PolicyEnvelope outermost, so later instructions run inside it</span>'],
        ['max input', m.maxAmountInFormatted == null
            ? '<span class="no">no cap — one trade may take the whole reserve</span>' : esc(m.maxAmountInFormatted)],
        ['floor rate', m.minRateFormatted == null
            ? '<span class="no">no floor — any rate the curve produces</span>' : esc(m.minRateFormatted)],
        ['fee', m.feePercent == null ? '—' : esc(m.feePercent) + '%'],
        ['curve', m.curve == null ? '—' : esc(m.curve)],
        ['expires', m.expiryISO == null
            ? '<span class="no">never — only revocation ends this</span>' : esc(m.expiryISO)],
        ['kill switch', m.killSwitch == null
            ? '<span class="muted">none — only the expiry and Aqua.dock() end this grant</span>'
            : `"${esc(m.killSwitch.label)}" in ${esc(m.killSwitch.registry)}`],
        ['instructions', esc(a && a.instructionCount)],
    ];
    let html = '<dl>' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd class="mono">' + v + '</dd>').join('') + '</dl>';
    if (a && a.instructions && a.instructions.length) {
        html += '<pre style="margin-top:1rem">' + a.instructions
            .map((i) => String(i.offset).padStart(3, ' ') + '  ' + esc(i.name))
            .join('\n') + '</pre>';
    }
    for (const n of (a && a.notes) || []) html += '<p class="note">' + esc(n) + '</p>';
    return html;
}

/** The three, as source, for the page to carry. */
export const asBrowserSource = () => [esc, link, renderMandate].map((f) => f.toString()).join('\n\n');
