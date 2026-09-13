---
version: 1
slug: "agent-ui-mjs"
primary_target: "agent/ui.mjs"
related_targets: []
---

# Surface brief — Batas landing (`/`) and app (`/app`)

Scope: two surfaces kept distinct. Landing is Persuade, for a maker or counterparty with money at
stake deciding whether this is safe. App is Operate, the working instrument.

Audience: sceptical makers and counterparties; they want to know what can be taken and who can stop
it. Job: believe that the limit is enforced by the contract, not by the agent's good behaviour, and
open the app to check the live position themselves. Proof: the measured attack (1667.53 kept over 2
trades against 271.86 over 64), 975 gas, the live position's real terms and settled trades.
Constraint: no CDN, no external requests, no build step; every number real.

## Direction contract

THESIS: The mandate is an operating envelope. A position flies inside limits someone else set, and
the contract is the airframe that will not let it leave. Refuses the DeFi landing default: black
ground, glowing 3D object, headline metric row.

OWN-WORLD: The aeronautical chart and the pilot's handbook, printed in daylight. Cool chart-white
ground, chart ink, airspace magenta for the boundary that must not be crossed, airspace blue for
controlled structure. State borrows the airspeed indicator: green inside, yellow caution, red
never-exceed, each with a non-colour mark. Condensed placard display face, the Airbus cockpit face
for text and figures with tabular numerals, the cockpit mono only for bytes and code.

STORY: The visitor sees the envelope drawn from the live position's own reserves and terms with the
trades it actually settled, moves one trade across it and watches the floor and the cap refuse,
reads the measured attack that shows what the envelope is worth, sees that four questions are free
and one costs 0.001 HBAR, and opens the app.

FIRST VIEWPORT: Left, the thesis at display scale, the name Batas at display scale with its meaning
beneath, and the primary action. Right, the envelope diagram at half the width: rate against trade
size, the pool's curve today, the floor as the red never-exceed line, the cap as the magenta wall,
the position's settled trades plotted where they settled, and the trade-size probe. On a phone the
envelope follows the headline directly. Top bar: wordmark left, Open the app right.

Amended after the finish review: the first contract promised the unguarded run's sixty-four trades
as a trail leaving this chart. That run was measured on a different pool (opened at 2.0 with 2,000
tokenB), so drawing it on the live position's axes would be an invented figure. It stays in the
proof section, where its own pool is stated, and the chart carries the live position's real trades.

FORM: aircraft operating envelope (V-n diagram) and the aeronautical chart; position 1 of my ordered
list, chosen by the user as the pick card; seed key 3859911e.

Signature interaction: the trade-size probe moves a marker along the curve and reads inside,
refused by the floor, or refused by the cap, computed with the contract's own check. Motion grammar:
nothing moves on its own; the probe is the only moving thing, and the visitor moves it. Amended for
the same review: the tape fills and the marker transition were cut, because the marker lagged its
own readout and the fills contradicted "nothing else animates".

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
