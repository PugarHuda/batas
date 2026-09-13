// The one surface here meant for a person.
//
// Every other answer this service gives is JSON, on purpose: its consumers are agents, indexers
// and facilitators, and `qa/service.spec.mjs` holds it to that. This page is the exception that
// proves the rule rather than an erosion of it — `GET /` serves it only to a caller whose Accept
// header actually says `text/html`, which a browser sends and no machine client here does. One
// URL, two audiences, and neither is handed the other's format.
//
// It talks to the free routes only. Those exist at HTTP parity with the free MCP tools, which have
// always given away the decode, the publication lookup and the authority check — so nothing here
// is newly free. What stays behind the paywall is the same thing it always was: the whole answer
// assembled in one place, with the ERC-8004 identity and whether it vouches for the maker.
//
// No CDN, no build step, no framework. The page is a string this module returns, which is also why
// it survives being bundled by Vercel: there is no file to find at runtime.

import { asBrowserSource } from './ui-render.mjs';

export function page({ origin, price, payTo, topic, facilitator, network }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Batas — a mandate a machine enforces</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%227%22%20fill%3D%22%230a0c0f%22%2F%3E%3Crect%20x%3D%226%22%20y%3D%228%22%20width%3D%222.5%22%20height%3D%2216%22%20rx%3D%221.25%22%20fill%3D%22%236fe3ff%22%2F%3E%3Crect%20x%3D%2223.5%22%20y%3D%228%22%20width%3D%222.5%22%20height%3D%2216%22%20rx%3D%221.25%22%20fill%3D%22%236fe3ff%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%2214.75%22%20width%3D%228%22%20height%3D%222.5%22%20rx%3D%221.25%22%20fill%3D%22%23e9eef4%22%2F%3E%3C%2Fsvg%3E">
<style>
  /* Dark first, because the scene is someone reading numbers off a panel to decide whether a
     position is safe — not a brochure skimmed in daylight. Light is designed, not derived. */
  :root {
    color-scheme: dark light;
    --bg: #0a0c0f;
    --bg-deep: #070809;
    --panel: #10141a;
    --raise: #161c24;
    --ink: #e9eef4;
    --dim: #8794a3;          /* tinted from the ground, never neutral grey */
    --line: #1d242d;
    --edge: #2c3644;
    --accent: #6fe3ff;
    --accent-ink: #0a0c0f;
    --accent-soft: #12303a;
    --ok: #4ade80;
    --no: #ff6b6b;
    --code: #0d1116;
    --shadow: 0 1px 2px rgb(0 0 0 / .5), 0 8px 24px -8px rgb(0 0 0 / .6);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f2f5f8;
      --bg-deep: #e8edf2;
      --panel: #ffffff;
      --raise: #ffffff;
      --ink: #0c1117;
      --dim: #56626f;
      --line: #dde4ec;
      --edge: #b9c4d0;
      --accent: #06627a;
      --accent-ink: #ffffff;
      --accent-soft: #dff1f6;
      --ok: #10693b;
      --no: #b3261e;
      --code: #f5f8fa;
      --shadow: 0 1px 2px rgb(13 22 33 / .06), 0 10px 28px -12px rgb(13 22 33 / .18);
    }
  }
  * { box-sizing: border-box; }
  html { scrollbar-color: var(--edge) transparent; }
  ::selection { background: var(--accent); color: var(--accent-ink); }
  ::placeholder { color: var(--dim); opacity: 1; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: .9375rem/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    font-variant-numeric: tabular-nums;
  }

  /* The masthead is the one full-bleed element: the page opens as an instrument switching on. */
  .top {
    background: var(--bg-deep);
    border-bottom: 1px solid var(--edge);
    padding: clamp(2.5rem, 6vw, 4.5rem) 1.25rem clamp(2.25rem, 4vw, 3.25rem);
    box-shadow: inset 0 -1px 0 var(--line);
  }
  .top-in { max-width: 72rem; margin: 0 auto; }
  main { max-width: 72rem; margin: 0 auto; padding: 0 1.25rem 6rem; }

  h1 {
    font-size: clamp(2.6rem, 7vw, 4.25rem); line-height: .95; letter-spacing: -.04em;
    font-weight: 680; margin: 0 0 1rem; text-wrap: balance;
  }
  .lede { font-size: clamp(1.02rem, 1.6vw, 1.2rem); color: var(--dim); max-width: 54ch; margin: 0; }
  .lede strong { color: var(--ink); font-weight: 620; }

  /* Section heads are structure, so they get a rule and the column's full width. */
  h2 {
    font-size: 1.35rem; letter-spacing: -.02em; font-weight: 640; color: var(--ink);
    margin: 4.5rem 0 .9rem; padding-top: 1.1rem; border-top: 1px solid var(--line);
    text-wrap: balance;
  }
  h3 { font-size: .98rem; font-weight: 640; letter-spacing: -.01em; margin: .9rem 0 .3rem; }
  p { margin: 0 0 1rem; max-width: 68ch; }
  a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  a:hover { text-decoration-thickness: 2px; }

  .panel {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 1.35rem 1.45rem; box-shadow: var(--shadow);
  }
  code, pre, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
                     font-variant-numeric: tabular-nums; }
  code { color: var(--ink); }
  pre { background: var(--code); border: 1px solid var(--line); border-radius: 10px;
        padding: .95rem 1.1rem; overflow-x: auto; font-size: .82rem; margin: 0; line-height: 1.7; }
  textarea, input {
    width: 100%; padding: .8rem .9rem;
    background: var(--code); color: var(--ink); border: 1px solid var(--edge); border-radius: 9px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .82rem;
    caret-color: var(--accent);
    transition: border-color .12s ease-out, box-shadow .12s ease-out;
  }
  textarea { min-height: 5.5rem; resize: vertical; line-height: 1.7; }
  textarea:hover, input:hover { border-color: var(--dim); }
  /* The ring is in addition to the focus outline, never instead of it. qa/ui.spec.mjs refuses any
     suppression of it anywhere in this page's source, and is right to. */
  textarea:focus, input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  button {
    font: inherit; font-weight: 620; cursor: pointer; padding: .58rem 1.15rem; border-radius: 9px;
    border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink);
    letter-spacing: -.01em;
    transition: background-color .13s ease-out, border-color .13s ease-out, transform .08s ease-out;
  }
  button.ghost { background: transparent; color: var(--accent); border-color: var(--edge); }
  button.small { padding: .3rem .7rem; font-size: .85rem; }
  button:hover:not(:disabled) { background: color-mix(in oklab, var(--accent) 88%, var(--ink)); }
  button.ghost:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:disabled { opacity: .5; cursor: progress; }
  .row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; margin-top: .9rem; }

  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0 1.4rem; margin: 0; }
  dt { color: var(--dim); }
  dd { margin: 0; overflow-wrap: anywhere; }
  dd.mono { font-size: .87rem; }
  .facts dt, .facts dd { padding: .46rem 0; border-top: 1px solid var(--line); }
  .facts dt:first-of-type, .facts dt:first-of-type + dd { border-top: 0; }
  .facts dd .frac { color: var(--dim); }
  .tag { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem;
         font-weight: 620; border: 1px solid currentColor; line-height: 1.5; }
  .yes { color: var(--ok); }
  .no  { color: var(--no); }
  .note { border-left: 1px solid var(--edge); padding: .1rem 0 .1rem 1.1rem; margin: 1.2rem 0 0;
          color: var(--dim); font-size: .92rem; max-width: 68ch; }
  .note code { color: var(--ink); }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .58rem .75rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 620; }
  th:first-child, td:first-child { padding-left: 0; }
  footer { margin-top: 4.5rem; padding-top: 1.5rem; border-top: 1px solid var(--line);
           color: var(--dim); font-size: .88rem; }
  footer a { color: var(--dim); text-decoration-color: var(--edge); }
  footer a:hover { color: var(--accent); text-decoration-color: currentColor; }
  .muted { color: var(--dim); }
  .small { font-size: .85rem; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  .spin { display: grid; gap: .6rem; padding: .35rem 0; }
  .spin i { display: block; height: .8rem; border-radius: 5px; background: var(--raise); border: 1px solid var(--line); }
  .err { color: var(--no); margin: 0 0 .5rem; }

  .cols { display: grid; gap: 0 2.5rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); }
  .cols > section { padding: 1.1rem 0 1.4rem; border-top: 1px solid var(--line); }
  .cols > section > h3 { margin: 0 0 .3rem; }
  .cols .lead { color: var(--dim); font-size: .9rem; margin: 0 0 .9rem; max-width: 46ch; }
  .reach { display: grid; gap: .7rem 1.8rem; grid-template-columns: max-content 1fr; margin: 0; }
  .reach dt { font-weight: 620; color: var(--ink); }
  .reach dd { margin: 0; color: var(--dim); font-size: .92rem; }
  .reach dd code { color: var(--ink); font-size: .82rem; }
  .scroll { overflow-x: auto; }

  /* The comparison carries the whole argument, so it gets the page's one authored moment. */
  .bars { display: grid; gap: 1rem; margin: 1.6rem 0 .6rem; }
  .bar { display: grid; grid-template-columns: 11rem 1fr 11rem; gap: 1.25rem; align-items: center; font-size: .92rem; }
  .bar .track { height: 1.5rem; background: var(--code); border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
  .bar .fill { height: 100%; border-radius: 6px; animation: fill 1.1s cubic-bezier(.16,1,.3,1) both; }
  .bar .fill.yes { background: linear-gradient(90deg, color-mix(in oklab, var(--ok) 78%, var(--bg)), var(--ok)); }
  .bar .fill.no  { background: linear-gradient(90deg, color-mix(in oklab, var(--no) 78%, var(--bg)), var(--no)); }
  .bar .n { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-variant-numeric: tabular-nums; font-size: 1rem; }
  @keyframes fill { from { width: 0; } }
  @media (prefers-reduced-motion: reduce) { .bar .fill { animation: none; } }
  .compare { margin-top: 1.1rem; }
  .compare td:first-child { color: var(--dim); }
  .compare .mono { font-size: 1rem; }

  .ins { margin-top: 1.2rem; font-size: .85rem; }
  .ins caption { text-align: left; color: var(--dim); font-size: .88rem; padding: 0 0 .5rem; }
  .ins td { padding: .34rem .7rem; border-bottom: 1px solid var(--line); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .ins tr:last-child td { border-bottom: 0; }
  .ins .off { color: var(--dim); text-align: right; width: 3rem; padding-left: 0; font-variant-numeric: tabular-nums; }
  .ins .nm { font-weight: 620; white-space: nowrap; }
  .ins .args { color: var(--dim); font-size: .78rem; overflow-wrap: anywhere; padding-right: 0; }

  .try { margin-top: 1.5rem; padding-top: 1.15rem; border-top: 1px solid var(--line); }
  .panel label { display: block; font-weight: 620; margin-bottom: .45rem; }
  .try input { width: 12rem; }
  .try .row { margin-top: 0; }
  .try p { margin: .7rem 0 0; }
  .live-hint { font-size: .85rem; color: var(--dim); margin: .7rem 0 0; }

  .alerts { list-style: none; margin: 1.1rem 0 0; padding: 0; display: grid; gap: .45rem; font-size: .92rem; }
  .alerts code { color: var(--dim); font-size: .82rem; }
  .health { margin-top: 1.1rem; font-size: .9rem; }
  .health caption { text-align: left; padding: 0 0 .5rem; color: var(--dim); }
  .health td, .health th { white-space: nowrap; }

  @media (max-width: 46rem) {
    .top { padding-top: 2.25rem; padding-bottom: 1.75rem; }
    h2 { margin-top: 3.25rem; font-size: 1.2rem; }
    .bar { grid-template-columns: 1fr; }
    .bar { grid-template-columns: 1fr; gap: .35rem; }
    .bar .n { text-align: left; }
    .reach { grid-template-columns: 1fr; gap: .1rem 0; }
    .reach dd { margin-bottom: .8rem; }
    th, td { padding: .5rem .5rem; }
    th:first-child, td:first-child { padding-left: 0; }
    .facts { grid-template-columns: 1fr; gap: 0; }
    .facts dt { padding-bottom: 0; }
    .facts dd { border-top: 0; padding-top: .1rem; }
    .facts dt:first-of-type + dd { border-top: 0; }
    .cost thead { display: none; }
    .cost tr { display: grid; grid-template-columns: 1fr auto; gap: 0 .8rem; border-bottom: 1px solid var(--line); padding: .65rem 0; }
    .cost td { border: 0; padding: 0; }
    .cost td:nth-child(2) { grid-row: 2; grid-column: 1 / -1; color: var(--dim); font-size: .88rem; }
    .cost td:nth-child(3) { grid-row: 1; grid-column: 2; text-align: right; }
    .ins .args, .ins .args-h { display: none; }
  }
  main > h2:first-child { border-top: 0; margin-top: 2.75rem; padding-top: 0; }
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <h1>Batas</h1>
    <p class="lede">
      <em>Batas</em> is Indonesian for <strong>mandate</strong>: authority entrusted within limits
      that must not be exceeded. An autonomous agent can run a liquidity position here. It cannot
      exceed the terms it was granted, because the only contract allowed to touch the maker's tokens
      refuses to settle a swap that breaks them.
    </p>
  </div>
</header>
<main>

  <h2>What a mandate is worth</h2>
  <p>
    The same attacker against the same reserves, twice — once under a mandate, once under a position
    identical in every other way, with nothing that refuses. The pool opens at 2.0 with 2000 tokenB;
    the bars are what was left.
  </p>
  <div class="bars">
    <div class="bar">
      <div>under a mandate</div>
      <div class="track"><div class="fill yes" style="width:83.4%"></div></div>
      <div class="n">1667.53 <span class="muted">· 83%</span></div>
    </div>
    <div class="bar">
      <div>with none</div>
      <div class="track"><div class="fill no" style="width:13.6%"></div></div>
      <div class="n">271.86 <span class="muted">· 14%</span></div>
    </div>
  </div>
  <table class="compare">
    <thead><tr><th scope="col"><span class="sr">position</span></th><th scope="col">trades before it stopped</th><th scope="col">average rate</th></tr></thead>
    <tbody>
      <tr><td>under a mandate</td><td class="mono">2</td><td class="mono yes">1.662<span class="sr"> (held the floor)</span></td></tr>
      <tr><td>with none</td><td class="mono">64</td><td class="mono no">0.270<span class="sr"> (no floor)</span></td></tr>
    </tbody>
  </table>
  <p class="note">
    Every one of the sixty-four was an ordinary constant-product swap that no application-layer
    check was there to stop. The guard that stopped the other run costs 975 gas, measured with
    both positions warm. Reproducible:
    <code>forge test --match-test test_WhatTheMandateIsWorth -vv</code>.
  </p>

  <h2>Decode a mandate</h2>
  <p>
    A Batas position states its terms only as SwapVM bytecode. Paste a program and this reads what
    it actually enforces — the cap, the floor, the expiry, and whether the policy guard sits in the
    outermost position where nothing can undo it. This costs nothing: it is arithmetic on bytes you
    already hold.
  </p>
  <div class="panel">
    <label for="prog">SwapVM program, hex</label>
    <textarea id="prog" spellcheck="false" aria-describedby="prog-hint" placeholder="0x2120…  — leave empty to read the live position on Sepolia"></textarea>
    <div class="row">
      <button id="go">Decode</button>
      <button id="live" class="ghost">Back to the live position</button>
      <span id="status" class="muted" role="status"></span>
    </div>
    <div id="out" hidden style="margin-top:1.2rem" aria-live="polite"></div>
    <div id="try" class="try" hidden>
      <label for="amt">Try an input amount, in <span id="tryTok">token A</span></label>
      <div class="row">
        <input id="amt" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 5">
        <span id="tryOut" aria-live="polite"></span>
      </div>
      <p class="muted small">
        Arithmetic against the cap above, not a quote. The floor is judged at settlement on the live
        reserves, which these bytes do not carry, so this cannot say whether an amount clears it.
      </p>
    </div>
  </div>
  <p class="live-hint" id="prog-hint">The live position decodes as the page loads. Paste anything else to read that instead.</p>

  <section id="health" hidden aria-busy="true">
    <h2>This morning</h2>
    <p>
      The terms against the market the position is actually in: how much room the floor has left,
      what one trade at the cap could take, and every trade since the ship. Read from Sepolia as
      this page loads.
    </p>
    <div id="healthOut" class="panel"></div>
  </section>

  <h2>The live position</h2>
  <p>
    Read from Sepolia, Hedera Consensus Service and an ENSv2 registry as this page loads. Nothing
    below is stored here; every value is fetched from a chain or a public mirror node when you ask
    for it.
  </p>
  <div class="cols">
    <section>
      <h3>Publication</h3>
      <p class="lead">When these exact bytes became public, from an ordering service none of the parties runs.</p>
      <div id="pub" class="spin" aria-busy="true"><span class="sr">reading the mirror node</span><i style="width:78%"></i><i style="width:38%"></i><i style="width:55%"></i></div>
    </section>
    <section>
      <h3>Kill switch</h3>
      <p class="lead">The agent's ENSv2 subname: expiring, revocable, soulbound. Compiled into the program, so the settlement itself refuses when it is gone.</p>
      <div id="auth" class="spin" aria-busy="true"><span class="sr">reading the registry</span><i style="width:30%"></i><i style="width:24%"></i><i style="width:62%"></i><i style="width:78%"></i></div>
    </section>
    <section>
      <h3>Reputation</h3>
      <p class="lead">What counterparties wrote after trading, from ERC-8004. The registry refuses feedback from the agent itself.</p>
      <div id="rep" class="spin" aria-busy="true"><span class="sr">reading the registry</span><i style="width:58%"></i><i style="width:70%"></i><i style="width:36%"></i></div>
    </section>
  </div>

  <h2>What costs money, and why</h2>
  <p>
    Four of the five questions are free, and they are free for a reason: a caller holding the
    bytes can answer them without trusting anyone, so charging for them would be charging for
    arithmetic. The fifth is the one a stranger cannot assemble alone.
  </p>
  <div class="scroll">
  <table class="cost">
    <thead><tr><th scope="col">Question</th><th scope="col">Where the answer comes from</th><th scope="col">Cost</th></tr></thead>
    <tbody>
      <tr><td>What do these bytes permit?</td><td>the bytes themselves</td><td class="yes">free</td></tr>
      <tr><td>When did they become public?</td><td>Hedera Consensus Service, via a public mirror node</td><td class="yes">free</td></tr>
      <tr><td>May the agent still act?</td><td>the ENSv2 registry on Sepolia</td><td class="yes">free</td></tr>
      <tr><td>What do counterparties say?</td><td>ERC-8004's reputation registry, which refuses the agent's own voice</td><td class="yes">free</td></tr>
      <tr>
        <td>Who is operating this, and does their identity vouch for the maker?</td>
        <td>ERC-8004 identity registry, joined to the two answers above</td>
        <td><strong>${price} HBAR</strong></td>
      </tr>
    </tbody>
  </table>
  </div>
  <p class="note">
    The paid route answers <code>402</code> with a payment requirement, the caller settles over
    x402 on <code>${network}</code> through the ${facilitator.split('//').pop()}
    facilitator, and retries. No key, no account, no subscription — the payment is the
    authentication.
  </p>
  <pre style="margin-top:1rem"># the whole thing, free steps first, then one that pays
git clone https://github.com/PugarHuda/batas &amp;&amp; cd batas &amp;&amp; npm install
npm run walkthrough
npm run walkthrough -- --paid</pre>

  <h2>Reachable by software that has never heard of it</h2>
  <dl class="reach">
    <dt>x402 discovery</dt>
    <dd>An indexer learns what this host sells and what it costs without being told the paid URL.
      <a class="mono" href="/.well-known/x402">/.well-known/x402</a></dd>
    <dt>MCP</dt>
    <dd>Four tools for an assistant: three free, one that says <code>THIS SPENDS MONEY</code>. Reputation is over HTTP only.
      <code>claude mcp add batas -- node agent/mcp.mjs</code></dd>
    <dt>HTTP, free</dt>
    <dd>Five free routes: the three free MCP questions, plus reputation and the position's health report.
      <code>POST /v1/mandate/decode · POST /v1/mandate/publication · GET /v1/agent/authority · GET /v1/agent/reputation</code></dd>
  </dl>

  <footer>
    <a href="https://github.com/PugarHuda/batas" rel="noopener">source</a> ·
    <a href="https://hashscan.io/testnet/topic/${topic}" rel="noopener">mandate topic ${topic}</a> ·
    <a href="https://hashscan.io/testnet/account/${payTo}" rel="noopener">paid account ${payTo}</a> ·
    <a href="/?format=json">this page as JSON</a>
    <p style="margin-top:.8rem">
      Sepolia and Hedera testnet. Nothing here is advertised that cannot be checked.
    </p>
    <p class="small">Powered by SwapVM — © Degensoft Ltd 2025 · Powered by Aqua — © Degensoft Ltd 2025</p>
  </footer>
</main>

<script>
const $ = (id) => document.getElementById(id);
${asBrowserSource()}

async function post(path, body) {
    return answer(await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    }));
}

async function get(path) { return answer(await fetch(path)); }

// A non-2xx with a JSON body is still a failure, and a column must say so rather than render it.
async function answer(res) {
    const json = await res.json().catch(() => ({ error: 'the service answered something that was not JSON' }));
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
}

// The terms currently on screen, for the amount box; the live position's, for the authority card.
// They differ the moment someone pastes something else.
let shown = null;
let liveTerms = null;

function judge() {
    const j = judgeAmount(shown, $('amt').value);
    $('tryOut').textContent = j ? j.text : '';
    $('tryOut').className = j ? (j.verdict === 'inside' ? 'yes' : j.verdict === 'over' ? 'no' : 'muted') : '';
}

async function decode(program) {
    $('status').textContent = 'reading…';
    $('go').disabled = true;
    try {
        const answer = await post('/v1/mandate/decode', program ? { program } : {});
        shown = answer.mandate || null;
        if (!program) liveTerms = shown;
        $('out').innerHTML = renderMandate(answer);
        $('out').hidden = false;
        $('tryTok').textContent = shown && shown.direction === 'bToA' ? 'token B' : 'token A';
        $('try').hidden = false;
        judge();
        $('status').textContent = program ? 'decoded the pasted program' : 'decoded the live position on Sepolia';
        if (!program && answer.program) $('prog').value = answer.program;
        return answer;
    } catch (e) {
        $('out').innerHTML = '<p class="err">' + esc(e.message) + '</p><p class="muted small">Check the bytes are a whole SwapVM program, or clear the box to read the live position.</p>';
        $('out').hidden = false;
        $('try').hidden = true;
        $('status').textContent = '';
    } finally {
        $('go').disabled = false;
    }
}

$('go').addEventListener('click', () => decode($('prog').value.trim()));
$('live').addEventListener('click', () => { $('prog').value = ''; decode(''); });
$('amt').addEventListener('input', judge);

// The page is about the live position, so it reads it without being asked. The decoded terms are
// kept because the authority card needs to know whether the name is compiled in — that is the
// difference between a control the agent obeys and one the settlement obeys.
const liveDecode = decode('');

// A column that could not be read says what failed and offers the one recovery there is.
function fail(id, what, e, again) {
    const el = $(id);
    el.classList.remove('spin');
    el.removeAttribute('aria-busy');
    el.innerHTML = '<p class="err">could not read ' + what + ': ' + esc(e.message) + '</p>';
    const b = document.createElement('button');
    b.className = 'ghost small';
    b.textContent = 'try again';
    b.addEventListener('click', again);
    el.appendChild(b);
}

function show(id, html) {
    const el = $(id);
    el.classList.remove('spin');
    el.removeAttribute('aria-busy');
    el.innerHTML = html;
}

async function loadPub() {
    try {
        const p = await post('/v1/mandate/publication', {});
        show('pub', p.published
            ? '<dl class="facts"><dt>published</dt><dd class="mono">' + when(p.publishedAt ?? p.consensusTimestamp)
              + '</dd><dt>sequence</dt><dd class="mono">#' + esc(p.sequenceNumber ?? '?')
              + '</dd><dt>topic</dt><dd class="mono">' + esc(p.topic ?? '?')
              + '</dd></dl>' + link(p.mirror, 'verify on the mirror node')
            : '<span class="no">' + esc(p.reason || 'no record of these bytes on the topic') + '</span>');
    } catch (e) {
        fail('pub', 'the mirror node', e, loadPub);
    }
}

async function loadAuth() {
    try {
        const a = await get('/v1/agent/authority');
        await liveDecode;
        const tag = a.valid ? '<span class="tag yes">held</span>' : '<span class="tag no">' + (a.revoked ? 'revoked' : 'expired') + '</span>';
        const enforced = liveTerms && liveTerms.killSwitch
            ? '<span class="tag yes">on chain</span> <span class="muted">revocation reverts the swap for every caller</span>'
            : '<span class="muted">by the agent only — nothing on chain reads this name</span>';
        show('auth', '<dl class="facts"><dt>mandate name</dt><dd class="mono">' + esc(a.label ?? '—')
            + '</dd><dt>status</dt><dd>' + tag + '</dd><dt>reason</dt><dd>' + esc(a.reason ?? '—')
            + '</dd>' + (a.expiry ? '<dt>expires</dt><dd class="mono">'
            + when(new Date(a.expiry * 1000).toISOString()) + '</dd>' : '')
            + '<dt>enforced</dt><dd>' + enforced + '</dd></dl>');
    } catch (e) {
        fail('auth', 'the registry', e, loadAuth);
    }
}

async function loadRep() {
    try {
        const r = await get('/v1/agent/reputation');
        if (!r.feedbackCount) {
            show('rep', '<p class="muted" style="margin:0">No counterparty feedback yet. The first counterparty to settle a trade against this position writes the first entry, and it is scored on where the trade landed against the floor.</p>');
            return;
        }
        const avg = Number(r.summaryValue);
        const verdict = avg >= 0
            ? '<span class="tag yes">floor honoured</span>'
            : '<span class="tag no">floor breached</span>';
        show('rep', '<dl class="facts"><dt>feedback</dt><dd class="mono">' + esc(r.feedbackCount)
            + ' from ' + esc(r.clientCount) + ' counterpart' + (r.clientCount === 1 ? 'y' : 'ies')
            + '</dd><dt>average</dt><dd class="mono">' + esc(r.summaryValue) + ' bps above the floor</dd>'
            + '<dt>verdict</dt><dd>' + verdict + '</dd></dl>'
            + '<p class="muted small" style="margin:.7rem 0 0">Not a rating: how far above its '
            + 'advertised floor each trade actually settled, redoable from the transaction.</p>');
    } catch (e) {
        fail('rep', 'the registry', e, loadRep);
    }
}

// The morning report is a route this host may not serve yet. A route that does not exist is not
// an error to show, so the section stays hidden until there is something to put in it.
async function loadHealth() {
    try {
        const h = await get('/v1/position/health');
        $('healthOut').innerHTML = renderHealth(h);
        $('health').removeAttribute('aria-busy');
        $('health').hidden = false;
    } catch { /* stays hidden */ }
}

loadPub();
loadAuth();
loadRep();
loadHealth();
</script>
</body>
</html>`;
}
