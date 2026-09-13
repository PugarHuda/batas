// Replays a captured command. Output appears at the moment it was recorded, except that any silence
// longer than CUT_OVER (a network round trip, a compile) is shortened to CUT_TO, and a badge says so
// while it happens. Text is never rewritten, reordered or sped up.
export const CUT_OVER = 1500;
export const CUT_TO = 700;
export const TYPE_MS = 900;
export const COLS = 138;

const clean = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n');

export function prepare(capture) {
    let prev = 0, acc = 0;
    const events = capture.events.map(([ms, text]) => {
        const gap = ms - prev;
        const cut = gap > CUT_OVER;
        acc += cut ? CUT_TO : gap;
        prev = ms;
        return { at: TYPE_MS + acc, text: clean(text), cut };
    });
    return { command: capture.command, startedAt: capture.startedAt, events, doneAt: events.at(-1)?.at ?? TYPE_MS };
}

// Wraps to fixed columns so the row count, and therefore the scroll position, is deterministic.
export function rowsAt(prepared, ms) {
    const text = prepared.events.filter((e) => e.at <= ms).map((e) => e.text).join('');
    const rows = [];
    for (const raw of text.split('\n')) {
        const line = raw.includes('\r') ? raw.slice(raw.lastIndexOf('\r') + 1) : raw;
        if (!line.length) { rows.push(''); continue; }
        for (let i = 0; i < line.length; i += COLS) rows.push(line.slice(i, i + COLS));
    }
    if (rows.length && rows.at(-1) === '') rows.pop();
    return rows;
}

export const cutShowing = (prepared, ms) => prepared.events.some((e) => e.cut && ms >= e.at - CUT_TO && ms < e.at + 500);
