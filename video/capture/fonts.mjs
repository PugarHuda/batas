// Writes the site's own faces (B612, B612 Mono, Barlow Condensed) out of agent/fonts.mjs so the
// video sets type in the same world as the page, without fetching anything from a third party.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FONTS } from '../../agent/fonts.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts');
mkdirSync(dir, { recursive: true });
for (const [name, b64] of Object.entries(FONTS)) writeFileSync(path.join(dir, `${name}.woff2`), Buffer.from(b64, 'base64'));
console.log(Object.keys(FONTS).join(' '));
