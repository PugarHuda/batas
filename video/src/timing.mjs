// Turns the script into time: every word gets a start and end at the narration pace, words group
// into subtitle cues of at most two 42-character lines, and every shot gets a frame range. The video,
// the .srt and script.md all read this one function, so the subtitles on screen and in the file can
// never drift apart.
import { SCENES, FPS, SECONDS_PER_WORD, LEAD, TAIL } from './scenes.mjs';

export const MAX_LINE = 42;

// A full stop earns a longer beat than a comma, so the highlight waits where a speaker breathes.
const weight = (w) => 1 + (/[.?!]$/.test(w) ? 0.6 : /[,:;]$/.test(w) ? 0.3 : 0);

function cuesFor(words) {
    const lines = [];
    let line = [];
    const len = (ws) => ws.map((w) => w.text).join(' ').length;
    for (const w of words) {
        if (line.length && len([...line, w]) > MAX_LINE) { lines.push(line); line = []; }
        line.push(w);
        // Break after a sentence once the line has some body, so a cue rarely starts mid-thought.
        if (/[.?!]$/.test(w.text) && len(line) >= 16) { lines.push(line); line = []; }
    }
    if (line.length) lines.push(line);
    const cues = [];
    for (let i = 0; i < lines.length; i += 2) {
        const pair = lines.slice(i, i + 2);
        cues.push({ lines: pair, start: pair[0][0].start, end: pair.at(-1).at(-1).end });
    }
    return cues;
}

export function timeline() {
    let frame = 0;
    const scenes = SCENES.map((s, index) => {
        const tokens = s.en.split(/\s+/).filter(Boolean);
        const speech = tokens.length * SECONDS_PER_WORD;
        const total = tokens.reduce((a, w) => a + weight(w), 0);
        const start = frame / FPS;
        let c = start + LEAD;
        const words = tokens.map((text) => {
            const d = (speech * weight(text)) / total;
            const w = { text, start: c, end: c + d };
            c += d;
            return w;
        });
        const durFrames = Math.round((LEAD + speech + TAIL) * FPS);
        const fixed = s.shots.slice(0, -1).reduce((a, sh) => a + Math.round(sh.dur * FPS), 0);
        let at = frame;
        const shots = s.shots.map((sh, i) => {
            const f = i === s.shots.length - 1 ? durFrames - fixed : Math.round(sh.dur * FPS);
            const out = { ...sh, from: sh.from ?? 0, startFrame: at, durFrames: f };
            at += f;
            return out;
        });
        const scene = { ...s, index, start, startFrame: frame, durFrames, words, cues: cuesFor(words), shots };
        frame += durFrames;
        return scene;
    });
    return { scenes, totalFrames: frame, fps: FPS, wordCount: scenes.reduce((a, s) => a + s.words.length, 0) };
}
