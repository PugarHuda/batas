// Runs one real project command from the repository root and records its output as it arrives,
// each chunk stamped with the milliseconds since start, so the video can replay the terminal at the
// pace it actually ran instead of an invented one.
//
//   node capture/term.mjs <name> <command...>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const [name, ...cmd] = process.argv.slice(2);
const root = path.resolve(here, '..', '..');
const dir = path.join(here, '..', 'public', 'captures');
mkdirSync(dir, { recursive: true });
const events = [];
const started = Date.now();
const child = spawn(cmd.join(' '), { cwd: root, shell: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
const take = (buf) => { const text = buf.toString(); events.push([Date.now() - started, text]); process.stdout.write(text); };
child.stdout.on('data', take);
child.stderr.on('data', take);
child.on('close', (code) => {
    const out = { name, command: cmd.join(' '), startedAt: new Date(started).toISOString(), exitCode: code, durationMs: Date.now() - started, events };
    writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(out, null, 1));
    console.error(`\n[${name}] exit ${code} in ${out.durationMs} ms`);
});
