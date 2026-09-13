// The demo, scene by scene: what the author says (en), a reference translation (id), and the real
// footage under it. Shot kinds:
//   { clip, from, dur, zoom }  a Playwright recording in public/footage, `from` seconds in, and an
//                              optional source rectangle to frame (never a speed change)
//   { term, dur, pin }         a captured command replayed at its recorded pace; `pin` keeps that
//                              line at the top instead of following the newest output
//   { card, dur }              the closing card
// The last shot of a scene fills whatever time the narration leaves. `rows` name SUBMISSION.md rows.

export const FPS = 30;
// About 150 words a minute, including the small pauses at commas and full stops.
export const SECONDS_PER_WORD = 0.4;
export const LEAD = 0.5;
export const TAIL = 0.6;

const PLATE = { x: 330, y: 60, w: 1240, h: 640 };
// A JSON response fills only the top of the page; framing that band keeps its text near full size.
const JSON_TOP = { x: 0, y: 0, w: 1920, h: 760 };

export const SCENES = [
    {
        id: 'intro',
        title: 'What Batas is',
        en: "Hi, this is Batas. It's an Indonesian word. It means a mandate: authority with limits you can't cross. If an AI agent runs your liquidity, what actually stops it?",
        id_: 'Hai, ini Batas. Ini kata bahasa Indonesia. Artinya mandat: wewenang dengan batas yang tidak boleh dilewati. Kalau agen AI mengelola likuiditasmu, apa yang benar-benar menghentikannya?',
        shots: [{ clip: 'hero', from: 0.5, dur: 99, zoom: PLATE, rows: [] }],
    },
    {
        id: 'envelope',
        title: 'The envelope, enforced in settlement',
        en: "On 1inch Aqua, your tokens stay in your wallet, and the app pulls them at settlement. Batas puts the limits inside that swap. Watch the probe. Inside the envelope, it settles. Under the floor, it's refused. Past the size cap, refused again.",
        id_: 'Di 1inch Aqua, tokenmu tetap di dompetmu, dan aplikasinya menarik token itu saat swap diselesaikan. Batas menaruh batasnya di dalam swap itu. Lihat probe-nya. Di dalam envelope, swap berhasil. Di bawah harga minimum, ditolak. Melewati batas ukuran, ditolak lagi.',
        shots: [{ clip: 'hero', from: 9.5, dur: 99, zoom: PLATE, rows: ['I-1'] }],
    },
    {
        id: 'onchain',
        title: 'Real transfers, official Aqua, new opcodes',
        en: "This isn't a simulation. Here's the ship and a swap on Sepolia, real token transfers. Aqua is the official contract, untouched. What I added is a router with two new SwapVM instructions, 0x21 and 0x22.",
        id_: 'Ini bukan simulasi. Ini transaksi ship dan swap di Sepolia, transfer token sungguhan. Aqua adalah kontrak resmi, tidak diubah. Yang saya tambahkan adalah router dengan dua instruksi SwapVM baru, 0x21 dan 0x22.',
        shots: [
            { clip: 'ship', from: 4, dur: 4, rows: ['I-4'] },
            { clip: 'swap', from: 4, dur: 4, rows: ['I-4'] },
            { clip: 'aqua', from: 3, dur: 3, rows: ['I-3'] },
            { term: 'walkthrough', pin: 0, dur: 99, rows: ['I-2'] },
        ],
    },
    {
        id: 'tests',
        title: 'Tested, including a banded position',
        en: "It's tested. Forge runs seventy-two tests, all passing. The harder one is a banded position. This test ships it to the real Aqua on a Sepolia fork, trades both ways, and gets refused past every limit.",
        id_: 'Ini sudah diuji. Forge menjalankan tujuh puluh dua tes, semuanya lulus. Yang lebih sulit adalah posisi berpita. Tes ini mengirimnya ke Aqua asli di fork Sepolia, bertransaksi dua arah, dan ditolak di setiap batas.',
        shots: [
            { term: 'forge-test', dur: 6, rows: ['I-1'] },
            { term: 'test-band', dur: 99, rows: ['I-1'] },
        ],
    },
    {
        id: 'ens-name',
        title: 'Authority is an ENSv2 name',
        en: "So who's allowed to trade? An ENS name, agent.batas.eth, on ENSv2. I registered batas.eth, and its subregistry is my own. The name expires with the mandate, I can revoke it, and nobody can transfer it.",
        id_: 'Jadi siapa yang boleh bertransaksi? Sebuah nama ENS, agent.batas.eth, di ENSv2. Saya mendaftarkan batas.eth, dan subregistry-nya milik saya sendiri. Namanya kedaluwarsa bersama mandat, saya bisa mencabutnya, dan tidak ada yang bisa memindahkannya.',
        shots: [
            { clip: 'register', from: 4, dur: 6, rows: ['E-Q1', 'E-F1'] },
            { clip: 'registry', from: 4, dur: 99, rows: ['E-F1', 'E-F2'] },
        ],
    },
    {
        id: 'killswitch',
        title: 'The kill switch',
        en: "Here's the key part. The settlement reads that registry. Revoke the name and every swap is refused, for every caller, not just my agent. This is the recorded run: quote, revoke, refused, grant back.",
        id_: 'Ini bagian terpentingnya. Settlement membaca registry itu. Cabut namanya, dan setiap swap ditolak, untuk semua pemanggil, bukan hanya agen saya. Ini rekaman jalannya: quote, cabut, ditolak, diberikan lagi.',
        shots: [{ clip: 'killswitch', from: 21.5, zoom: { x: 330, y: 110, w: 1000, h: 430 }, dur: 99, rows: ['E-Q2', 'E-F2'] }],
    },
    {
        id: 'ens-features',
        title: 'Resolver, delegation, aliasing, wildcard',
        en: "The name has its own permissioned resolver. A second account may write one text record, nothing more. mandate.batas.eth is registered nowhere, but it answers with the agent's records. And other labels resolve through the parent.",
        id_: 'Nama ini punya permissioned resolver sendiri. Akun kedua boleh menulis satu text record, dan tidak lebih. mandate.batas.eth tidak terdaftar di mana pun, tapi menjawab dengan record milik agen. Dan label lain di-resolve lewat induknya.',
        shots: [
            { clip: 'resolver', from: 4, dur: 3.5, rows: ['E-F4'] },
            { clip: 'grant', from: 4, dur: 3, rows: ['E-F3'] },
            { clip: 'textwrite', from: 4, dur: 2.5, rows: ['E-F3'] },
            { clip: 'alias', from: 4, dur: 3, rows: ['E-F6'] },
            { term: 'ens-resolve', dur: 99, rows: ['E-F5', 'E-Q1'] },
        ],
    },
    {
        id: 'ens-live',
        title: 'Resolved on every request',
        en: "None of this is hard-coded. The live service resolves the name on every request, and checks its link to ERC-8004 agent 10123, both ways. The agent is a namespace with its own identity.",
        id_: 'Semua ini tidak di-hard-code. Layanan live me-resolve nama itu di setiap request, dan memeriksa tautannya ke agen ERC-8004 10123, dua arah. Agen ini adalah namespace dengan identitasnya sendiri.',
        shots: [
            { clip: 'name', from: 18.7, zoom: JSON_TOP, dur: 6, rows: ['E-Q3', 'E-F7'] },
            { term: 'ens-verify', dur: 4.5, rows: ['E-F7'] },
            { clip: 'uri', from: 4, dur: 99, rows: ['E-F7'] },
        ],
    },
    {
        id: 'x402',
        title: 'A stranger agent pays over x402',
        en: "Now Hedera. This is a different agent, with its own wallet. It finds the service in the ERC-8004 registry and checks the x402 manifest agrees. The checks are free, but in paranoid mode it pays for the full answer.",
        id_: 'Sekarang Hedera. Ini agen yang berbeda, dengan dompetnya sendiri. Ia menemukan layanan di registry ERC-8004 dan memeriksa manifest x402 cocok. Pemeriksaannya gratis, tapi dalam mode paranoid ia membayar untuk jawaban lengkap.',
        shots: [
            { clip: 'x402', from: 17.2, zoom: JSON_TOP, dur: 6, rows: ['H-E4', 'H-Q2'] },
            { term: 'counterparty-paranoid', env: 'BATAS_SERVICE_URL=',dur: 99, rows: ['H-Q1', 'H-E4'] },
        ],
    },
    {
        id: 'metered',
        title: 'Metered price and identity',
        en: "That payment settled on Hedera testnet through Blocky402. The price is metered from the request, so this call cost 0.0012 HBAR. And the operator's ERC-8004 identity checks out.",
        id_: 'Pembayaran itu diselesaikan di Hedera testnet lewat Blocky402. Harganya dihitung dari request, jadi panggilan ini seharga 0.0012 HBAR. Dan identitas ERC-8004 operatornya valid.',
        shots: [
            { term: 'counterparty-paranoid', env: 'BATAS_SERVICE_URL=', hold: true, pin: 38, dur: 8, rows: ['H-Q1', 'H-E2', 'H-E1'] },
            { clip: 'card', from: 12.5, zoom: JSON_TOP, dur: 99, rows: ['H-E1'] },
        ],
    },
    {
        id: 'a2a',
        title: 'Agents negotiate over A2A',
        en: "Agents can negotiate, too. My client asks for fourteen tokens. The Batas agent says that's over the cap and counters with the largest size that clears the floor. The client accepts and pays in the same task.",
        id_: 'Agen juga bisa bernegosiasi. Klien saya meminta empat belas token. Agen Batas bilang itu melebihi batas, lalu menawar balik dengan ukuran terbesar yang masih lolos harga minimum. Klien menerima dan membayar di task yang sama.',
        shots: [{ term: 'a2a', dur: 99, rows: ['H-E3', 'H-Q2'] }],
    },
    {
        id: 'hts',
        title: 'Paying in an HTS token',
        en: "It doesn't have to be HBAR. Here it pays with our HTS token. The token has a fixed custom fee, and it's charged right in the settlement.",
        id_: 'Tidak harus HBAR. Di sini ia membayar dengan token HTS kami. Token ini punya biaya kustom tetap, dan biaya itu dipotong langsung di settlement.',
        shots: [
            { term: 'hts-pay', dur: 7, rows: ['H-E5'] },
            { clip: 'token', from: 12.5, dur: 99, rows: ['H-E5'] },
        ],
    },
    {
        id: 'audit',
        title: 'Audit trail on HCS',
        en: "After every payment, the payer writes a record to an HCS topic, with hashes of the request and response. My checker verifies each record against the ledger.",
        id_: 'Setelah setiap pembayaran, pembayar menulis catatan ke topik HCS, dengan hash dari request dan response. Pemeriksa saya memverifikasi setiap catatan terhadap ledger.',
        shots: [
            { term: 'payments-after', dur: 7, rows: ['H-E6'] },
            { clip: 'mirror', from: 15.5, zoom: JSON_TOP, dur: 99, rows: ['H-E6'] },
        ],
    },
    {
        id: 'schedule',
        title: 'Scheduled payments and a directory',
        en: "Payments can repeat. This order paid three times by scheduled transactions, and another was cancelled. Other agents can also find Batas in the Hashgraph Online directory.",
        id_: 'Pembayaran bisa berulang. Order ini membayar tiga kali lewat scheduled transaction, dan satu lagi dibatalkan. Agen lain juga bisa menemukan Batas di direktori Hashgraph Online.',
        shots: [
            { term: 'subscribe-status', dur: 5, rows: ['H-E7'] },
            { clip: 'schedule', from: 11, dur: 4, rows: ['H-E7'] },
            { term: 'hol-find', dur: 99, rows: ['H-E4', 'H-E1'] },
        ],
    },
    {
        id: 'builders',
        title: 'For builders',
        en: "There's a Hedera Agent Kit adapter in the package. The README covers setup, the architecture, and how the payment flow works. And it's a hundred and forty-two commits over seven days.",
        id_: 'Ada adapter Hedera Agent Kit di dalam paketnya. README menjelaskan setup, arsitektur, dan alur pembayaran. Dan ada seratus empat puluh dua commit selama tujuh hari.',
        shots: [
            { term: 'agent-kit', dur: 2.5, rows: ['H-Q2'] },
            { clip: 'readme', from: 30.5, dur: 2.5, rows: ['H-Q3', 'E-Q4'] },
            { clip: 'readme', from: 46.5, dur: 2.5, rows: ['H-Q3'] },
            { clip: 'readme', from: 70, dur: 2.5, rows: ['H-Q3'] },
            { term: 'commits', dur: 99, rows: ['I-5'] },
        ],
    },
    {
        id: 'close',
        title: 'The live app',
        en: "Last, the live app. Every number here is read from Sepolia, Hedera and ENS when the page loads. The agent trades, the settlement holds the limits, and I can take the authority back. Thanks for watching.",
        id_: 'Terakhir, aplikasi live-nya. Setiap angka di sini dibaca dari Sepolia, Hedera, dan ENS saat halaman dimuat. Agen bertransaksi, settlement menjaga batasnya, dan saya bisa menarik kembali wewenangnya. Terima kasih sudah menonton.',
        shots: [
            { clip: 'app', from: 13, dur: 11, rows: ['I-1', 'E-Q4'] },
            { card: true, dur: 99, rows: ['E-Q4', 'H-Q4'] },
        ],
    },
];
