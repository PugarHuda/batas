// The landing: for a maker or counterparty deciding whether this is safe to trust with money.
//
// The app at /app is the instrument; this page is the case for it. It says one thing and proves it:
// the limit is enforced by the contract, not by the agent's good behaviour. The envelope in the
// first viewport is drawn from the live position's own reserves and terms, read from the free
// health route as the page loads, and the attack comparison is the measured result of a forge test.
// Nothing on it is illustrative.
//
// It never names the paid route — qa/service.spec.mjs holds the page to reaching only free answers.

import { FONT_FACES, TOKENS, BASE, FAVICON, topBar, foot } from './world.mjs';
import { surfaceSource, HOL_LISTING, HTS_TOKEN_ID } from './surface-render.mjs';

// The linework behind the hero, drawn the way a sectional chart draws it: a VOR compass rose ticked
// every 5 degrees (longer every 10, longest every 30) and turned off true north, as a rose is printed
// against magnetic north; a solid Class C ring with its soft shelf band and a dashed Class E surface
// ring in airspace magenta; and a meridian and a parallel with the chart's minute ticks. It carries no
// labels and no numbers, so it cannot be read as a claim about a place. Built once, at module load.
const HERO_CHART = (() => {
    const C = 380, R = 150;
    const at = (deg, r) => {
        const a = (deg * Math.PI) / 180;
        return (C + r * Math.sin(a)).toFixed(1) + ' ' + (C - r * Math.cos(a)).toFixed(1);
    };
    let rose = '';
    for (let d = 0; d < 360; d += 5) rose += 'M' + at(d, R) + 'L' + at(d, R - (d % 30 === 0 ? 16 : d % 10 === 0 ? 10 : 6));
    let grat = 'M0 ' + C + 'H760M' + C + ' 0V760';
    for (let i = 0; i <= 760; i += 16) {
        const len = i % 80 === 0 ? 8 : 4;
        grat += 'M' + i + ' ' + (C - len) + 'V' + C + 'M' + C + ' ' + i + 'H' + (C + len);
    }
    // A hexagon, the chart's VOR symbol, with the station dot at its centre.
    const hex = [0, 60, 120, 180, 240, 300].map((d, i) => (i ? 'L' : 'M') + at(d + 30, 10)).join('') + 'Z';
    return '<svg class="hero-deco" viewBox="0 0 760 760" aria-hidden="true" focusable="false">'
        + '<path class="grat" d="' + grat + '"/>'
        + '<circle class="shelf" cx="' + C + '" cy="' + C + '" r="' + 314 + '"/>'
        + '<circle class="class-c" cx="' + C + '" cy="' + C + '" r="' + 320 + '"/>'
        + '<circle class="class-e" cx="' + C + '" cy="' + C + '" r="' + 236 + '"/>'
        + '<g class="rose" transform="rotate(13 ' + C + ' ' + C + ')">'
        + '<circle cx="' + C + '" cy="' + C + '" r="' + R + '"/><path d="' + rose + '"/>'
        + '<path d="M' + C + ' ' + (C - 14) + 'V' + (C - R - 22) + 'M' + (C - 5) + ' ' + (C - R - 12) + 'L' + C + ' ' + (C - R - 24) + 'L' + (C + 5) + ' ' + (C - R - 12) + '"/>'
        + '</g>'
        + '<path class="vor" d="' + hex + 'M' + C + ' ' + (C - 1.5) + 'v3"/>'
        + '</svg>';
})();

export function landing({ price, payTo, topic, facilitator, network }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Batas — a liquidity mandate the contract enforces</title>
<meta name="description" content="An autonomous agent can run your liquidity on 1inch Aqua. It cannot exceed the terms you granted, because the contract refuses to settle a swap that breaks them.">
<link rel="icon" href="${FAVICON}">
<link rel="preload" href="/assets/fonts/barlow-condensed-700.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/b612-400.woff2" as="font" type="font/woff2" crossorigin>
<style>
${FONT_FACES}
${TOKENS}
${BASE}
  .wrap { max-width: 76rem; margin: 0 auto; padding: 0 1.25rem; }
  .small { font-size: .84rem; }
  .muted { color: var(--dim); }

  /* ---- hero ------------------------------------------------------------------------------- */
  .hero {
    position: relative; overflow: hidden;
    border-bottom: 1px solid var(--rule);
    /* Chart graticule: a faint square grid, the one texture the page allows itself. */
    background:
      linear-gradient(var(--grid) 1px, transparent 1px) 0 0 / 48px 48px,
      linear-gradient(90deg, var(--grid) 1px, transparent 1px) 0 0 / 48px 48px,
      var(--ground);
    /* Its own stacking context, so the chart linework below can sit under the content without
       falling under the hero's own ground. */
    isolation: isolate;
  }
  /* The chart the plate is laid on: a VOR compass rose and two airspace rings, centred just right of
     the envelope plate so the plate covers their middle and only their outer linework shows, in the
     margin and above and below the plate — never behind the headline or the lead. Low contrast on
     purpose: it is the chart's texture, and the plate is the reading. */
  .hero-deco {
    position: absolute; z-index: -1; pointer-events: none;
    width: 760px; height: 760px; top: 50%; transform: translateY(-50%);
    right: calc(max(1.25rem, 50% - 36.75rem) - 440px);
  }
  .hero-deco * { fill: none; vector-effect: non-scaling-stroke; }
  .hero-deco .grat { stroke: var(--edge); stroke-width: 1; opacity: .55; }
  .hero-deco .shelf { stroke: var(--boundary); stroke-width: 9; opacity: .07; }
  .hero-deco .class-c { stroke: var(--boundary); stroke-width: 1.5; opacity: .3; }
  .hero-deco .class-e { stroke: var(--boundary); stroke-width: 1.5; stroke-dasharray: 9 6; opacity: .34; }
  .hero-deco .rose { stroke: var(--structure); stroke-width: 1; opacity: .32; }
  .hero-deco .vor { stroke: var(--structure); stroke-width: 1.25; opacity: .45; }
  .hero-in {
    max-width: 76rem; margin: 0 auto; padding: clamp(2rem, 4.5vw, 3.75rem) 1.25rem clamp(2.5rem, 5vw, 4.5rem);
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: clamp(2rem, 5vw, 4.5rem); align-items: center;
  }
  .hero h1 {
    font: 700 clamp(2.6rem, 5vw, 4.4rem)/.92 var(--display);
    letter-spacing: -.01em; text-transform: uppercase; margin: 0 0 1.4rem; text-wrap: balance;
  }
  .hero h1 em { font-style: normal; color: var(--boundary); }
  .hero .lead { font-size: clamp(1rem, 1.3vw, 1.1rem); color: var(--ink-2); max-width: 36rem; margin: 0 0 1rem; }
  .meaning {
    display: grid; grid-template-columns: auto 1fr; gap: .15rem 1rem; align-items: baseline;
    border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule);
    padding: .75rem 0; margin: 1.2rem 0 1.5rem; max-width: 36rem;
  }
  .meaning dt { font: 700 clamp(2rem, 3.4vw, 2.8rem)/1 var(--display); letter-spacing: .06em; text-transform: uppercase; }
  .meaning dd { margin: 0; color: var(--ink-2); font-size: .92rem; }
  .meaning .say { font-family: var(--figure); color: var(--dim); font-size: .8rem; }
  .cta { display: flex; flex-wrap: wrap; gap: .7rem; }

  /* The envelope plate. A chart panel, not a card: hairline frame, tick marks on the edges. */
  .plate {
    margin: 0; position: relative; background: var(--paper); border: 1px solid var(--edge); border-radius: 4px;
    box-shadow: var(--shadow); padding: 1.1rem 1.2rem 1rem;
  }
  .plate-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: .25rem 1rem; margin-bottom: .5rem; }
  .plate-head h2 { font: 700 1.05rem/1 var(--display); letter-spacing: .08em; text-transform: uppercase; margin: 0; }
  .plate-head .as-of { font-family: var(--figure); font-size: .72rem; color: var(--dim); }
  .plate svg.env { display: block; width: 100%; height: auto; }
  /* Chart labels are in SVG units, so what renders depends on the plate's width. 13 units renders
     near 12px beside the headline at full width; between the stack point and the full container the
     plate is narrower, so the labels step up to stay at 11px or more. */
  .env text { font-family: var(--number); font-variant-numeric: tabular-nums; fill: var(--dim); font-size: 13px; }
  @media (min-width: 60.0625rem) and (max-width: 75.9375rem) { .env text { font-size: 16px; } }
  .env .axis { stroke: var(--ink-2); stroke-width: 1; }
  .env .tick { stroke: var(--edge); stroke-width: 1; }
  .env .gridl { stroke: var(--grid); stroke-width: 1; }
  .env .zone-in { fill: color-mix(in oklab, var(--inside) 13%, transparent); }
  .env .zone-floor { fill: url(#hatch-floor); }
  .env .zone-cap { fill: url(#hatch-cap); }
  .env .curve { fill: none; stroke: var(--structure); stroke-width: 2.25; }
  .env .floor { stroke: var(--never); stroke-width: 2; }
  .env .cap { stroke: var(--boundary); stroke-width: 2; stroke-dasharray: 6 4; }
  .env .lbl-floor { fill: var(--never); font-weight: 700; }
  .env .lbl-cap { fill: var(--boundary); font-weight: 700; }
  .env .lbl-curve { fill: var(--structure); }
  .env .marker { fill: var(--paper); stroke: var(--ink); stroke-width: 2; }
  .env .trade { fill: var(--inside); stroke: var(--paper); stroke-width: 2; }
  .env .lbl-trade { fill: var(--inside); font-weight: 700; }
  .env .guide { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 2 3; }

  .probe { margin-top: .6rem; padding-top: .8rem; border-top: 1px solid var(--rule); display: grid; gap: .55rem; }
  .probe label { font-size: .84rem; color: var(--ink-2); display: flex; justify-content: space-between; gap: 1rem; }
  .probe label .fig { color: var(--ink); }
  .probe input[type=range] { width: 100%; accent-color: var(--boundary); }
  .readout { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem 1rem; min-height: 1.6rem; font-size: .86rem; }
  .readout .fig { color: var(--ink); }
  .plate .note { font-size: .76rem; color: var(--dim); margin: .35rem 0 0; }
  .plate .loading { font-size: .84rem; color: var(--dim); padding: 3rem 0; text-align: center; }

  /* ---- sections --------------------------------------------------------------------------- */
  section.band { padding: clamp(3.5rem, 8vw, 6.5rem) 0; border-bottom: 1px solid var(--rule); }
  section.band.sunk { background: var(--sunk); }
  .band h2 {
    font: 700 clamp(2rem, 4vw, 3.1rem)/.95 var(--display); letter-spacing: -.005em; text-transform: uppercase;
    margin: 0 0 1rem; max-width: 22ch; text-wrap: balance;
  }
  .band .intro { color: var(--ink-2); max-width: 62ch; margin: 0 0 2.4rem; font-size: 1.02rem; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: clamp(2rem, 5vw, 4rem); align-items: start; }

  /* The proof: two fuel tapes. What the position kept is solid; what it lost is hatched. */
  .tape { margin: 0 0 1.6rem; }
  .tape-head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: .45rem; }
  .tape-head b { font: 700 1.35rem/1 var(--display); text-transform: uppercase; letter-spacing: .04em; }
  .tape-head .fig { font-size: 1.1rem; }
  .tape-track {
    position: relative; height: 2.6rem; border: 1px solid var(--edge); border-radius: 2px; overflow: hidden;
    background: repeating-linear-gradient(135deg, var(--sunk) 0 6px, color-mix(in oklab, var(--never) 22%, var(--sunk)) 6px 8px);
  }
  .tape-fill { position: absolute; inset: 0 auto 0 0; background: var(--inside); }
  .tape-fill.lost { background: var(--never); }
  .tape-scale { display: flex; justify-content: space-between; font-family: var(--figure); font-size: .7rem; color: var(--dim); margin-top: .25rem; }
  .tape-foot { font-size: .84rem; color: var(--ink-2); margin-top: .35rem; }

  /* The operating limitations placard: the artefact a pilot reads before touching anything. */
  .placard {
    border: 2px solid var(--ink); border-radius: 4px; background: var(--paper);
    box-shadow: var(--shadow);
  }
  .placard h3 {
    margin: 0; padding: .7rem 1rem; background: var(--ink); color: var(--paper);
    font: 700 1.05rem/1 var(--display); letter-spacing: .12em; text-transform: uppercase;
    display: flex; justify-content: space-between; gap: 1rem;
  }
  .placard h3 span { font-family: var(--figure); letter-spacing: 0; font-size: .72rem; font-weight: 400; opacity: .8; }
  .placard table { width: 100%; border-collapse: collapse; }
  .placard th, .placard td { text-align: left; padding: .72rem 1rem; border-top: 1px solid var(--rule); vertical-align: top; font-size: .9rem; }
  .placard tr:first-child th, .placard tr:first-child td { border-top: 0; }
  .placard th { font: 700 1.05rem/1.2 var(--display); text-transform: uppercase; letter-spacing: .05em; width: 7.5rem; }
  .placard td.fig { font-size: 1rem; white-space: nowrap; font-weight: 700; }
  .placard td.how { color: var(--ink-2); font-size: .84rem; }

  /* What costs money: a fare table, four free, one priced. */
  .fares { border-collapse: collapse; width: 100%; }
  .fares th, .fares td { text-align: left; padding: .95rem 1rem .95rem 0; border-top: 1px solid var(--rule); vertical-align: top; }
  .fares thead th { font-size: .78rem; color: var(--dim); font-weight: 400; border-top: 0; padding-bottom: .5rem; }
  .fares td:first-child { font-weight: 700; width: 34%; }
  .fares td.src { color: var(--ink-2); }
  .fares td.price { text-align: right; white-space: nowrap; padding-right: 0; }
  .fares tr.paid td { border-top: 2px solid var(--boundary); }
  .fares .free { color: var(--inside); font-weight: 700; }
  .fares .cost { font: 700 1.5rem/1 var(--display); color: var(--boundary); letter-spacing: .02em; }

  /* Checked without us: three independent readings, as a chart legend rather than a card row. */
  .legend { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 2px solid var(--ink); }
  .legend li { padding: 1.4rem 1.4rem 1.6rem 0; border-right: 1px solid var(--rule); }
  .legend li + li { padding-left: 1.4rem; }
  .legend li:last-child { border-right: 0; }
  .legend .sym { display: block; width: 34px; height: 34px; margin-bottom: 1rem; color: var(--structure); }
  .legend h3 { font: 700 1.35rem/1.05 var(--display); text-transform: uppercase; letter-spacing: .03em; margin: 0 0 .5rem; }
  .legend p { margin: 0; color: var(--ink-2); font-size: .9rem; }
  .legend .live { margin-top: .9rem; font-size: .82rem; }

  /* Who it is, how it is paid, who can find it: four live readings under one 2px rule, two columns
     of ruled registers, the same legend grammar as the band above rather than a card row. */
  .caps { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 clamp(2rem, 5vw, 4rem); border-top: 2px solid var(--ink); }
  .caps > div { padding: 1.4rem 0 1.6rem; border-bottom: 1px solid var(--rule); min-width: 0; }
  .caps h3 { font: 700 1.35rem/1.05 var(--display); text-transform: uppercase; letter-spacing: .03em; margin: 0 0 .4rem; }
  .caps .say-what { color: var(--ink-2); font-size: .9rem; margin: 0 0 .9rem; max-width: 52ch; }
  .caps .btn { margin-top: .6rem; }

  /* The last word: open the instrument. A paper band opened by a 2px ink rule, the way every major
     group here opens. An ink-black band would be the one dark surface on a daylight chart, and the
     page would end on the black ground it exists not to be. */
  .final { background: var(--paper); color: var(--ink); border-top: 2px solid var(--ink); }
  .final-in { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: clamp(2rem, 5vw, 4rem); align-items: center; padding: clamp(3.5rem, 8vw, 6rem) 1.25rem; max-width: 76rem; margin: 0 auto; }
  .final h2 { font: 700 clamp(2rem, 4vw, 3.1rem)/.95 var(--display); text-transform: uppercase; margin: 0 0 1rem; }
  .final .cta { margin-top: 1.6rem; }
  .final p { color: var(--ink-2); max-width: 48ch; }

  @media (max-width: 60rem) {
    .hero-in, .split, .final-in { grid-template-columns: 1fr; }
    .hero-in { row-gap: 0; }
    /* Stacked, the plate spans the column and nothing sits beside it, so the linework moves to the
       one corner the text leaves open: bottom right, beside the second button. */
    .hero-deco { width: 440px; height: 440px; top: auto; transform: none; right: -220px; bottom: -250px; }
    .hero-in > div:first-child { display: contents; }
    .hero h1 { order: 0; }
    .plate { order: 1; margin: 0 0 1.75rem; }
    .hero .lead, .meaning, .cta { order: 2; }
    .legend { grid-template-columns: 1fr; }
    .legend li, .legend li + li { padding: 1.3rem 0; border-right: 0; border-bottom: 1px solid var(--rule); }
  }
  @media (max-width: 40rem) {
    .env text { font-size: 18px; }
    .placard th { width: auto; display: block; padding-bottom: 0; }
    .placard td { display: block; border-top: 0; padding-top: .2rem; }
    .placard td.how { padding-bottom: .9rem; }
    .fares thead { display: none; }
    .fares tr { display: grid; grid-template-columns: 1fr auto; border-top: 1px solid var(--rule); padding: .8rem 0; }
    .fares td { border: 0; padding: 0; }
    .fares td:first-child { width: auto; }
    .fares td.src { grid-column: 1 / -1; grid-row: 2; font-size: .86rem; padding-top: .2rem; }
    .fares tr.paid { border-top: 2px solid var(--boundary); }
    .fares tr.paid td { border: 0; }
    /* The metered range is wider than a phone leaves beside the question, so it takes its own row. */
    .fares tr.paid td.price { grid-column: 1 / -1; grid-row: 3; text-align: left; padding-top: .45rem; }
  }
  @media (max-width: 60rem) {
    .caps { grid-template-columns: minmax(0, 1fr); }
  }
</style>
</head>
<body>
${topBar('landing')}

<main>
<section class="hero" aria-labelledby="hero-title">
  ${HERO_CHART}
  <div class="hero-in">
    <div>
      <h1 id="hero-title">An agent runs your liquidity. <em>The contract</em> holds the limits.</h1>
      <p class="lead">
        Batas lets an autonomous agent operate a position on 1inch Aqua under terms you set — a size
        cap, a floor price, an expiry. It cannot exceed them, because the only contract allowed to
        touch your tokens refuses to settle a swap that breaks them.
      </p>
      <dl class="meaning">
        <dt>Batas</dt>
        <dd>Indonesian for <strong>mandate</strong>: authority entrusted within limits that must not be exceeded. <span class="say">/ˈba.tas/</span></dd>
      </dl>
      <div class="cta">
        <a class="btn" href="/app">Check the live position</a>
        <a class="btn quiet" href="#proof">See what it stops</a>
      </div>
    </div>

    <figure class="plate" id="envelope" aria-labelledby="env-title" aria-describedby="env-desc">
      <div class="plate-head">
        <h2 id="env-title">Operating envelope</h2>
        <span class="as-of" id="asOf">reading Sepolia…</span>
      </div>
      <div id="envBody"><p class="loading">Reading the live position from Sepolia.</p></div>
      <p class="sr" id="env-desc">A chart of the live position. Horizontal: the size of one trade in token A. Vertical: the average rate that trade gets. The blue curve is what the pool pays; the red line is the floor the mandate enforces; the dashed line is the size cap. Trades left of both limits settle; the rest are refused by the contract.</p>
    </figure>
  </div>
</section>

<section class="band" id="proof" aria-labelledby="proof-title">
  <div class="wrap">
    <h2 id="proof-title">The same attacker, twice.</h2>
    <p class="intro">
      One position under a mandate, one identical in every other way with nothing that refuses. The
      pool opens at 2.0 with 2,000 tokenB and an attacker trades against it until it stops. Every one
      of the unguarded run's sixty-four swaps was an ordinary constant-product trade that no
      application-layer check was there to stop.
    </p>
    <div class="split">
      <div>
        <div class="tape">
          <div class="tape-head"><b>Under a mandate</b><span class="fig">1,667.53 tokenB · 83%</span></div>
          <div class="tape-track" role="img" aria-label="Under a mandate the position kept 1,667.53 of 2,000 tokenB, 83 percent"><div class="tape-fill" style="width:83.4%"></div></div>
          <div class="tape-scale" aria-hidden="true"><span>0</span><span>500</span><span>1,000</span><span>1,500</span><span>2,000</span></div>
          <div class="tape-foot">Stopped after <span class="fig">2</span> trades · average rate <span class="fig">1.662</span> <span class="state inside">held the floor</span></div>
        </div>
        <div class="tape">
          <div class="tape-head"><b>With none</b><span class="fig">271.86 tokenB · 14%</span></div>
          <div class="tape-track" role="img" aria-label="With no mandate the position kept 271.86 of 2,000 tokenB, 14 percent"><div class="tape-fill lost" style="width:13.6%"></div></div>
          <div class="tape-scale" aria-hidden="true"><span>0</span><span>500</span><span>1,000</span><span>1,500</span><span>2,000</span></div>
          <div class="tape-foot">Drained over <span class="fig">64</span> trades · average rate <span class="fig">0.270</span> <span class="state never">no floor</span></div>
        </div>
        <p class="small muted">Reproducible: <code>forge test --match-test test_WhatTheMandateIsWorth -vv</code></p>
      </div>

      <div class="placard">
        <h3>Operating limitations <span id="plateSrc">live position</span></h3>
        <table>
          <tbody>
            <tr><th scope="row">Cap</th><td class="fig" id="pCap">—</td><td class="how">The largest single trade. Checked before Aqua pulls a token, and again inside the VM.</td></tr>
            <tr><th scope="row">Floor</th><td class="fig" id="pFloor">—</td><td class="how">The worst average rate a trade may get. Enforced at settlement, where both legs are visible.</td></tr>
            <tr><th scope="row">Expiry</th><td class="fig" id="pExp">—</td><td class="how">After this the position authorises nothing, however good the price.</td></tr>
            <tr><th scope="row">Fee</th><td class="fig" id="pFee">—</td><td class="how">Taken off the input before the curve prices it.</td></tr>
            <tr><th scope="row">Kill switch</th><td class="fig" id="pKill">—</td><td class="how">An ENSv2 name compiled into the program. Revoke it and settlement refuses every caller.</td></tr>
            <tr><th scope="row">Guard cost</th><td class="fig">975 gas</td><td class="how">What refusal costs, measured with both positions warm.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</section>

<section class="band sunk" aria-labelledby="where-title">
  <div class="wrap">
    <h2 id="where-title">Enforced where the money moves, not where the agent thinks.</h2>
    <p class="intro">
      Guardrails for agent wallets usually sit on the token transfer and can only bound how much
      leaves. Batas enforces inside the swap itself, at settlement, where both legs are visible — so it
      bounds what comes back. The limits are a SwapVM instruction, <code>PolicyEnvelope</code> at opcode
      <code>0x21</code>, wrapped around the whole program: later instructions run inside it and cannot
      undo the check.
    </p>
    <ul class="legend">
      <li>
        <svg class="sym" viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="15" fill="none" stroke="currentColor" stroke-width="2"/><path d="M17 7v10l7 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>
        <h3>When it was granted</h3>
        <p>Every mandate is published to Hedera Consensus Service. The timestamp comes from a network none of the parties runs.</p>
        <p class="live" id="lPub"><span class="state caution">reading the mirror node</span></p>
      </li>
      <li>
        <svg class="sym" viewBox="0 0 34 34" aria-hidden="true"><rect x="3" y="3" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 25L25 9M9 9l16 16" stroke="var(--never)" stroke-width="2"/></svg>
        <h3>Whether it still holds</h3>
        <p>The agent's authority is a soulbound ENSv2 name. The maker can revoke it at any moment without touching the position.</p>
        <p class="live" id="lAuth"><span class="state caution">reading the registry</span></p>
      </li>
      <li>
        <svg class="sym" viewBox="0 0 34 34" aria-hidden="true"><path d="M3 29h28M7 29V17M14 29V9M21 29V13M28 29V5" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        <h3>What counterparties say</h3>
        <p>Feedback on ERC-8004's reputation registry, which refuses the agent's own voice.</p>
        <p class="live" id="lRep"><span class="state caution">reading the registry</span></p>
      </li>
    </ul>
  </div>
</section>

<section class="band" id="cost" aria-labelledby="cost-title">
  <div class="wrap">
    <h2 id="cost-title">Four answers are free. One is metered by the work it asks for.</h2>
    <p class="intro">
      Anything you can work out from bytes you already hold costs nothing — charging for it would be
      charging for arithmetic. The paid answer is the one a stranger cannot assemble alone. It settles
      over x402 on <code>${network}</code> through the ${facilitator.split('//').pop()} facilitator: no
      key, no account, no subscription.
    </p>
    <table class="fares">
      <thead><tr><th scope="col">Question</th><th scope="col">Answered by</th><th scope="col" class="price">Price</th></tr></thead>
      <tbody>
        <tr><td>What do these bytes permit?</td><td class="src">the bytes themselves</td><td class="price"><span class="free">free</span></td></tr>
        <tr><td>When did they become public?</td><td class="src">Hedera Consensus Service, via a public mirror node</td><td class="price"><span class="free">free</span></td></tr>
        <tr><td>May the agent still act?</td><td class="src">the ENSv2 registry on Sepolia</td><td class="price"><span class="free">free</span></td></tr>
        <tr><td>What do counterparties say?</td><td class="src">ERC-8004's reputation registry</td><td class="price"><span class="free">free</span></td></tr>
        <tr class="paid"><td>Who operates this, and does their identity vouch for the maker?</td><td class="src">ERC-8004 identity, joined to the answers above</td><td class="price"><span class="cost" data-x402-range>reading…</span></td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="band sunk" id="agents" aria-labelledby="agents-title">
  <div class="wrap">
    <h2 id="agents-title">Who it is, how it is paid, who can find it.</h2>
    <p class="intro">
      Read as this page loads: the ENS name from Sepolia, the price from the x402 manifest an indexer
      reads, the agent card an A2A client reads, and the directory entry, token fee schedule and
      payment records straight from the public Hedera mirror node.
    </p>
    <div class="caps">
      <div>
        <h3>ENS identity</h3>
        <p class="say-what">agent.batas.eth on ENSv2, its records, and whether ENSIP-25 ties it to ERC-8004 #10123 in both directions.</p>
        <div id="sName" aria-busy="true"><span class="state caution">reading the ENS name</span></div>
      </div>
      <div>
        <h3>Paying</h3>
        <p class="say-what">Metered by the work a request asks for, settled over x402 in HBAR or in an HTS token whose fee schedule the network enforces.</p>
        <div id="sPrice" aria-busy="true"><span class="state caution">reading the x402 manifest</span></div>
      </div>
      <div>
        <h3>Agent to agent</h3>
        <p class="say-what">A2A, with the payment requested and settled inside the task, and a listing in the Hashgraph Online directory.</p>
        <div id="sReach" aria-busy="true"><span class="state caution">reading the agent card and the directory</span></div>
      </div>
      <div>
        <h3>Payment audit trail</h3>
        <p class="say-what">Each payer records its settled payment on Hedera Consensus Service. The newest five, with both transactions.</p>
        <div id="sTrail" aria-busy="true"><span class="state caution">reading the payment trail</span></div>
      </div>
    </div>
  </div>
</section>

<section class="final" aria-labelledby="final-title">
  <div class="final-in">
    <div>
      <h2 id="final-title">Don't take our word for the limits.</h2>
      <p>Open the app to decode the live position, watch its publication and kill switch update from chain, and paste any program to read what it actually enforces.</p>
      <div class="cta">
        <a class="btn" href="/app">Open the app</a>
        <a class="btn quiet" href="https://github.com/PugarHuda/batas" rel="noopener">Read the source</a>
      </div>
    </div>
    <pre aria-label="Run it yourself"># every free step first, then one that pays
git clone https://github.com/PugarHuda/batas
cd batas &amp;&amp; npm install
npm run walkthrough
npm run walkthrough -- --paid</pre>
  </div>
</section>
</main>

${foot({ topic, payTo })}

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n, d = 3) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// The envelope, from the reserves and terms the position actually has.
//
// The contract's check is amountOut * 1e18 >= amountIn * minRate, with the fee taken off the input
// before the constant-product curve prices it. So the average rate one trade of size x gets is
//   B(1-f) / (A + x(1-f))
// and the envelope is every x at or under the cap whose rate is at or over the floor. This is that
// arithmetic against the live reserves, not a quote: the chain rounds, and reserves move.
function drawEnvelope(h) {
    const A = Number(h.position.reservesNow.a), B = Number(h.position.reservesNow.b);
    const f = Number(h.terms.feeBps) / 1e7;
    const cap = Number(h.terms.maxAmountInFormatted), floor = Number(h.terms.minRateFormatted);
    const rate = (x) => (B * (1 - f)) / (A + x * (1 - f));
    const floorAt = Math.max(0, (B * (1 - f) / floor - A) / (1 - f));
    const trades = (h.trades || []).map((t) => ({ x: Number(t.amountIn), y: Number(t.rate) })).filter((t) => t.x > 0 && t.y > 0);
    const xMax = Math.max(cap, floorAt, ...trades.map((t) => t.x)) * 1.45;
    const yTop = Math.max(rate(0), ...trades.map((t) => t.y)) * 1.0025, yBot = Math.min(floor, rate(xMax)) * 0.9975;

    const W = 560, H = 340, L = 58, R = 18, T = 30, Bm = 42;
    const sx = (x) => L + (x / xMax) * (W - L - R);
    const sy = (y) => T + ((yTop - y) / (yTop - yBot)) * (H - T - Bm);
    const inside = Math.min(cap, floorAt);

    let path = '';
    for (let i = 0; i <= 80; i++) { const x = (xMax * i) / 80; path += (i ? 'L' : 'M') + sx(x).toFixed(1) + ' ' + sy(rate(x)).toFixed(1); }

    const xt = [0, 0.25, 0.5, 0.75, 1].map((k) => k * xMax);
    const yt = [0, 0.33, 0.66, 1].map((k) => yBot + k * (yTop - yBot));
    const ticks = xt.map((x) => '<line class="tick" x1="' + sx(x) + '" x2="' + sx(x) + '" y1="' + (H - Bm) + '" y2="' + (H - Bm + 5) + '"/><text x="' + sx(x) + '" y="' + (H - Bm + 18) + '" text-anchor="middle">' + fmt(x, 1) + '</text>').join('')
        + yt.map((y) => '<line class="gridl" x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(y) + '" y2="' + sy(y) + '"/><text x="' + (L - 8) + '" y="' + (sy(y) + 4) + '" text-anchor="end">' + fmt(y, 3) + '</text>').join('');

    $('envBody').innerHTML = '<svg class="env" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="env-title env-desc">'
        + '<defs>'
        + '<pattern id="hatch-floor" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="color-mix(in oklab, var(--never) 7%, transparent)"/><line x1="0" y1="0" x2="0" y2="7" stroke="var(--never)" stroke-opacity=".35" stroke-width="2"/></pattern>'
        + '<pattern id="hatch-cap" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="7" height="7" fill="color-mix(in oklab, var(--boundary) 7%, transparent)"/><line x1="0" y1="0" x2="0" y2="7" stroke="var(--boundary)" stroke-opacity=".35" stroke-width="2"/></pattern>'
        + '</defs>'
        + ticks
        + '<rect class="zone-in" x="' + sx(0) + '" y="' + T + '" width="' + (sx(inside) - sx(0)) + '" height="' + (H - T - Bm) + '"/>'
        + (floorAt < cap ? '<rect class="zone-floor" x="' + sx(floorAt) + '" y="' + T + '" width="' + (sx(cap) - sx(floorAt)) + '" height="' + (H - T - Bm) + '"/>' : '')
        + '<rect class="zone-cap" x="' + sx(cap) + '" y="' + T + '" width="' + (sx(xMax) - sx(cap)) + '" height="' + (H - T - Bm) + '"/>'
        + '<line class="axis" x1="' + L + '" x2="' + L + '" y1="' + T + '" y2="' + (H - Bm) + '"/><line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - Bm) + '" y2="' + (H - Bm) + '"/>'
        + '<line class="floor" x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(floor) + '" y2="' + sy(floor) + '"/>'
        + '<text class="lbl-floor" x="' + (W - R - 4) + '" y="' + (sy(floor) + 15) + '" text-anchor="end">floor ' + fmt(floor, 3) + '</text>'
        + '<line class="cap" x1="' + sx(cap) + '" x2="' + sx(cap) + '" y1="' + T + '" y2="' + (H - Bm) + '"/>'
        + '<text class="lbl-cap" x="' + (sx(cap) + 6) + '" y="' + (T + 12) + '">cap ' + fmt(cap, 2) + '</text>'
        + '<path class="curve" d="' + path + '"/>'
        + '<text class="lbl-curve" x="' + (L + 8) + '" y="' + (H - Bm - 10) + '">what the pool pays today</text>'
        // The curve's label sits bottom-left: the curve falls left to right, so the marker riding it can
        // never be low and left at once, and nothing else on the chart lives there.
        // Trades the position actually settled, at the size and rate they got. They sit off today's
        // curve because each one moved the reserves the curve is drawn from.
        + trades.map((t) => '<circle class="trade" r="5.5" cx="' + sx(t.x) + '" cy="' + sy(t.y) + '"><title>settled: ' + fmt(t.x, 2) + ' A at ' + fmt(t.y, 4) + '</title></circle>').join('')
        + (trades.length ? '<text class="lbl-trade" x="' + (sx(trades[0].x) + 9) + '" y="' + (sy(trades[0].y) - 8) + '">' + trades.length + ' settled trade' + (trades.length === 1 ? '' : 's') + '</text>' : '')
        + '<text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">trade size, token A</text>'
        + '<text x="' + L + '" y="' + (T - 14) + '">rate, B per A</text>'
        + '<line class="guide" id="gX" x1="0" x2="0" y1="' + T + '" y2="' + (H - Bm) + '"/>'
        + '<circle class="marker" id="mk" r="6" cx="' + sx(1) + '" cy="' + sy(rate(1)) + '"/>'
        + '</svg>'
        + '<div class="probe">'
        + '<label for="size"><span>Try one trade</span><span class="fig" id="sizeOut"></span></label>'
        + '<input id="size" type="range" min="0" max="' + xMax.toFixed(4) + '" step="' + (xMax / 400).toFixed(5) + '" value="' + Math.min(1, inside * 0.5).toFixed(4) + '">'
        + '<div class="readout" id="readout" aria-live="polite"></div>'
        + '<p class="note">Arithmetic against the live reserves, not a quote. The chain rounds toward the maker, and reserves move with every trade.</p>'
        + '</div>';

    const move = () => {
        const x = Number($('size').value), y = rate(x);
        $('mk').setAttribute('cx', sx(x)); $('mk').setAttribute('cy', sy(y));
        $('gX').setAttribute('x1', sx(x)); $('gX').setAttribute('x2', sx(x));
        $('sizeOut').textContent = fmt(x, 2) + ' A → ' + fmt(x * y, 2) + ' B';
        let verdict;
        if (x > cap) verdict = '<span class="state never">past the cap — settlement refuses</span>';
        else if (y < floor) verdict = '<span class="state never">under the floor — settlement refuses</span>';
        else if (y < floor * 1.0015) verdict = '<span class="state caution">inside, close to the floor</span>';
        else verdict = '<span class="state inside">inside the envelope — settles</span>';
        $('readout').innerHTML = 'rate <span class="fig">' + fmt(y, 4) + '</span>' + verdict;
    };
    $('size').addEventListener('input', move);
    move();
}

function fillPlacard(h) {
    const t = h.terms;
    $('pCap').textContent = fmt(t.maxAmountInFormatted, 2) + ' A';
    $('pFloor').textContent = fmt(t.minRateFormatted, 3) + ' B/A';
    $('pExp').textContent = String(t.expiryISO).slice(0, 10);
    $('pFee').textContent = t.feePercent + '%';
    $('pKill').textContent = t.killSwitch ? '"' + t.killSwitch.label + '"' : 'none';
}

async function get(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
    return json;
}

// One read feeds the whole page. The health route already joins the position, its publication,
// the kill switch and reputation; the free routes are rate limited per visitor, and a landing page
// that spent four of them to say what one says would be spending the visitor's budget, not ours.
(async () => {
    let h;
    try {
        h = await get('/v1/position/health');
    } catch (e) {
        $('asOf').textContent = 'could not read';
        $('envBody').innerHTML = '<p class="loading">The live position could not be read from here (' + esc(e.message) + '). <a href="/app">Open the app</a> to try again.</p>';
        $('plateSrc').textContent = 'unavailable';
        for (const id of ['lPub', 'lAuth', 'lRep']) $(id).innerHTML = '<span class="state caution">could not read</span>';
        return;
    }
    $('asOf').textContent = 'live · ' + new Date(h.asOf || Date.now()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    try { drawEnvelope(h); } catch { $('envBody').innerHTML = '<p class="loading">The position answered, but not in a shape this chart can draw.</p>'; }
    fillPlacard(h);

    const pub = h.ledger?.publication;
    $('lPub').innerHTML = pub?.published
        ? '<span class="state inside">published · #' + esc(pub.sequenceNumber) + ' · ' + esc(String(pub.publishedAt).slice(0, 10)) + '</span>'
        : '<span class="state caution">' + esc(pub?.reason || 'no publication found') + '</span>';

    const a = h.authority;
    $('lAuth').innerHTML = !a
        ? '<span class="state caution">not checked</span>'
        : a.valid
            ? '<span class="state inside">held · ' + esc(Math.floor(a.secondsLeft / 86400)) + ' days left</span>'
            : '<span class="state never">' + esc(a.revoked ? 'revoked by the maker' : a.reason) + '</span>';

    const r = h.reputation;
    $('lRep').innerHTML = !r
        ? '<span class="state caution">not checked</span>'
        : r.breachedCount > 0
            ? '<span class="state never">' + esc(r.breachedCount) + ' breach' + (r.breachedCount === 1 ? '' : 'es') + ' reported</span>'
            : '<span class="state inside">' + esc(r.feedbackCount) + ' feedback from ' + esc(r.clientCount) + ' counterpart' + (r.clientCount === 1 ? 'y' : 'ies') + ' · no breach</span>';
})();

${surfaceSource()}

loadSurface({ topic: ${JSON.stringify(topic)}, token: ${JSON.stringify(HTS_TOKEN_ID)}, listing: ${JSON.stringify(HOL_LISTING)}, again: 'btn quiet' });
</script>
</body>
</html>`;
}
