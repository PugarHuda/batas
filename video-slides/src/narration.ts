// Narration per scene: one cue is one karaoke page (at most two rows of about 42 characters).
// Timing is derived, not hand-set, so the karaoke, the SRT and the scene length always agree.
export const FPS = 30;

export type Word = { text: string; start: number; end: number };
export type Cue = { words: Word[]; start: number; end: number; text: string };

export const SCENES: { id: string; title: string; en: string[]; id_: string[] }[] = [
  { id: '01-cold-open', title: 'Batas',
    en: ['This is Batas.', 'Indonesian for mandate: authority within limits.'],
    id_: ['Ini Batas.', 'Bahasa Indonesia untuk mandat: wewenang di dalam batas.'] },
  { id: '02-problem', title: 'The problem',
    en: ["Aqua's pull only checks who's calling.", 'So any app you ship to can take your tokens.', 'Hand that app to an agent. What stops it?'],
    id_: ['Fungsi pull di Aqua hanya memeriksa siapa pemanggilnya.', 'Jadi aplikasi mana pun yang kamu kirimi bisa mengambil tokenmu.', 'Serahkan aplikasi itu ke agen. Apa yang menghentikannya?'] },
  { id: '03-mandate-is-the-strategy', title: 'The mandate is the strategy',
    en: ['We encode the cap, floor and expiry as the strategy bytes.', 'PolicyEnvelope wraps the program. Aqua hashes it.', 'Drop a limit, and the hash is one nobody funded.'],
    id_: ['Kami mengodekan batas ukuran, harga dasar, dan masa berlaku sebagai byte strategi.', 'PolicyEnvelope membungkus programnya. Aqua meng-hash-nya.', 'Hapus satu batas, dan hash-nya jadi hash yang tidak didanai siapa pun.'] },
  { id: '04-kill-switch', title: 'The kill switch',
    en: ["The agent's authority is an ENS name.", 'MandateName reads it on every settlement.', 'Revoke it, and every swap reverts, for everyone.'],
    id_: ['Wewenang agen adalah sebuah nama ENS.', 'MandateName membacanya di setiap settlement.', 'Cabut nama itu, dan setiap swap gagal, untuk semua orang.'] },
  { id: '05-hedera-economy', title: 'The agent economy on Hedera',
    en: ['On Hedera, agents pay us per request with x402, via Blocky402.', 'In HBAR, or our BIC token with its fee.', 'Each payment is logged on HCS.', 'Agents negotiate over A2A, pay on a schedule, and find us in a directory.'],
    id_: ['Di Hedera, agen membayar kami per permintaan dengan x402, lewat Blocky402.', 'Dengan HBAR, atau token BIC kami beserta biayanya.', 'Setiap pembayaran dicatat di HCS.', 'Agen bernegosiasi lewat A2A, membayar terjadwal, dan menemukan kami di direktori.'] },
  { id: '06-ens-hierarchy', title: 'The name in ENS',
    en: ['Under batas dot eth, one resolver answers every subname.', 'Mandate is an alias for agent.', 'The counterparty may edit one text key.', 'And it links both ways to ERC-8004.'],
    id_: ['Di bawah batas.eth, satu resolver menjawab setiap subname.', 'Mandate adalah alias untuk agent.', 'Pihak lawan hanya boleh mengubah satu kunci teks.', 'Dan nama itu tertaut dua arah ke ERC-8004.'] },
  { id: '07-close', title: 'Batas',
    en: ['One mandate, three tracks: 1inch, ENS and Hedera.', "It's live. Try it, and read the code."],
    id_: ['Satu mandat, tiga track: 1inch, ENS, dan Hedera.', 'Sudah live. Coba, dan baca kodenya.'] },
];

const LEAD = 9, TAIL = 18, GAP = 4;

// ponytail: syllable-free length heuristic; digits count triple because "8004" is spoken as words.
export function timeScene(lines: string[]) {
  let f = LEAD;
  const cues: Cue[] = lines.map((text) => {
    const words: Word[] = text.split(' ').map((t) => {
      const n = Math.min(14, t.replace(/[^A-Za-z]/g, '').length + 3 * t.replace(/[^0-9]/g, '').length);
      const w = { text: t, start: f, end: f + Math.round(3.5 + 1.55 * n) };
      f = w.end + (/[.?!:]$/.test(t) ? 6 : /[,;]$/.test(t) ? 3 : 0);
      return w;
    });
    const cue = { words, start: words[0].start, end: f, text };
    f += GAP;
    return cue;
  });
  return { cues, duration: f + TAIL };
}

// Frame at which the nth occurrence of a word is spoken, so visuals land on the word they illustrate.
export function wordAt(cues: Cue[], word: string, nth = 0) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const c of cues) for (const w of c.words) if (norm(w.text) === norm(word) && nth-- === 0) return w.start;
  throw new Error(`word "${word}" not in narration`);
}
