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
        The agent's ENSv2 subname: expiring, revocable, soulbound. It checks this before it acts.
      </p>
      <div id="auth" class="spin muted">reading the registry</div>
    </div>
  </div>

  <h2>What costs money, and why</h2>
  <p>
    Three of the four questions are free, and they are free for a reason: a caller holding the
    bytes can answer them without trusting anyone, so charging for them would be charging for
    arithmetic. The fourth is the one a stranger cannot assemble alone.
  </p>
  <table>
    <thead><tr><th>Question</th><th>Where the answer comes from</th><th>Cost</th></tr></thead>
    <tbody>
      <tr><td>What do these bytes permit?</td><td>the bytes themselves</td><td class="yes">free</td></tr>
      <tr><td>When did they become public?</td><td>Hedera Consensus Service, via a public mirror node</td><td class="yes">free</td></tr>
      <tr><td>May the agent still act?</td><td>the ENSv2 registry on Sepolia</td><td class="yes">free</td></tr>
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
        The same three questions, at parity with the MCP tools.
      </p>
      <code style="font-size:.8rem">POST /v1/mandate/decode<br>POST /v1/mandate/publication<br>GET&nbsp; /v1/agent/authority</code>
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
        $('auth').classList.remove('spin', 'muted');
        const tag = a.valid ? '<span class="tag yes">live</span>' : '<span class="tag no">stopped</span>';
        $('auth').innerHTML = '<dl><dt>name</dt><dd class="mono">' + esc(a.label ?? '—')
            + '</dd><dt>status</dt><dd>' + tag + '</dd><dt>reason</dt><dd>' + esc(a.reason ?? '—')
            + '</dd>' + (a.expiry ? '<dt>expires</dt><dd class="mono">'
            + esc(new Date(a.expiry * 1000).toISOString()) + '</dd>' : '') + '</dl>';
    } catch (e) {
        $('auth').classList.remove('spin');
        $('auth').textContent = 'could not read the registry: ' + e.message;
    }
})();
</script>
</body>
</html>`;
}
