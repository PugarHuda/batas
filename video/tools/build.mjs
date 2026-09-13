// Writes the reading material from the same timeline the video uses: subtitles.srt, script.md (with
// the Indonesian reference and per-scene timings) and COVERAGE.md. It exits non-zero if a prize row
// is never on screen, if the length leaves the 3:30 to 3:55 window, or if a subtitle line is too long.
//
//   node tools/build.mjs            write the three files
//   node tools/build.mjs --rows a2a print a capture's wrapped rows with indices, to choose a `pin`
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { timeline, MAX_LINE } from '../src/timing.mjs';
import { ROWS, PRIZES } from '../src/rows.mjs';
import { FPS, SECONDS_PER_WORD } from '../src/scenes.mjs';
import { prepare, rowsAt } from '../src/terminal.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const capture = (n) => JSON.parse(readFileSync(path.join(root, 'public', 'captures', `${n}.json`), 'utf8'));

if (process.argv[2] === '--rows') {
    rowsAt(prepare(capture(process.argv[3])), Infinity).forEach((r, i) => console.log(String(i + 1).padStart(3), r));
    process.exit(0);
}

const t = timeline();
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const srtTime = (s) => {
    const ms = Math.round(s * 1000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

const CLIPS = {
    hero: 'batas-one.vercel.app, the hero and the live operating envelope; the probe moved through inside, under the floor, past the cap',
    app: 'batas-one.vercel.app/app, the live Publication, Kill switch and Reputation panels',
    ship: 'Sepolia Etherscan, ship tx 0x9408b60a…',
    swap: 'Sepolia Etherscan, swap tx 0x8cdec703…',
    aqua: 'Sepolia Etherscan, official Aqua 0x1111113C…',
    register: 'Sepolia Etherscan, batas.eth register tx 0xe01d01d3…',
    registry: 'Sepolia Etherscan, mandate registry 0x945800Bd… and its register/unregister transactions',
    grant: 'Sepolia Etherscan, ROLE_SET_TEXT grant tx 0x3da4cc35…',
    textwrite: "Sepolia Etherscan, the counterparty's own text write 0x09ab95bb…",
    resolver: 'Sepolia Etherscan, PermissionedResolver 0x671C506A…',
    alias: 'Sepolia Etherscan, aliasing multicall 0x9d141f70…',
    uri: 'Sepolia Etherscan, ERC-8004 registration uri tx 0x224e89f8…',
    token: 'HashScan, HTS token 0.0.10523367 with its custom fee',
    schedule: 'HashScan, schedule 0.0.10523344',
    mirror: 'Hedera mirror node, topic 0.0.10394165 payment records',
    name: 'GET /v1/agent/name on the live service',
    x402: 'GET /.well-known/x402 on the live service',
    card: 'GET /.well-known/agent-card.json on the live service',
    killswitch: "GitHub README, the kill switch's recorded `killswitch.mjs --prove` run",
    readme: 'GitHub README: Running it, The answer, Paying for what the bytecode says',
};
const describe = (sh) => (sh.clip ? CLIPS[sh.clip] : sh.term ? `terminal: \`${sh.env ? `${sh.env} ` : ''}${capture(sh.term).command}\`` : 'closing card: live URL, repository, video length');

const problems = [];
const seconds = t.totalFrames / FPS;
if (seconds < 210 || seconds > 235) problems.push(`length ${mmss(seconds)} is outside 3:30 to 3:55`);

// Subtitles.
const cues = t.scenes.flatMap((s) => s.cues);
const srt = cues.map((c, i) => {
    const next = cues[i + 1];
    const end = next && next.start - c.end < 1.2 ? next.start : c.end + 0.4;
    const lines = c.lines.map((l) => l.map((w) => w.text).join(' '));
    for (const l of lines) if (l.length > MAX_LINE) problems.push(`subtitle line over ${MAX_LINE}: "${l}"`);
    return `${i + 1}\n${srtTime(c.start)} --> ${srtTime(end)}\n${lines.join('\n')}\n`;
}).join('\n');
writeFileSync(path.join(root, 'subtitles.srt'), srt);

// Footage bounds: a shot that outruns its recording holds the last frame, which is allowed but worth knowing.
for (const s of t.scenes) for (const sh of s.shots) {
    if (sh.durFrames < 2.5 * FPS) problems.push(`${s.id}: a shot of ${(sh.durFrames / FPS).toFixed(1)} s is too short to read`);
    if (!sh.clip) continue;
    const meta = path.join(root, 'public', 'footage', `${sh.clip}.json`);
    if (!existsSync(meta)) { problems.push(`missing footage ${sh.clip}`); continue; }
    const len = JSON.parse(readFileSync(meta, 'utf8')).durationMs / 1000;
    const need = sh.from + sh.durFrames / FPS;
    if (need > len) console.warn(`note: ${s.id}/${sh.clip} needs ${need.toFixed(1)} s of a ${len.toFixed(1)} s clip; holds the last frame`);
}

// Script.
const script = [
    '# Batas demo: narration script',
    '',
    `Read along with the highlighted word. The pace is ${Math.round(60 / SECONDS_PER_WORD)} words a minute (${t.wordCount} words, ${mmss(seconds)} in total). Say "0x21" as "zero x twenty-one". The Indonesian under each scene is a reference for meaning, not for reading aloud.`,
    '',
    'Generated by `node tools/build.mjs` from `src/scenes.mjs`; edit the scenes, not this file.',
    '',
    ...t.scenes.flatMap((s) => {
        const end = (s.startFrame + s.durFrames) / FPS;
        return [
            `## ${s.index + 1}. ${s.title} (${mmss(s.start)}–${mmss(end)}, ${(s.durFrames / FPS).toFixed(1)} s)`,
            '',
            s.en,
            '',
            `> ${s.id_}`,
            '',
            'On screen:',
            ...s.shots.map((sh) => `- ${mmss(sh.startFrame / FPS)} ${describe(sh)}${sh.rows?.length ? ` [${sh.rows.join(', ')}]` : ''}`),
            '',
        ];
    }),
].join('\n');
writeFileSync(path.join(root, 'script.md'), script);

// Coverage.
const seen = Object.fromEntries(ROWS.map((r) => [r.id, []]));
for (const s of t.scenes) for (const sh of s.shots) for (const id of sh.rows ?? []) {
    if (!seen[id]) { problems.push(`unknown row ${id} in ${s.id}`); continue; }
    seen[id].push({ at: sh.startFrame / FPS, what: describe(sh) });
}
const coverage = [
    '# Demo video: prize requirement coverage',
    '',
    `Every row of the three prize tables in SUBMISSION.md, with the timestamps in \`out/batas-demo.mp4\` (${mmss(seconds)}) where it is on screen under a caption naming the requirement. Generated by \`node tools/build.mjs\`.`,
    '',
    ...Object.entries(PRIZES).flatMap(([key, label]) => [
        `## ${label}`,
        '',
        '| Row | Requirement caption | At | On screen |',
        '|---|---|---|---|',
        ...ROWS.filter((r) => r.prize === key).map((r) => {
            if (!seen[r.id].length) problems.push(`row ${r.id} never on screen`);
            // A shell pipe inside a command would end the table cell early.
            const what = [...new Set(seen[r.id].map((x) => x.what))].join('; ').replace(/\|/g, '\\|');
            return `| ${r.id} | ${r.caption} | ${seen[r.id].map((x) => mmss(x.at)).join(', ')} | ${what} |`;
        }),
        '',
    ]),
].join('\n');
writeFileSync(path.join(root, 'COVERAGE.md'), coverage);

console.log(`${t.scenes.length} scenes, ${t.wordCount} words, ${mmss(seconds)} (${t.totalFrames} frames), ${cues.length} cues`);
for (const s of t.scenes) console.log(`  ${mmss(s.start)} ${s.id} ${(s.durFrames / FPS).toFixed(1)}s`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
