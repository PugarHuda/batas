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
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbf9;
    --panel: #ffffff;
    --ink: #16150f;
    --dim: #6b6862;
    --line: #e4e1d9;
    --accent: #7a3e12;
    --ok: #1f6b3a;
    --no: #9b2226;
    --code: #f4f2ec;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131311;
      --panel: #1b1b18;
      --ink: #eceae3;
      --dim: #9b978d;
      --line: #2e2d28;
      --accent: #d99a5b;
      --ok: #6fc08c;
      --no: #e0776f;
      --code: #232320;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 62rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
  h1 { font-size: 2.1rem; letter-spacing: -0.02em; margin: 0 0 .35rem; }
  h2 { font-size: 1.05rem; letter-spacing: .04em; text-transform: uppercase; color: var(--dim);
       margin: 2.75rem 0 .9rem; font-weight: 600; }
  p { margin: 0 0 1rem; max-width: 46rem; }
  a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  .lede { font-size: 1.12rem; color: var(--dim); max-width: 44rem; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1.25rem 1.35rem; }
  .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); }
  code, pre, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px;
        padding: .85rem 1rem; overflow-x: auto; font-size: .82rem; margin: 0; }
  textarea {
    width: 100%; min-height: 5.5rem; resize: vertical; padding: .8rem .9rem;
    background: var(--code); color: var(--ink); border: 1px solid var(--line); border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .82rem;
  }
  button {
    font: inherit; font-weight: 600; cursor: pointer; padding: .55rem 1.1rem; border-radius: 8px;
    border: 1px solid var(--accent); background: var(--accent); color: var(--bg);
  }
  button.ghost { background: transparent; color: var(--accent); }
  button:disabled { opacity: .55; cursor: progress; }
  .row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; margin-top: .8rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1.1rem; margin: 0; }
  dt { color: var(--dim); }
  dd { margin: 0; overflow-wrap: anywhere; }
  dd.mono { font-size: .87rem; }
  .tag { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem;
         font-weight: 600; border: 1px solid currentColor; }
  .yes { color: var(--ok); }
  .no  { color: var(--no); }
  .note { border-left: 3px solid var(--accent); padding: .5rem 0 .5rem .9rem; margin: .7rem 0 0;
          color: var(--dim); font-size: .92rem; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .55rem .7rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 600; }
  footer { margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line);
           color: var(--dim); font-size: .88rem; }
  .muted { color: var(--dim); }
  .spin::after { content: "…"; }
  .stats { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
           margin: 1.6rem 0 .4rem; }
  .stat { border: 1px solid var(--line); border-radius: 10px; padding: .9rem 1.1rem; background: var(--panel); }
  .stat b { display: block; font-size: 1.6rem; letter-spacing: -0.02em; line-height: 1.15; }
  .stat span { color: var(--dim); font-size: .85rem; }
  .bars { display: grid; gap: .9rem; margin-top: 1rem; }
  .bar { display: grid; grid-template-columns: 9rem 1fr 6rem; gap: .8rem; align-items: center; font-size: .9rem; }
  .bar .track { height: 1.1rem; background: var(--code); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .bar .fill { height: 100%; border-radius: 5px; }
  .bar .fill.yes { background: var(--ok); }
  .bar .fill.no { background: var(--no); }
  .bar .n { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .live-hint { font-size: .85rem; color: var(--dim); margin: -.4rem 0 1rem; }
  @media (max-width: 40rem) {
    .bar { grid-template-columns: 1fr; gap: .3rem; }
    .bar .n { text-align: left; }
    h1 { font-size: 1.7rem; }
  }
</style>
</head>
<body>
<main>
  <h1>Batas</h1>
  <p class="lede">
    <em>Batas</em> is Indonesian for <strong>mandate</strong>: authority entrusted within limits
    that must not be exceeded. An autonomous agent can run a liquidity position here. It cannot
    exceed the terms it was granted, because the only contract allowed to touch the maker's tokens
    refuses to settle a swap that breaks them.
  </p>

  <div class="stats">
    <div class="stat"><b>933 gas</b><span>what the guard costs, measured with both positions warm</span></div>
    <div class="stat"><b>83% vs 14%</b><span>reserve left after the same attacker, with and without a mandate</span></div>
    <div class="stat"><b>2 instructions</b><span>added to SwapVM: a wrapping guard, and a name the settlement obeys</span></div>
    <div class="stat"><b>${price} HBAR</b><span>for the one answer a stranger cannot compute alone</span></div>
  </div>

  <h2>What a mandate is worth</h2>
  <p>
    The same attacker against the same reserves, twice — once under a mandate, once under a position
    identical in every other way, with nothing that refuses. The pool opens at 2.0.
  </p>
  <div class="panel">
    <div class="bars">
      <div class="bar">
        <div>under a mandate</div>
        <div class="track"><div class="fill yes" style="width:83.4%"></div></div>
        <div class="n">1667.53 left</div>
      </div>
      <div class="bar">
        <div>with none</div>
        <div class="track"><div class="fill no" style="width:13.6%"></div></div>
        <div class="n">271.86 left</div>
      </div>
    </div>
    <table style="margin-top:1.1rem">
      <thead><tr><th></th><th>trades before it stopped</th><th>average rate</th><th>of 2000 tokenB</th></tr></thead>
      <tbody>
        <tr><td>under a mandate</td><td class="mono">2</td><td class="mono yes">1.662</td><td class="mono">83%</td></tr>
        <tr><td>with none</td><td class="mono">64</td><td class="mono no">0.270</td><td class="mono">14%</td></tr>
      </tbody>
    </table>
    <p class="note">
      Every one of the sixty-four was an ordinary constant-product swap that no application-layer
      check was there to stop. Reproducible:
      <code>forge test --match-test test_WhatTheMandateIsWorth -vv</code>.
    </p>
  </div>

  <h2>Decode a mandate</h2>
  <p>
    A Batas position states its terms only as SwapVM bytecode. Paste a program and this reads what
    it actually enforces — the cap, the floor, the expiry, and whether the policy guard sits in the
    outermost position where nothing can undo it. This costs nothing: it is arithmetic on bytes you
    already hold.
  </p>
  <div class="panel">
    <textarea id="prog" spellcheck="false" placeholder="0x2120…  — leave empty to read the live position on Sepolia"></textarea>
    <div class="row">
      <button id="go">Decode</button>
      <button id="live" class="ghost">Use the live position</button>
      <span id="status" class="muted"></span>
    </div>
    <div id="out" hidden style="margin-top:1.2rem"></div>
  </div>
  <p class="live-hint">The live position decodes as the page loads. Paste anything else to read that instead.</p>

  <h2>The live position</h2>
  <p>
    Read from Sepolia, Hedera Consensus Service and an ENSv2 registry as this page loads. Nothing
    below is stored here; every value is fetched from a chain or a public mirror node when you ask
    for it.
  </p>
  <div class="grid">
    <div class="panel">
      <strong>Publication</strong>
      <p class="muted" style="font-size:.9rem;margin:.4rem 0 .8rem">
        When these exact bytes became public, from an ordering service none of the parties runs.
      </p>
      <div id="pub" class="spin muted">reading the mirror node</div>
    </div>
    <div class="panel">
      <strong>Authority</strong>
      <p class="muted" style="font-size:.9rem;margin:.4rem 0 .8rem">
        The agent's ENSv2 subname: expiring, revocable, soulbound. Compiled into the program, so the
        settlement itself refuses when it is gone.
      </p>
      <div id="auth" class="spin muted">reading the registry</div>
    </div>
    <div class="panel">
      <strong>Reputation</strong>
      <p class="muted" style="font-size:.9rem;margin:.4rem 0 .8rem">
        What counterparties wrote after trading, from ERC-8004. The registry refuses feedback from
        the agent itself.
      </p>
      <div id="rep" class="spin muted">reading the registry</div>
    </div>
  </div>

  <h2>What costs money, and why</h2>
  <p>
    Four of the five questions are free, and they are free for a reason: a caller holding the
    bytes can answer them without trusting anyone, so charging for them would be charging for
    arithmetic. The fifth is the one a stranger cannot assemble alone.
  </p>
  <table>
    <thead><tr><th>Question</th><th>Where the answer comes from</th><th>Cost</th></tr></thead>
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
  <p class="note">
    The paid route answers <code>402</code> with a payment requirement, the caller settles over
    x402 on <code>${network}</code> through the ${facilitator.split('//').pop()}
    facilitator, and retries. No key, no account, no subscription — the payment is the
    authentication.
  </p>
  <pre># the whole thing, free steps first, then one that pays
git clone https://github.com/PugarHuda/batas &amp;&amp; cd batas &amp;&amp; npm install
npm run walkthrough
npm run walkthrough -- --paid</pre>

  <h2>Reachable by software that has never heard of it</h2>
  <div class="grid">
    <div class="panel">
      <strong>x402 discovery</strong>
      <p class="muted" style="font-size:.9rem;margin:.4rem 0 .6rem">
        An indexer learns what this host sells and what it costs without being told the paid URL.
      </p>
      <a class="mono" href="/.well-known/x402">/.well-known/x402</a>
    </div>
    <div class="panel">
      <strong>MCP</strong>
      <p class="muted" style="font-size:.9rem;margin:.4rem 0 .6rem">
        Four tools for an assistant; three free, one that says <code>THIS SPENDS MONEY</code>.
      </p>
      <code style="font-size:.8rem">claude mcp add batas -- node agent/mcp.mjs</code>
    </div>
    <div class="panel">
      <strong>HTTP, free</strong>
      <p class="muted" style="font-size:.9rem;margin:.4rem 0 .6rem">
        The same questions, at parity with the MCP tools, plus reputation.
      </p>
      <code style="font-size:.8rem">POST /v1/mandate/decode<br>POST /v1/mandate/publication<br>GET&nbsp; /v1/agent/authority<br>GET&nbsp; /v1/agent/reputation</code>
    </div>
  </div>

  <footer>
    <a href="https://github.com/PugarHuda/batas">source</a> ·
    <a href="https://hashscan.io/testnet/topic/${topic}">mandate topic ${topic}</a> ·
    <a href="https://hashscan.io/testnet/account/${payTo}">paid account ${payTo}</a> ·
    <a href="/?format=json">this page as JSON</a>
    <p style="margin-top:.8rem">
      Sepolia and Hedera testnet. Nothing here is advertised that cannot be checked.
    </p>
  </footer>
</main>

<script>
const $ = (id) => document.getElementById(id);
${asBrowserSource()}

async function post(path, body) {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => ({ error: 'the service answered something that was not JSON' }));
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
}

async function decode(program) {
    $('status').textContent = 'reading…';
    $('go').disabled = true;
    try {
        const answer = await post('/v1/mandate/decode', program ? { program } : {});
        $('out').innerHTML = renderMandate(answer);
        $('out').hidden = false;
        $('status').textContent = program ? '' : 'decoded the live position on Sepolia';
        if (!program && answer.program) $('prog').value = answer.program;
    } catch (e) {
        $('out').innerHTML = '<p class="no">' + esc(e.message) + '</p>';
        $('out').hidden = false;
        $('status').textContent = '';
    } finally {
        $('go').disabled = false;
    }
}

$('go').addEventListener('click', () => decode($('prog').value.trim()));
$('live').addEventListener('click', () => { $('prog').value = ''; decode(''); });

// The page is about the live position, so it reads it without being asked. The decoded terms are
// kept because the authority card needs to know whether the name is compiled in — that is the
// difference between a control the agent obeys and one the settlement obeys.
let liveTerms = null;
const liveDecode = (async () => {
    try {
        const answer = await post('/v1/mandate/decode', {});
        liveTerms = answer.mandate || null;
        $('out').innerHTML = renderMandate(answer);
        $('out').hidden = false;
        $('status').textContent = 'decoded the live position on Sepolia';
        if (answer.program) $('prog').value = answer.program;
    } catch (e) {
        $('status').textContent = 'could not read the live position: ' + e.message;
    }
})();

(async () => {
    try {
        const p = await post('/v1/mandate/publication', {});
        $('pub').classList.remove('spin', 'muted');
        $('pub').innerHTML = p.published
            ? '<dl><dt>published</dt><dd class="mono">' + esc(p.publishedAt ?? p.consensusTimestamp)
              + '</dd><dt>sequence</dt><dd class="mono">#' + esc(p.sequenceNumber ?? '?')
              + '</dd><dt>topic</dt><dd class="mono">' + esc(p.topic ?? '?')
              + '</dd></dl>' + link(p.mirror, 'verify on the mirror node')
            : '<span class="no">' + esc(p.reason || 'no record of these bytes on the topic') + '</span>';
    } catch (e) {
        $('pub').classList.remove('spin');
        $('pub').textContent = 'could not read the mirror node: ' + e.message;
    }
})();

(async () => {
    try {
        const a = await (await fetch('/v1/agent/authority')).json();
        await liveDecode;
        $('auth').classList.remove('spin', 'muted');
        const tag = a.valid ? '<span class="tag yes">live</span>' : '<span class="tag no">stopped</span>';
        const enforced = liveTerms && liveTerms.killSwitch
            ? '<span class="tag yes">on chain</span> <span class="muted">revocation reverts the swap for every caller</span>'
            : '<span class="muted">by the agent only — nothing on chain reads this name</span>';
        $('auth').innerHTML = '<dl><dt>name</dt><dd class="mono">' + esc(a.label ?? '—')
            + '</dd><dt>status</dt><dd>' + tag + '</dd><dt>reason</dt><dd>' + esc(a.reason ?? '—')
            + '</dd>' + (a.expiry ? '<dt>expires</dt><dd class="mono">'
            + esc(new Date(a.expiry * 1000).toISOString()) + '</dd>' : '')
            + '<dt>enforced</dt><dd>' + enforced + '</dd></dl>';
    } catch (e) {
        $('auth').classList.remove('spin');
        $('auth').textContent = 'could not read the registry: ' + e.message;
    }
})();

(async () => {
    try {
        const r = await (await fetch('/v1/agent/reputation')).json();
        $('rep').classList.remove('spin', 'muted');
        if (!r.feedbackCount) {
            $('rep').innerHTML = '<span class="muted">no client feedback yet</span>';
            return;
        }
        const avg = Number(r.summaryValue);
        const verdict = avg >= 0
            ? '<span class="tag yes">floor honoured</span>'
            : '<span class="tag no">floor breached</span>';
        $('rep').innerHTML = '<dl><dt>feedback</dt><dd class="mono">' + esc(r.feedbackCount)
            + ' from ' + esc(r.clientCount) + ' client' + (r.clientCount === 1 ? '' : 's')
            + '</dd><dt>average</dt><dd class="mono">' + esc(r.summaryValue) + ' bps above the floor</dd>'
            + '<dt>verdict</dt><dd>' + verdict + '</dd></dl>'
            + '<p class="muted" style="font-size:.85rem;margin:.7rem 0 0">Not a rating: how far above its '
            + 'advertised floor each trade actually settled, redoable from the transaction.</p>';
    } catch (e) {
        $('rep').classList.remove('spin');
        $('rep').textContent = 'could not read the registry: ' + e.message;
    }
})();
</script>
</body>
</html>`;
}
