// The visual world both pages share: the aeronautical chart and the pilot's handbook.
//
// A mandate is an operating envelope. The chart supplies the vocabulary — a boundary that must not
// be crossed is drawn in airspace magenta, controlled structure in airspace blue — and the airspeed
// indicator supplies the states: green arc inside, yellow arc caution, red radial never exceed.
// Daylight first, because the reader is a maker at a desk deciding whether to trust this with money;
// the night palette is the same chart under cockpit lighting, not an inversion.
//
// Faces are served from /assets/fonts, cached for a year: bytes in agent/fonts.mjs, no third party.

export const FONT_FACES = `
  @font-face { font-family: "B612"; src: url("/assets/fonts/b612-400.woff2") format("woff2"); font-weight: 400; font-display: swap; }
  @font-face { font-family: "B612"; src: url("/assets/fonts/b612-700.woff2") format("woff2"); font-weight: 700; font-display: swap; }
  @font-face { font-family: "B612 Mono"; src: url("/assets/fonts/b612-mono-400.woff2") format("woff2"); font-weight: 400; font-display: swap; }
  @font-face { font-family: "Barlow Condensed"; src: url("/assets/fonts/barlow-condensed-700.woff2") format("woff2"); font-weight: 700; font-display: swap; }
`;

export const TOKENS = `
  :root {
    color-scheme: light dark;
    --ground: #f3f6f4;
    --paper: #fbfcfb;
    --sunk: #e9eeeb;
    --ink: #0f1a22;
    --ink-2: #33414d;
    --dim: #56636f;
    --rule: #d2dad5;
    --grid: #e3e9e5;
    --edge: #a9b5ae;
    --boundary: #a0146c;
    --boundary-soft: #f6e3ee;
    --structure: #1b4d99;
    --inside: #17753b;
    --caution: #8f5c00;
    --caution-fill: #f0b429;
    --never: #c0141a;
    --on-boundary: #ffffff;
    --shadow: 0 1px 1px rgb(15 26 34 / .06), 0 12px 32px -18px rgb(15 26 34 / .28);
    --display: "Barlow Condensed", "Arial Narrow", "Roboto Condensed", sans-serif;
    --text: "B612", ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    --figure: "B612 Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --number: "B612", ui-sans-serif, system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #0d1318;
      --paper: #121a21;
      --sunk: #0a0f13;
      --ink: #e7edf1;
      --ink-2: #bac6cf;
      --dim: #93a3af;
      --rule: #243240;
      --grid: #18222b;
      --edge: #3b4c5b;
      --boundary: #f26cbd;
      --boundary-soft: #3a1830;
      --structure: #86b4ff;
      --inside: #63d58e;
      --caution: #f2b632;
      --caution-fill: #f2b632;
      --never: #ff7070;
      --on-boundary: #0d1318;
      --shadow: 0 1px 1px rgb(0 0 0 / .4), 0 16px 36px -20px rgb(0 0 0 / .7);
    }
  }
`;

// Everything a page needs before its own composition: the ground, the faces, and the browser
// surfaces nobody draws but everybody sees.
export const BASE = `
  * { box-sizing: border-box; }
  html { scrollbar-color: var(--edge) transparent; -webkit-text-size-adjust: 100%; }
  ::selection { background: var(--boundary); color: var(--on-boundary); }
  ::placeholder { color: var(--dim); opacity: 1; }
  :focus-visible { outline: 2px solid var(--boundary); outline-offset: 3px; border-radius: 2px; }
  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font: 400 .9375rem/1.65 var(--text);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--structure); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  a:hover { text-decoration-thickness: 2px; }
  code, pre, kbd { font-family: var(--figure); font-variant-numeric: tabular-nums; }
  /* Figures are read, not typed: the proportional cockpit face with tabular numerals. The mono
     sets a decimal point as wide as a digit, and 1.941 reads as "1. 941". */
  .fig { font-family: var(--number); font-variant-numeric: tabular-nums lining-nums; letter-spacing: -.005em; }
  code { font-size: .88em; }
  pre {
    background: var(--sunk); border: 1px solid var(--rule); border-radius: 4px; margin: 0;
    padding: 1rem 1.15rem; overflow-x: auto; font-size: .8rem; line-height: 1.75; color: var(--ink);
  }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* The top bar: wordmark left, the way into the instrument right. Same on both pages, so the
     split between them reads as one product with two rooms. */
  .bar-top {
    position: sticky; top: 0; z-index: 20;
    background: color-mix(in oklab, var(--ground) 88%, transparent);
    backdrop-filter: saturate(1.2) blur(10px);
    border-bottom: 1px solid var(--rule);
  }
  .bar-top-in {
    max-width: 76rem; margin: 0 auto; padding: .7rem 1.25rem;
    display: flex; align-items: center; gap: 1.5rem;
  }
  .mark { display: inline-flex; align-items: center; gap: .6rem; color: var(--ink); text-decoration: none; }
  .mark svg { width: 26px; height: 26px; flex: none; }
  .mark b { font: 700 1.45rem/1 var(--display); letter-spacing: .06em; text-transform: uppercase; }
  .nav { display: flex; gap: 1.35rem; margin-left: auto; align-items: center; }
  .nav a { color: var(--ink-2); text-decoration: none; font-size: .88rem; }
  .nav a:hover, .nav a[aria-current="page"] { color: var(--ink); text-decoration: underline; text-decoration-color: var(--boundary); }
  .nav a.btn, .nav a.btn:hover { color: var(--on-boundary); text-decoration: none; }
  .nav a.btn.quiet, .nav a.btn.quiet:hover { color: var(--ink); }

  .btn {
    display: inline-flex; align-items: center; gap: .55rem; cursor: pointer;
    font: 700 .92rem/1 var(--text); letter-spacing: .01em; text-decoration: none;
    padding: .78rem 1.15rem; border-radius: 3px;
    background: var(--boundary); color: var(--on-boundary); border: 1px solid var(--boundary);
    transition: background-color .14s ease-out, transform .08s ease-out, box-shadow .14s ease-out;
    box-shadow: 0 1px 0 rgb(0 0 0 / .08);
  }
  .btn:hover { background: color-mix(in oklab, var(--boundary) 86%, var(--ink)); text-decoration: none; }
  .btn:active { transform: translateY(1px); }
  .btn.quiet { background: transparent; color: var(--ink); border-color: var(--edge); box-shadow: none; }
  .btn.quiet:hover { border-color: var(--ink); background: var(--paper); }

  /* Airspeed-indicator states. Colour is never the only carrier: every state also has a mark. */
  .state { display: inline-flex; align-items: center; gap: .4rem; font-size: .8rem; font-weight: 700; }
  .state::before { content: ""; width: .7rem; height: .7rem; flex: none; border-radius: 50%; }
  .state.inside { color: var(--inside); }
  .state.inside::before { background: currentColor; }
  .state.caution { color: var(--caution); }
  .state.caution::before { border: 2px solid currentColor; border-radius: 2px; }
  .state.never { color: var(--never); }
  .state.never::before { background: linear-gradient(45deg, transparent 42%, currentColor 42% 58%, transparent 58%), linear-gradient(-45deg, transparent 42%, currentColor 42% 58%, transparent 58%); border-radius: 0; }

  footer.foot {
    border-top: 1px solid var(--rule); color: var(--dim); font-size: .84rem;
  }
  .foot-in { max-width: 76rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; display: grid; gap: .6rem; }
  .foot a { color: var(--ink-2); }
  @media (max-width: 46rem) {
    .nav a:not(.btn) { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  }
`;

// The mark: two limit stops and a span that stops short of the right one. Drawn, not an emoji.
export const MARK_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="7" y="8" width="2.6" height="16" fill="var(--boundary)"/><rect x="22.4" y="8" width="2.6" height="16" fill="var(--boundary)"/><rect x="12" y="14.7" width="7.5" height="2.6" fill="currentColor"/></svg>`;

export const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#f3f6f4"/>'
    + '<rect x="7" y="8" width="2.6" height="16" fill="#a0146c"/><rect x="22.4" y="8" width="2.6" height="16" fill="#a0146c"/>'
    + '<rect x="12" y="14.7" width="7.5" height="2.6" fill="#0f1a22"/></svg>',
);

export const LICENCE = 'Powered by SwapVM — © Degensoft Ltd 2025 · Powered by Aqua — © Degensoft Ltd 2025';

export function topBar(current) {
    const here = (name) => (current === name ? ' aria-current="page"' : '');
    return `<header class="bar-top"><div class="bar-top-in">
  <a class="mark" href="/"${here('landing')}>${MARK_SVG}<b>Batas</b></a>
  <nav class="nav" aria-label="Primary">
    <a href="/#envelope">The envelope</a>
    <a href="/#proof">The proof</a>
    <a href="/#cost">What it costs</a>
    <a href="https://github.com/PugarHuda/batas" rel="noopener">Source</a>
    ${current === 'app'
        ? '<a class="btn quiet" href="/">About Batas</a>'
        : '<a class="btn" href="/app">Open the app</a>'}
  </nav>
</div></header>`;
}

export function foot({ topic, payTo }) {
    return `<footer class="foot"><div class="foot-in">
  <div>
    <a href="https://github.com/PugarHuda/batas" rel="noopener">source</a> ·
    <a href="https://hashscan.io/testnet/topic/${topic}" rel="noopener">mandate topic ${topic}</a> ·
    <a href="https://hashscan.io/testnet/account/${payTo}" rel="noopener">paid account ${payTo}</a> ·
    <a href="/?format=json">this service as JSON</a>
  </div>
  <div>Sepolia and Hedera testnet. Nothing here is advertised that cannot be checked.</div>
  <div class="small">${LICENCE}</div>
</div></footer>`;
}
