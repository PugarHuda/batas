---
name: Batas
description: An operating envelope for liquidity, drawn as an aeronautical chart and a pilot's handbook.
colors:
  ground: "#f3f6f4"
  paper: "#fbfcfb"
  sunk: "#e9eeeb"
  ink: "#0f1a22"
  ink-2: "#33414d"
  dim: "#56636f"
  rule: "#d2dad5"
  grid: "#e3e9e5"
  edge: "#a9b5ae"
  boundary: "#a0146c"
  boundary-soft: "#f6e3ee"
  structure: "#1b4d99"
  inside: "#17753b"
  caution: "#8f5c00"
  caution-fill: "#f0b429"
  never: "#c0141a"
  on-boundary: "#ffffff"
typography:
  display:
    fontFamily: "Barlow Condensed, Arial Narrow, Roboto Condensed, sans-serif"
    fontSize: "clamp(2.6rem, 5vw, 4.4rem)"
    fontWeight: 700
    lineHeight: 0.92
    letterSpacing: "-0.01em"
  name:
    fontFamily: "Barlow Condensed, Arial Narrow, Roboto Condensed, sans-serif"
    fontSize: "clamp(2rem, 3.4vw, 2.8rem)"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.06em"
  headline:
    fontFamily: "Barlow Condensed, Arial Narrow, Roboto Condensed, sans-serif"
    fontSize: "clamp(2rem, 4vw, 3.1rem)"
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: "-0.005em"
  title:
    fontFamily: "Barlow Condensed, Arial Narrow, Roboto Condensed, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.03em"
  wordmark:
    fontFamily: "Barlow Condensed, Arial Narrow, Roboto Condensed, sans-serif"
    fontSize: "1.45rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.06em"
  placard-label:
    fontFamily: "Barlow Condensed, Arial Narrow, Roboto Condensed, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.08em"
  body:
    fontFamily: "B612, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.65
    fontFeature: "tnum"
  lead:
    fontFamily: "B612, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "clamp(1rem, 1.3vw, 1.1rem)"
    fontWeight: 400
    lineHeight: 1.65
  figure:
    fontFamily: "B612, ui-sans-serif, system-ui, sans-serif"
    fontWeight: 400
    letterSpacing: "-0.005em"
    fontFeature: "tnum, lnum"
  button:
    fontFamily: "B612, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "0.92rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.01em"
  label:
    fontFamily: "B612, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 700
  tag:
    fontFamily: "B612, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "0.04em"
  bytes:
    fontFamily: "B612 Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.7
    fontFeature: "tnum"
rounded:
  hairline: "2px"
  control: "3px"
  plate: "4px"
spacing:
  gutter: "1.25rem"
  container: "76rem"
  band: "clamp(3.5rem, 8vw, 6.5rem)"
  graticule: "48px"
  cell: "1rem"
components:
  button-primary:
    backgroundColor: "{colors.boundary}"
    textColor: "{colors.on-boundary}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0.78rem 1.15rem"
  button-primary-hover:
    backgroundColor: "color-mix(in oklab, #a0146c 86%, #0f1a22)"
    textColor: "{colors.on-boundary}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0.78rem 1.15rem"
  button-quiet-hover:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  button-small:
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0.35rem 0.7rem"
  input:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.ink}"
    typography: "{typography.bytes}"
    rounded: "{rounded.control}"
    padding: "0.8rem 0.9rem"
  plate:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
    padding: "1.1rem 1.2rem 1rem"
  panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
    padding: "1.3rem 1.4rem"
  placard-head:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.placard-label}"
    padding: "0.7rem 1rem"
  tag:
    backgroundColor: "transparent"
    typography: "{typography.tag}"
    rounded: "{rounded.hairline}"
    padding: "0.08rem 0.45rem"
  tape-track:
    backgroundColor: "{colors.sunk}"
    rounded: "{rounded.hairline}"
    height: "2.6rem"
  pending-bar:
    backgroundColor: "{colors.sunk}"
    rounded: "{rounded.hairline}"
    height: "0.75rem"
  note:
    textColor: "{colors.ink-2}"
    padding: "0.1rem 0 0.1rem 1rem"
  top-bar:
    textColor: "{colors.ink}"
    padding: "0.7rem 1.25rem"
  hero-chart:
    backgroundColor: "transparent"
    textColor: "{colors.boundary}"
    size: "760px"
  final-band:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
---

# Design System: Batas

## Overview

**Creative North Star: "The Operating Envelope"**

Batas is drawn as an aeronautical chart and a pilot's handbook, printed in daylight. A mandate is an envelope a position flies inside; the page draws that envelope from live terms, plots the trades the position actually settled, and reads every limit the way a pilot reads an operating limitations placard. The vocabulary is borrowed whole: airspace magenta for the boundary that must not be crossed, airspace blue for controlled structure, and the airspeed indicator's three arcs for state.

Density follows the room. The landing (`/`) is spacious: wide bands, a chart graticule and faint chart linework behind the hero, one plate carrying the live envelope. The app (`/app`) is the same world set for work: denser panels, facts lists ruled with hairlines, byte tables, and section heads marked with a 2px ink rule. Both share one top bar, one set of tokens, one footer, so the split reads as one product with two rooms.

Surfaces are flat paper on a cool chart-white ground, separated by hairlines rather than shadows; the single soft shadow is reserved for objects that read as physical chart plates. The chart is still: nothing moves on its own, and the trade-size probe is the only moving thing, moved by the visitor. The confirmed anti-reference is the DeFi landing default: black ground, glowing 3D object, headline metric row.

**Key Characteristics:**
- Cool chart-white ground, chart ink, magenta for limits, blue for structure.
- Condensed uppercase placard display (Barlow Condensed 700) over the B612 cockpit face.
- Every figure set in B612 with tabular lining numerals; the mono only for bytes, code, timestamps and scale ticks.
- Three states, each carried by colour and a non-colour mark.
- Hairline rules, hatched fills for loss and refused zones, 48px graticule and the hero chart linework in the hero only.
- Nothing moves on its own; buttons are text only and every mark is drawn.
- Light only: `color-scheme: light` and one token set, whatever the operating system prefers. No dark scheme, no dark band, no toggle.
- Self-hosted faces, no third-party request of any kind.

## Colors

A cool, low-chroma chart palette where saturated colour is spent only on meaning: a limit, a structure, or a state.

### Primary
- **Airspace Magenta** (`boundary`): the boundary that must not be crossed and the one way forward. The cap wall on the envelope, the primary button, the focus outline, text selection, the range-input accent, the input caret and focus border, the paid fare row's rule and its price, and the emphasised clause of the hero headline; at low opacity, the airspace rings of the hero chart. Button text on it is `on-boundary` (7.47:1).
- **Magenta Wash** (`boundary-soft`): the 3px focus halo around text inputs; nothing else.

### Secondary
- **Airspace Blue** (`structure`): controlled structure. Links, the pool's rate curve and its label, instruction names in the byte table, the legend symbols, and at low opacity the VOR compass rose of the hero chart.

### Tertiary (the airspeed arcs)
- **Green Arc** (`inside`): inside the envelope. The settled-trade dots and their label on the envelope, the kept portion of a fuel tape, the healthy health bar, the "free" fare label, the tinted safe zone of the envelope (13% mix), and `yes` tags.
- **Yellow Arc** (`caution`): caution and not-yet-confirmed. Used for pending live readings ("reading the registry") so that "not checked yet" never looks like "fine" or "failed". `caution-fill` is the saturated arc fill.
- **Red Radial** (`never`): never exceed. The floor line and its label, the lost portion of a fuel tape and its hatching, the unhealthy bar, errors, and `no` tags.

### Neutral
- **Chart White** (`ground`): the page ground and the translucent top bar (88% mix).
- **Plate Paper** (`paper`): raised chart plates, panels, placards, the final band, quiet-button hover; the text colour on ink-filled heads; the ring around settled-trade dots.
- **Sunk Well** (`sunk`): code blocks, text inputs, tape and bar tracks, pending-reading bars, the alternate `sunk` band.
- **Chart Ink** (`ink`): primary text, the 2px section rules (including the one that opens the final band), the placard head fill. It is never a band fill.
- **Second Ink** (`ink-2`): lead paragraphs, secondary copy, notes, chart axes, nav links.
- **Dim** (`dim`): table heads, definition terms, captions, timestamps, placeholders, chart tick labels.
- **Hairline** (`rule`): every 1px divider: bar, footer, table rows, facts rows, band edges, the side rule of a note, the frame of a pending bar.
- **Graticule** (`grid`): the hero's 48px grid and the envelope's horizontal grid lines.
- **Edge** (`edge`): frames of plates, panels, inputs, tracks and the quiet button; the scrollbar thumb.

### Named Rules
**The Airspace Rule.** Magenta means a limit or the single action forward; blue means structure. A decorative use of either is a misread chart. The one exception is the hero chart, which draws airspace boundaries in magenta and a navaid in blue with their chart meanings intact, at low opacity, never behind text.

**The Daylight Rule.** There is one scheme and it is light, set by `color-scheme: light` with no `prefers-color-scheme` block. Every surface is a light one: the final band is `paper` under a 2px ink rule, not an ink-black band. Measured against WCAG on `ground` / `paper` / `sunk`: `ink` 16.20 / 17.14 / 15.02, `ink-2` 9.63 / 10.19 / 8.93, `dim` 5.66 / 5.99 / 5.25, `boundary` 6.86 / 7.26 / 6.37, `structure` 7.52 / 7.95 / 6.97, `inside` 5.30 / 5.60 / 4.91, `caution` 5.22 / 5.52 / 4.84, `never` 5.75 / 6.08 / 5.33. The lowest, 4.84, clears the 4.5:1 floor.

## Typography

**Display Font:** Barlow Condensed 700 (with Arial Narrow, Roboto Condensed)
**Body Font:** B612 400/700 (with ui-sans-serif, system-ui, Segoe UI)
**Label/Mono Font:** B612 Mono 400 (with ui-monospace, SF Mono, Menlo, Consolas)

**Character:** An engraved, condensed placard face set in uppercase over B612, the face designed for cockpit displays; the pairing reads as a limitations placard bolted above an instrument.

All three faces are SIL OFL 1.1, served from `/assets/fonts/<name>.woff2` with `font-display: swap`; the landing preloads Barlow Condensed 700 and B612 400.

### Hierarchy
- **Display** (700, clamp(2.6rem, 5vw, 4.4rem), 0.92, uppercase, balanced wrap): the landing hero headline only.
- **Name** (700, clamp(2rem, 3.4vw, 2.8rem), 1, +0.06em, uppercase): the name Batas beside its meaning in the hero, at display scale.
- **Headline** (700, clamp(2rem, 4vw, 3.1rem), 0.95, uppercase, max 22ch): landing band headings and the final band heading. The app's page title uses clamp(2rem, 4vw, 2.9rem) at +0.01em.
- **Title** (700, 1.6rem, 1, +0.03em, uppercase): app section headings, over a hairline; 1.35rem below 46rem. Tape heads and legend headings use 1.35rem; app sub-heads 1.15rem.
- **Placard label** (700, 1.05rem, +0.05em to +0.12em, uppercase): plate titles, the placard head (+0.12em), placard row labels, reach terms, form labels (1rem). The wordmark is the same voice at 1.45rem, +0.06em.
- **Body** (B612 400, 0.9375rem, 1.65, tabular numerals on): running text; paragraphs capped at 68ch in the app, band intros at 62ch, hero lead 36rem.
- **Button** (B612 700, 0.92rem, 1, +0.01em): all buttons; 0.9rem in the app, 0.82rem small.
- **Label** (B612 700, 0.8rem): state readouts. Tags are 0.72rem, 1.5, +0.04em, uppercase.
- **Figure** (B612, tabular and lining numerals, -0.005em): every number a reader reads: placard values (700, 1rem), tape totals (1.1rem), facts values, readouts, chart axis labels.
- **Bytes** (B612 Mono, 0.82rem, 1.7): hex programs in inputs, instruction tables, code and `pre` (0.8rem, 1.75), timestamps and tape scale ticks (0.7 to 0.72rem).

### Named Rules
**The Readable Figure Rule.** A figure is read, not typed: B612 with `tabular-nums lining-nums`. The mono sets a decimal point as wide as a digit and 1.941 reads as "1. 941", so B612 Mono is kept for bytes, code, timestamps and scale ticks.

**The Placard Voice Rule.** Barlow Condensed is always 700 and uppercase, and only for display, headings, placard labels, the name and the wordmark. It never sets running text or a figure in a sentence; the fare price is its one numeric use, as a placard value.

**The Drawn Mark Rule.** A text character is never an icon. Buttons are text only; state marks, legend symbols and the product mark are drawn in CSS or SVG. An arrow inside a figure readout ("1.01 A → 1.97 B") is notation, not an icon.

## Layout

One container everywhere: 76rem max width, centred, 1.25rem side gutter, shared by the top bar, the bands, the app `main` and the footer. The landing is a stack of full-bleed bands (vertical padding clamp(3.5rem, 8vw, 6.5rem), separated by hairlines, alternating with a `sunk` band); the app is a single column of sections, each opened by a hairline and a title, with a 5rem bottom pad.

Two-column grids use `minmax(0, 1fr)` tracks with gap clamp(2rem, 5vw, 4rem to 4.5rem): the hero (1fr / 1.05fr, chart on the right), the proof split (1fr / 1fr) and the final band (1.1fr / 1fr). The legend is three equal columns divided by hairlines under a 2px ink rule; the app's live columns auto-fit at `minmax(17rem, 1fr)` under the same 2px rule. Facts and reach lists are `max-content 1fr` definition grids with row hairlines. Health bars run `11rem 1fr 11rem`.

Breakpoints: at 60rem the hero, split and final grids and the legend collapse to one column, and the hero's text column dissolves so the order becomes headline, envelope plate (1.75rem below), then lead, meaning and actions: the envelope follows the headline directly. At 46rem the nav keeps only its button, bars, facts and reach lists stack, and the app's cost table and instruction arguments reflow. At 40rem the placard and fare table become stacked rows and chart labels step up. Pages hold at 390px without horizontal scroll; wide byte tables sit in an `overflow-x: auto` wrapper.

The chart graticule, a 48px square grid of 1px `grid` lines, sits behind the landing hero and nowhere else, with the hero chart linework over it (see Hero Chart).

## Elevation & Depth

Depth is tonal and ruled: `sunk` wells below the ground, `paper` plates above it, hairlines (`rule`) for structure, 1px `edge` frames for objects, and 2px `ink` rules to open a major group. A single soft shadow lifts objects that behave as physical chart plates: the envelope plate, the limitations placard, and app panels. The top bar is translucent with a 10px backdrop blur rather than shadowed.

### Shadow Vocabulary
- **Plate lift** (`box-shadow: 0 1px 1px rgb(15 26 34 / .06), 0 12px 32px -18px rgb(15 26 34 / .28)`): plate, placard, panel only.
- **Button seat** (`box-shadow: 0 1px 0 rgb(0 0 0 / .08)`): the primary button; removed on the quiet button.
- **Input halo** (`box-shadow: 0 0 0 3px var(--boundary-soft)`): text input focus.

### Named Rules
**The Hairline Chart Rule.** Structure is drawn with rules, not boxes. A new grouping gets a hairline or a 2px ink rule; the plate lift is for a chart plate, never for a row of cards.

**The Hairline Side Rule.** No coloured side stripe wider than 1px. A note is set off by a 1px `rule` hairline on its left; heavier rules run across the top of a group, never down its side.

## Shapes

Nearly square corners on three steps: 2px for hairline objects (tags, tape and bar tracks, pending bars, focus outline), 3px for controls (buttons, inputs), 4px for plates, panels, placards and code blocks. The favicon tile uses 6px. Borders are 1px `edge` on objects, 2px `ink` for the placard frame. Loss and refused zones are hatched, never flat-filled: tape tracks use a 135deg repeating stripe of `never` mixed 20 to 22% into `sunk`, and the envelope's floor and cap zones use 7px rotated line patterns at 35% opacity. State marks are drawn shapes (disc, open square, diagonal cross), and the product mark is two magenta limit stops with an ink span stopping short of the right one, inside a 3px-radius frame.

## Components

### Motion
**The Still Chart Rule.** Nothing moves on its own: no fills, draws, loops or shimmer on load. The trade-size probe is the only moving thing, and the visitor moves it; its marker jumps to the new position with no transition. Pointer responses stay brief: button fill 0.13 to 0.14s and press 0.08s, input border and halo 0.12s, all `ease-out`. The global `prefers-reduced-motion: reduce` guard clamps any animation or transition to 0.001ms. The app's health bars are drawn at their measured width with no animation, and there is no `@keyframes` rule on either page.

### Buttons
Firm and plain, like a labelled switch.
- **Shape:** control corners (3px).
- **Primary:** magenta fill and border, `on-boundary` text, B612 700, padding 0.78rem 1.15rem (0.72rem 1.1rem in the app). Text only, no icon.
- **Hover / Active:** fill mixes 14% toward ink; press shifts down 1px. Disabled drops to 50% opacity with a progress cursor.
- **Quiet:** transparent, ink text, `edge` border; hover sets `paper` fill and an ink border, the same on every band.
- **Small:** 0.35rem 0.7rem, 0.82rem.

### Top Bar
Sticky, ground at 88% with `saturate(1.2) blur(10px)`, hairline below. Wordmark left (drawn mark at 26px plus the uppercase name); nav right in `ink-2` at 0.88rem, hover and current page underlined in magenta. The landing ends the nav with the primary "Open the app" button; the app ends it with a quiet "About Batas". Below 46rem only the button remains.

### Inputs / Fields
- **Style:** `sunk` well, 1px `edge` border, 3px corners, B612 Mono 0.82rem/1.7, magenta caret; textareas resize vertically from 5.5rem.
- **Hover / Focus:** border darkens to `dim` on hover; focus sets a magenta border with the 3px magenta-wash halo.
- **Range:** the trade-size probe is a native range input with `accent-color: boundary`.

### State Marks
The airspeed indicator's arcs, in B612 700 at 0.8rem with a 0.7rem mark before the text: **inside** a filled disc, **caution** an open square with a 2px border, **never** a drawn diagonal cross. App tags are compact outlined labels (1px `currentColor` border, 2px corners, uppercase 0.72rem) in `inside` with a 0.45rem disc, or in `never` with a 0.5rem cross drawn from two crossed gradient strokes (never a typed "×").

### Pending Readings
While a live reading loads, the app shows static bars: 0.75rem tall, `sunk` fill, 1px `rule` border, 2px corners, at varied widths, on a container marked `aria-busy` with a screen-reader sentence naming what is being read. The landing shows the caution state mark with the same sentence.

### Envelope Plate (signature)
A chart panel, not a card: `paper` fill, 1px `edge` frame, 4px corners, plate lift, no outer margin. The head pairs a placard-label title with a mono "as of" timestamp. The SVG (560 by 340 units) draws axes in `ink-2`, horizontal grid lines in `grid`, the inside zone as a 13% green tint, the floor as a 2px `never` line, the cap as a 2px magenta dashed wall (6 4), refused zones hatched, and the pool curve in 2.25px blue labelled "what the pool pays today". The position's settled trades are plotted where they settled as green dots (radius 5.5, 2px `paper` ring) with a bold green count label. The probe marker is a paper disc with a 2px ink ring. Chart labels are set in the figure face at 13 units, which renders near 12px beside the headline at full container width; 16 units between 60rem and 76rem, where the plate is narrower, so desktop labels never render under 11px; 18 units below 40rem so they render near 10px on a phone. Below a hairline sit the probe label, the range input and a polite live readout that ends in a state mark.

### Hero Chart (decoration)
The chart the envelope plate is laid on, drawn after sectional-chart linework: a VOR compass rose in `structure` (radius 150, a tick every 5 degrees at 6 units, every 10 at 10, every 30 at 16, a magnetic-north arrow, turned 13 degrees off true north as a printed rose is) around the chart's hexagonal VOR symbol; a solid Class C ring in `boundary` (radius 320) with a soft 9-unit shelf band at 7% opacity; a dashed Class E surface ring in `boundary` (radius 236, dashes 9 6); and a meridian and a parallel in `edge` with minute ticks every 16 units, longer every 80. Rose at 32% opacity, rings at 30 to 34%, graticule at 55%, strokes non-scaling. It carries no labels and no numbers, so it cannot be read as a claim about a place.

It is one inline SVG (760 units), `aria-hidden`, `pointer-events: none`, built once at module load, with no raster and no request. The hero is `isolation: isolate` and the SVG sits at `z-index: -1`, above the hero ground and under the content. At the two-column width its centre is 60px right of the envelope plate's right edge, vertically centred: the opaque plate covers its middle, so only outer linework shows in the right margin and above and below the plate, never behind the headline, lead, meaning or actions. Stacked (below 60rem) it shrinks to 440px with its centre on the hero's right edge, just below the bottom, so only its upper-left arcs show beside the two buttons. Checked at 1440x900 and 390x844 by hit-testing the painted linework against every text line box, both buttons and the plate: no overlap. It never moves.

### Limitations Placard
The artefact a pilot reads first: 2px ink frame, `paper` body, ink-filled head in placard label at +0.12em with a mono aside. Rows are hairline-ruled: uppercase row label (7.5rem), a bold figure, and an `ink-2` explanation at 0.84rem.

### Fuel Tape
A 2.6rem hatched track with a solid fill for what was kept (`inside`) or lost (`never`), drawn at its measured width; a placard-label head with the figure right-aligned, a mono scale beneath, and a foot line ending in a state mark. The app's health bars share the form on 1.6rem tracks.

### Tables and Facts
Tables collapse borders and rule rows with hairlines; heads are `dim`, 400, 0.78 to 0.8rem. The fare table gives the question 700 weight, the source `ink-2`, free prices a green "free", and the one paid row a 2px magenta top rule with the price in placard display at 1.5rem. Facts lists are definition grids with `dim` terms and figure values. The instruction table sets offsets `dim` and right-aligned, names bold blue, arguments mono `dim`.

### Notes and Footer
A note is `ink-2` copy at 0.9rem set off by a 1px `rule` hairline on its left, 1rem inset. The footer is `dim` at 0.84rem above a hairline, links in `ink-2`, ending with the licence line.

## Do's and Don'ts

### Do:
- **Do** take every colour from the tokens through `var(--token)`, and check any new text value on `ground`, `paper` and `sunk` against the 4.5:1 floor.
- **Do** carry every state with a mark as well as a colour: disc for inside, open square for caution, drawn cross for never.
- **Do** set every figure in B612 with `tabular-nums lining-nums`; use B612 Mono only for bytes, code, timestamps and scale ticks.
- **Do** keep the focus outline: 2px solid magenta, 3px offset, on every focusable element.
- **Do** serve faces from `/assets/fonts` and keep the page free of any third-party request.
- **Do** hatch loss and refused zones, and open major groups with a 2px ink rule across the top.
- **Do** show only real, reproducible figures read from a chain, a mirror node or a measured test; show caution while a reading is pending.
- **Do** keep everything still unless the visitor moves it; pointer responses stay at 0.14s or less, and the reduced-motion guard stays in place.

### Don't:
- **Don't** load fonts, scripts or styles from a CDN or any external host.
- **Don't** set a figure in B612 Mono or in running Barlow Condensed.
- **Don't** suppress or restyle away the focus outline.
- **Don't** let colour alone carry a state.
- **Don't** use magenta or blue for decoration; magenta is a limit or the way forward, blue is structure.
- **Don't** add illustrative or placeholder numbers.
- **Don't** animate on load: no fills, draws, loops or shimmer; the probe is the only moving thing.
- **Don't** use a text character as an icon; buttons are text only and marks are drawn.
- **Don't** add a coloured side stripe; side rules are 1px hairlines.
- **Don't** add a dark scheme, a `prefers-color-scheme` block, or an ink-filled band; the site is light only.
- **Don't** put the hero chart linework behind text, give it labels or numbers, or animate it.
- **Don't** build the DeFi landing default: black ground, glowing 3D object, headline metric row.
