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
trades against 271.86 over 64), 975 gas, the live position's real terms. Constraint: no CDN, no
external requests, no build step; every number real.

## Direction contract

THESIS: The mandate is an operating envelope. A position flies inside limits someone else set, and
the contract is the airframe that will not let it leave. Refuses the DeFi landing default: black
ground, glowing 3D object, headline metric row.

OWN-WORLD: The aeronautical chart and the pilot's handbook, printed in daylight. Cool chart-white
ground, chart ink, airspace magenta for the boundary that must not be crossed, airspace blue for
controlled structure. State borrows the airspeed indicator: green arc inside, yellow arc caution,
red radial never-exceed. Condensed engraved-placard display face, tabular mono for every figure,
hairline grid ticks at the margins like chart graticule.

STORY: The visitor sees the envelope drawn from the live position's own terms, watches the unguarded
run leave it, understands that the floor is enforced at settlement, sees that four questions are
free and one costs 0.001 HBAR, and opens the app.

FIRST VIEWPORT: Left, the name and one-line thesis at display scale with the meaning of Batas beneath.
Right, the envelope diagram filling half the width: axes, cap wall, floor red radial, the mandate's
two trades inside, the unguarded sixty-four as a trail exiting. Top bar: wordmark left, Open the app
right as the primary action.

FORM: aircraft operating envelope (V-n diagram) and the aeronautical chart; position 1 of my ordered
list, chosen by the user as the pick card; seed key 3859911e.

Signature interaction: an amount slider on the landing moves a trade marker across the envelope in
real time and reads out whether it stays inside the cap. Motion grammar: the unguarded trail draws
once on load, exponential ease-out; nothing else animates; reduced motion shows the finished trail.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
