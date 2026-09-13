// node gen.ts : writes subtitles/NN-name.srt and script.md from src/narration.ts, prints durations.
import fs from 'node:fs';
import { SCENES, FPS, timeScene } from './src/narration.ts';
import { keccak256, encodeAbiParameters, parseAbiParameters, concat } from 'viem'; // resolved from the repo root
import { decodeProgram } from '../agent/swapvm.mjs';

// Scene 03's two hashes, computed rather than typed: the order as shipped (agent/sdk-parity.test.mjs
// finding 3), and the same order with its PolicyEnvelope instruction cut out of the program.
const PROGRAM = '0x212100000000000000006367be30fcbd45ea00000000000000001aeff914e72b45e8802005006acd0476222e945800bd6cdd60521b64a12d7b3f12fc90916a6b39d2bae5eaeda9283535ddc98f1991c81ed5cd7e056167656e74700300753050000208000000006aa5dc37';
const SHIPPED = '0x4ed644d49b49c00c8913b87d4af774b4cf224890674052f36218bf7bc2104921';
const orderHash = (program: `0x${string}`) => keccak256(encodeAbiParameters(
  parseAbiParameters('(address maker, uint256 traits, bytes data)'),
  [{
    maker: '0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E',
    traits: (1n << 254n) | (0x0028002800280028n << 160n),
    data: concat(['0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B', '0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81', program]),
  }],
));
const ins = decodeProgram(PROGRAM);
const env = ins.findIndex((i: { name: string }) => i.name === 'POLICY_ENVELOPE');
if (env !== 0) throw new Error('PolicyEnvelope is not the outermost instruction');
const envEnd = ins[1].offset as number;
const shipped = orderHash(PROGRAM);
if (shipped !== SHIPPED) throw new Error(`order bytes do not reproduce the shipped hash: ${shipped}`);
const unguarded = orderHash(`0x${PROGRAM.slice(2 + envEnd * 2)}`);
fs.writeFileSync('src/hashes.json', JSON.stringify({ shipped, unguarded, envelopeBytes: envEnd }, null, 2) + '\n');
console.log('shipped', shipped, '\nwithout PolicyEnvelope', unguarded, `(bytes 0..${envEnd - 1} removed)`);

const ts = (fr: number) => {
  const ms = Math.round((fr / FPS) * 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

let md = '# Batas explainer scenes: narration\n\nRead each line as its words light up. English is spoken; the Indonesian is a reference only.\n';
let total = 0;
fs.mkdirSync('subtitles', { recursive: true });
for (const s of SCENES) {
  const { cues, duration } = timeScene(s.en);
  total += duration;
  const words = s.en.join(' ').split(' ').length;
  const speak = (cues.at(-1)!.end - cues[0].start) / FPS;
  fs.writeFileSync(`subtitles/${s.id}.srt`, cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n'));
  md += `\n## ${s.id} (${(duration / FPS).toFixed(1)} s)\n\n| # | Starts | English (spoken) | Bahasa Indonesia (reference) |\n|---|---|---|---|\n`;
  cues.forEach((c, i) => { md += `| ${i + 1} | ${(c.start / FPS).toFixed(1)} s | ${c.text} | ${s.id_[i]} |\n`; });
  console.log(s.id, (duration / FPS).toFixed(2) + 's', words + ' words', Math.round(words / (speak / 60)) + ' wpm');
}
fs.writeFileSync('script.md', md + `\nTotal: ${(total / FPS).toFixed(1)} s across ${SCENES.length} scenes.\n`);
console.log('total', (total / FPS).toFixed(2) + 's');
