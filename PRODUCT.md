# Product

Batas — a mandate a machine enforces. An autonomous agent can run a liquidity position on 1inch
Aqua and cannot exceed the terms it was granted, because the only contract allowed to touch the
maker's tokens refuses to settle a swap that breaks them.

## Platform

web

## Stack

Node + Express, server-rendered HTML as a single string (no build step, no CDN, no framework),
deployed as a Vercel Function. Solidity 0.8.30 / Foundry contracts on Ethereum Sepolia. viem for
chain reads. Playwright for the HTTP and browser suites.

## Users

**Primary: a maker or counterparty with money at stake.** Someone deciding whether to let an agent
run their liquidity, or whether to trade against a position an agent is running. They arrive
sceptical. They want to know what can be taken from them and who can stop it, and they will not
take a claim on trust.

Secondary: developers evaluating the 1inch Aqua, Hedera and ENSv2 integrations, and hackathon
judges with two minutes.

## Product Purpose

Make a trading mandate checkable by a stranger. The terms live as SwapVM bytecode on chain; this
service decodes them, proves when they were published, reports whether the agent's authority still
holds, and says who is behind it — so nobody has to trust the operator's word.

## Positioning

The industry's guardrails for agent wallets sit at the token transfer path and can only bound *how
much leaves*. Batas enforces inside the settlement venue, where both legs of a swap are visible, so
it bounds *what comes back* — a floor price, not only a size cap.

## Operating Context

Sepolia and Hedera testnet. Every value on the page is read live from a chain or a public mirror
node at page load; nothing is stored. Free routes are rate limited at 60/min/IP.

## Capabilities and Constraints

- No build step, no CDN, no external fonts or scripts: the page is a string the module returns, so
  it survives Vercel bundling with no file to find at runtime.
- `GET /` must serve HTML only to a caller whose `Accept` says `text/html`; every machine client
  still gets JSON at the same URL.
- Four questions are free (decode, publication, authority, reputation). The fifth — the whole answer
  assembled, with the ERC-8004 identity and whether it vouches for the maker — costs a metered price, from 0.001 HBAR, over
  x402, settled on Hedera testnet through the Blocky402 facilitator.
- Cold start on a serverless host: the first request after idle can answer 5xx; clients retry once.

## Brand Commitments

- The name **Batas** and its meaning: Indonesian for *mandate* — authority entrusted within limits
  that must not be exceeded. This is the product's whole thesis and is never softened.
- Every number shown is real and reproducible. No illustrative figures, no placeholder data.
- The page never advertises anything that cannot be checked from a chain or a public mirror node.

## Evidence on Hand

- A measured attack comparison: the same attacker against the same reserves, twice. Under a mandate
  the position kept 1667.53 tokenB across 2 trades at an average rate of 1.662; with nothing that
  refuses, 271.86 across 64 trades at 0.270. The guard that stopped it costs 975 gas.
- A live position on Sepolia with its full terms, publication record on Hedera Consensus Service,
  ENSv2 kill-switch state, and ERC-8004 reputation from counterparties.
- Contracts verified on Etherscan; the deployed bytecode is compared against the source on every
  test run.

## Product Principles

- "We could not check" and "there is nothing there" are different answers and are never conflated.
- A limit that is present but does not limit is reported as such.
- Anything a caller can compute from bytes they already hold is free; charging for arithmetic would
  be charging for nothing.

## Surfaces

Two, and they are kept distinct:

- **Landing (`/`)** — Persuade. For a maker or counterparty deciding whether this is safe. Carries
  the thesis, the measured proof, what it costs and why, and one way in.
- **App (`/app`)** — Operate. The working instrument: paste a program and read what it enforces,
  the live position, the morning health report, the kill-switch state, reputation.

## Accessibility & Inclusion

Keyboard reachable throughout; focus outlines are never suppressed. Contrast is measured on the
built result in both schemes, floor 4.5:1. Motion respects `prefers-reduced-motion`. The page must
hold at 390px with no horizontal scroll.
