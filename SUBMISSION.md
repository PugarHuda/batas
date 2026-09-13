# ETHOnline 2026 submission

Deadline: **Sunday 13 September 2026, 12:00 pm EDT**. The event ran 4–16 September; the first
commit here is 6 September, so this is a **Classic (from scratch)** project, not a Continuity one.

---

## The form, field by field

These are the fields the Hacker Dashboard actually asks for, in its order. Paste as-is.

**Project name**

```
Batas
```

**Category** — `DeFi`

**Emoji** — `🛑` (the mandate refuses; the field defaults to a placeholder that should not stay)

**Demonstration link**

```
https://batas-one.vercel.app
```

**Short description** — 94 of the 100 characters allowed

```
An agent runs your 1inch Aqua position under limits it cannot widen and a name you can revoke.
```

**Description** — the recommended form text, 2,091 characters against a 280 minimum. It is the
long one below with the argument kept and the anecdotes cut, because a judge reads this field on a
phone between two other projects. The long alternative follows it, for a reader who has already
decided to read.

```
1inch Aqua never takes custody: tokens stay in the maker's wallet and Aqua.pull() moves them at settlement, checking nothing but msg.sender. Whichever app you ship to can take your tokens. Hand that app to an autonomous agent and ask what stops it.

Batas answers with a mandate — a size cap, a floor price and an expiry — enforced where the tokens move. The encoded mandate is the Aqua strategy bytes, so the mandate hash is the strategy hash: a program with the limits removed is a different position nobody shipped tokens to. BatasApp checks the terms before AQUA.pull(). PolicyEnvelope, a new SwapVM instruction at opcode 0x21, wraps the whole program and checks the settled amounts, so nothing later can undo it. It costs 975 gas.

Measured: the same attacker against the same reserves, twice. Under a mandate, two trades at 1.662 and 83% of the position left. Without one, sixty-four ordinary constant-product swaps at 0.270 and 14% left.

The kill switch is an ENSv2 subname — expiring with the mandate, soulbound (ROLE_CAN_TRANSFER_ADMIN withheld), revocable (grantor keeps ROLE_UNREGISTER) — and MandateName, opcode 0x22, reads it during settlement. Revoke the name and every caller's swap reverts with MandateNameNotHeld. agent/killswitch.mjs --prove shows quote, revoke, refusal, re-grant, live.

The agent reads the position, derives its floor from measured price movement, compiles the program, checks its hash against the deployed router, ships, and publishes the grant to a Hedera Consensus Service topic. A second agent, agent/counterparty.mjs, finds the x402 service through /.well-known/x402, asks three free questions, and pays 0.001 HBAR only to learn who operates the position and whether their ERC-8004 identity (#10123) vouches. Then it trades and writes 60bps-above-floor feedback to the ERC-8004 reputation registry, which refuses the agent's own owner.

Everything is live on Sepolia and Hedera testnet. A test suite walks the README and asks the chain about every address, transaction and topic, and compares the deployed bytecode against this build byte for byte.
```

**Description, the long alternative** — 4,631 characters. Same claims, with the reasoning shown.

```
1inch Aqua is a shared liquidity layer where the maker never deposits anything. Tokens stay in their own wallet, Aqua keeps a ledger of allowances, and it pulls directly from that wallet at settlement. That removes custody risk and concentrates a different one, because Aqua.pull() checks nothing beyond msg.sender. Whichever app the maker ships to may take their tokens. The entire security model is one sentence: you trust the app you ship to. Hand that app to an autonomous agent and the question gets sharp — what stops it, and where is the stop enforced? Most agent tooling answers "in the application layer", which means nowhere, because anyone can call the contract directly and skip your checks.

Batas answers with a mandate: a size cap, a floor price, and an expiry.

The mandate IS the Aqua strategy. Aqua.ship() hashes the strategy bytes you hand it, and Batas passes the encoded mandate as those bytes, so the mandate hash and the strategy hash are the same value. The terms are not metadata attached to the position — they are its identity. An attacker can compile a program with the limits removed, but that is a different strategy hash, and the maker never shipped a token to it.

The limits are checked in the two places that gate the money. BatasApp validates them before AQUA.pull(), because after pull() the tokens have already left. And PolicyEnvelope, a new SwapVM instruction at third-party opcode slot 0x21, wraps the rest of the program: it delegates to runLoop() and inspects the settled registers when that returns. Placed first it is the outermost frame, so a fee appended behind the curve cannot push the amounts back out of bounds after the guard has passed, and in exactOut mode — where the input is only final once the curve has run — placement stops being something a program author can silently get wrong. It costs 975 gas.

What that is worth, measured rather than asserted: the same attacker against the same reserves, twice. Under a mandate, two trades at an average rate of 1.662 and 83% of the position still there. With no mandate, sixty-four trades at 0.270 — a seventh of where the pool opened — and it is gutted. Every one of those was an ordinary constant-product swap that no application-layer check was there to stop.

A second instruction at slot 0x22 makes the kill switch binding. The agent's authority is an ENSv2 subname: expiring, with the expiry compiled into the program's own deadline; revocable, because the grantor keeps ROLE_UNREGISTER; soulbound, because ROLE_CAN_TRANSFER_ADMIN is withheld. MandateName reads that registry during settlement, so revoking the name reverts the swap for every caller rather than only stopping an agent polite enough to ask. agent/killswitch.mjs --prove demonstrates it live: quote the position, revoke, quote again and get MandateNameNotHeld from a caller that has never heard of ENS, re-grant, and the position comes back at the same price.

The agent reads the live position, derives its floor from measured price movement rather than a constant, compiles the SwapVM program itself, checks its bytes against the deployed router's hash before shipping, and publishes the grant to Hedera Consensus Service. Run with --watch it keeps running the position: it renews inside the expiry window, docks the mandate it replaces, and stops acting the moment the name is revoked without needing to be restarted by the person who just stopped it.

A paid x402 endpoint on Hedera sells the one answer a counterparty cannot assemble alone: the decoded terms, the consensus timestamp on which those exact bytes became public, and the ERC-8004 identity behind the position with a check that it is held by the address that granted the mandate. Three of the four questions are free, deliberately — an agent should be able to refuse a position for nothing. agent/counterparty.mjs is that second agent: it finds the service through the host's own x402 discovery manifest, asks the free questions, walks away for free from a position it does not like, and pays a tenth of a cent only when a real doubt remains. Then it trades, and writes what it saw into ERC-8004's reputation registry — sixty basis points above the floor the mandate advertised. The registry refuses feedback from the agent's own owner, which is what makes that number worth reading.

Everything is live on Sepolia and Hedera testnet, and the repository is held to it: a README suite walks the document and asks the chain about every address, transaction, topic and timestamp it points at, and a deployment check compares the bytecode on Sepolia against this repository's build byte for byte.
```

**How it's made** — 5,939 characters against a 280 minimum

```
Solidity 0.8.30 with Foundry, via_ir, pinned to forge 1.8.0. Contracts: a Mandate struct and library, BatasApp (an Aqua application), PolicyEnvelope and MandateName (two new SwapVM instructions), and BatasRouter, a redeployment of SwapVM carrying both. Nothing in node_modules/@1inch/** is edited; the 1inch track permits redeploying a modified SwapVM. Off chain it is Node 24 and viem, an Express service on Vercel Functions, and an MCP server over stdio.

Two things about extending SwapVM that were learned the hard way. Extend AquaOpcodes, not Opcodes: the full set carries 24 instructions an Aqua strategy never reaches for, including every balance instruction, because in Aqua mode balances come from Aqua rather than from bytecode — carrying them puts the router at 28,618 bytes against EIP-170's 24,576 and it cannot be deployed at all. And not OpcodesDebug either, which overrides _runOpcode without re-declaring it virtual, so it is terminal: you can have custom opcodes or debug opcodes, not both.

The hacky part worth mentioning is the guard's own argument handling. InstructionArgs.at is a raw calldataload and 1inch documents plainly that the library does no bounds validation. For a fee or a curve that is a fair trade, because a misparse produces a visibly wrong price. For an instruction whose job is to refuse it produces a guard that passes, which is silent by construction: a PolicyEnvelope declaring sixteen argument bytes instead of thirty-two reads its floor out of the next instruction's bytes, and one that is last in the program reads past order.data entirely. Both instructions check their length. That finding is written up in UPSTREAM.md as a documentation suggestion for swap-vm.

A fuzz of 2000 runs compares the two enforcement surfaces on all five terms — it used to hold expiry and feeBps fixed, which excused the two most able to disagree, and unfixing them found a real one-second disagreement at the expiry boundary: SwapVM's Deadline is block.timestamp <= deadline and BatasApp was <, so for one second a mandate authorised a trade through the VM and refused it through the app.

Hedera: x402 through the Blocky402 facilitator, priced in HBAR rather than USDC because an HTS token must be associated with an account before it can be received, and that is one more step between a caller and an answer. Note that the official Hedera x402 proof of concept points its testnet config at x402.org and reaches for Blocky402 only on mainnet; Blocky402 does serve hedera:testnet, at api.testnet.blocky402.com, whose /supported sits at the root rather than under /v1. Copy the PoC as-is and you settle through the wrong facilitator with everything appearing to work. Grants and revocations are both published to a Hedera Consensus Service topic, readable by anyone with no account, because a ledger carrying only grants is the optimistic half of the story.

ENSv2 on Sepolia, through a UserRegistry proxy deployed by ENS's own VerifiableFactory. The registry's token id is the labelhash with its low 32 bits cleared — those hold a version counter it bumps on re-registration — so a plain keccak256(label) asks about a token that does not exist, and the zero address that comes back reads as revoked rather than as a wrong question. The off-chain reader calls findTokenId instead; the on-chain instruction hands keccak256(label) to getState, which strips the version bits itself — and getState is where the previous router was wrong: its interface listed the registry's State struct in documentation order rather than declaration order (status, expiry, latestOwner, tokenId, resource), so every settlement against a named mandate reverted while every test passed, because the mock matched the interface. A fork test now asks the deployed registry, and the router was redeployed. Revocation also sets a name's expiry to the moment it happened rather than zeroing it, so a name the owner pulled and one that ran out are indistinguishable by timestamp; ownership is checked before expiry, because burning clears the owner and lapsing does not.

ERC-8004 identity and reputation, both on Sepolia. Two addresses circulate for these registries and the ones in most write-ups hold code on mainnet only, reading as empty on Sepolia — which looks exactly like a correct address for an unregistered agent. The reputation registry needed the same care: the address that circulates begins 0x8004B663056e9e57 and the live one begins 0x8004B663056A597D. What settles it is that getIdentityRegistry() on it answers with the identity registry this project already uses. The registration is a data: URI rather than a hosted link, because the point of an identity registry is that the answer survives.

The service is described in formats other software already reads, all generated from one route table: /openapi.json (OpenAPI 3.1, with the free/paid split as an x-cost per operation), /.well-known/agent-card.json (an A2A Agent Card), and POST /mcp (the same four tools over Streamable HTTP). With BATAS_ATTEST_KEY set, the paid answer carries an EIP-712 attestation over its own canonical JSON. GET /v1/position/health joins the live position to its mandate — headroom to the floor, every settlement since the ship, and alert codes — and the page shows it as a "This morning" panel.

Two implementation notes on reading chains that cost real time. Aqua's Shipped event indexes nothing at all — maker, app, strategy hash and strategy bytes all sit in the data — so a node cannot filter it and every consumer sifts client-side. And ethereum-sepolia-rpc.publicnode.com fronts a pool whose backends do not all hold the same receipts: asked eight times for a transaction demonstrably on the canonical chain, it answered seven, which turned the README suite red with a false claim about the chain. Measured five calls each before switching to rpc.sepolia.ethpandaops.io, which was 5/5 up at 532ms against publicnode's 4/5 at 1680ms.
```

**GitHub repository** — `PugarHuda/batas`, marked Primary. It is public, and the Hedera and 1inch
tracks both require that.

**The rules the form restates, and where this stands on each:** started from scratch — first
commit 6 September, the event opened on the 4th; version control with frequent commits — 100 across
seven days, each one a single argued change; public repository — yes; video under four
minutes with no speed-ups — the storyboard below runs 3:50 and says which waits to cut rather than
accelerate. The suites at last count: `forge test` 72 passing, `node --test agent/*.test.mjs`
268 of 268 passing, Playwright 46 passing.

**AI disclosure.** The commits carry Claude co-author trailers: this was AI-assisted development,
and all code was reviewed, tested and deployed by the author.

## Partner prizes — pick these three

The form allows up to three. These are the three the project is actually built on. Each table
quotes the sponsor's own wording, so a row can be checked against the prize page rather than
against a paraphrase of it.

### 1. Hedera — AI & Agentic Payments on Hedera ($6,000)

| Qualification requirement | Where it is met |
|---|---|
| "Build an AI agent or multi-agent system that executes at least one payment, token transfer, or financial operation on Hedera Testnet" | `agent/counterparty.mjs` pays the x402 service from its own account and checks the settlement on the mirror node. Settled `0.0.7162784@1789254970.943070760` |
| "Use one or more of … Hedera Agent Kit, OpenClaw ACP, x402, A2A protocol, or Hedera SDKs directly" | x402 through Blocky402 (`@x402/hedera`), `@hiero-ledger/sdk` for HCS, and a Hedera Agent Kit adapter exported as `batas/hedera-agent-kit` |
| "a public GitHub repo with a README covering setup, architecture, and how the payment flow works" | README: *Running it* (setup), *The answer* (architecture), *Paying for what the bytecode says* (payment flow) |
| "a ≤ 5-minute demo video showing the agent performing autonomous payment actions" | the video below |

| Extra point | Status |
|---|---|
| "On-chain agent identity using ERC-8004 or HCS-14" | **met** — agent #10123 in the identity registry, and client feedback in the reputation registry (`60bps above the floor`), which the contract will not let the agent write about itself |
| "Pay-per-call inference, data, or compute metering rather than a flat per-request charge" | being built — today the price is a flat 0.001 HBAR per call |
| "Multi-agent negotiation and settlement via A2A or ACP" | being built — today the Agent Card is published but nothing negotiates over it |
| "Agent discovery via UCP, or a directory that makes your service findable by other agents" | being built — today discovery is `/.well-known/x402` on a host the caller already knows |
| "HTS tokens or custom fee schedules in the settlement path" | being built |
| "Verifiable payment audit trails on HCS" | being built — topic `0.0.10394165` carries mandate grants and revocations, not payments |
| "Recurring or streamed payments using Scheduled Transactions" | being built |

### 2. 1inch — Build an Aqua App ($5,000)

| Requirement | Where it is met |
|---|---|
| "a custom Aqua app that implements a sophisticated DeFi position … demonstrated through tests scripts or a UI" | a position whose size cap, floor and expiry are enforced inside settlement; shown by `script/Demo.s.sol`, the fork tests, and the live instrument at https://batas-one.vercel.app/app |
| "If you use SwapVM, you may modify SwapVM opcodes and define your own instructions" (scored higher) | `BatasRouter` carries two new instructions: `PolicyEnvelope` at `0x21` and `MandateName` at `0x22` |
| "Official Aqua/SwapVM contracts must be used (redeployments of a modified SwapVM contract is allowed)" | Aqua used as-is at `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`; nothing in `node_modules/@1inch/**` edited |
| "Onchain execution of token transfers should be presented during the final demo" | on Sepolia: ship [`0x9408b60a…`](https://sepolia.etherscan.io/tx/0x9408b60a7bfc5345f9909153f5d5bf97feb193b5716f3c0fae21c33b89830060), swap [`0x8cdec703…`](https://sepolia.etherscan.io/tx/0x8cdec703361527046d60199bae327b8db7e784d55622897eace87b51c5909275) — real ERC-20 transfers, no mocked settlement |
| "Proper Git commit history (no single-commit entries on the final day)" | 100 commits across seven days from 6 September, each one a single argued change |

### 3. ENS — Best Use of ENSv2 ($4,500)

| Qualification requirement | Where it is met |
|---|---|
| "Project must be built on ENSv2 (Sepolia)" | `UserRegistry` proxy via ENS's own `VerifiableFactory`, `0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B` |
| "ENSv2 features should be central to the product, not a cosmetic add-on" | `MandateName`, SwapVM opcode `0x22`, reads the registry during settlement: revoke the subname and the swap reverts for every caller |
| "Your demo must be functional and not just include hard-coded values" | `node agent/killswitch.mjs --prove` revokes, quotes, and re-grants against the live chain; `/v1/agent/authority` reads it block-pinned |
| "a video recording or link to a live demo (ideally both) … open source" | both, and the repository is public |

| Feature the prize names | Status |
|---|---|
| "deploy your own subname registry to tokenize and manage subnames under your own rules" | **met** — the registry above holds the agent's authority |
| "expiring, revocable, non-transferable" | **met** — expiry matches the mandate's deadline, the grantor keeps `ROLE_UNREGISTER`, `ROLE_CAN_TRANSFER_ADMIN` is withheld |
| "Enhanced Access Control … to delegate specific rights" | roles above are **met**; delegating a single text record to another account is being built |
| "Give subnames their own Permissioned Resolver" | being built |
| "resolve subnames straight off a parent's resolver with wildcard resolution" | being built |
| "record aliasing at the resolver level or namespace aliasing via a shared registry" | being built |
| "agents as namespaces, each with their own identity and permissions" (bonus) | being built — linking the name and ERC-8004 agent #10123 both ways |

---

## The video

2–4 minutes, enforced. 720p minimum, spoken narration by a human, no text-to-speech, not filmed on
a phone, no artificial speed-ups. Hard cuts are allowed and are captioned as cuts. Target **3:50**.

It opens on the number, not on the problem. A judge who gives the video fifteen seconds should
leave with *83% against 14%, same attacker*; everything after that is the explanation of how.

**Before recording**

```bash
forge build --force                      # ~36s, so nothing compiles on camera
anvil --fork-url $SEPOLIA_RPC_URL &      # ~40s to be ready on a public RPC; the demo runs against this, in a terminal never shown
curl -s https://batas-one.vercel.app/ >/dev/null   # warm the serverless cold start
node agent/killswitch.mjs                # read-only preflight: must print a quote, not "refused"
chcp 65001                               # Windows: so — and → render in the terminal
```

**Check `SEPOLIA_RPC_URL` first.** It must not be `ethereum-sepolia-rpc.publicnode.com`. Measured
over five calls: publicnode was up 4/5 at 1680ms, and a fork through it made the demo beat take 71
seconds and then fail outright. `rpc.sepolia.ethpandaops.io` was 5/5 at 532ms and the same beat took
16. `sepolia.gateway.tenderly.co` is the alternate.

**Measured raw run times**, so nothing is a surprise on camera: demo 16 s, killswitch 92 s,
counterparty 103 s. The last two each wait on Sepolia blocks (~40 s apiece); the quotes between the
waits return instantly, so every cut lands on a wait and keeps an answer.

### Shot list

| # | Time | On screen | Caption | Narration |
|---|---|---|---|---|
| 1 | 0:00–0:12 | browser, https://batas-one.vercel.app scrolled to *What a mandate is worth*, the two bars | **83% kept. 14% kept. Same attacker.** | Same attacker, same pool, twice. Under a mandate the position keeps eighty-three percent. Without one, fourteen. Sixty-four ordinary swaps, and nothing in the application layer was there to stop a single one. |
| 2 | 0:12–0:20 | `forge test --match-test test_WhatTheMandateIsWorth -vv` (1 s); hold on the three-line table | **2 trades at 1.662 · 64 at 0.270** | That is a test, not a slide. One second to run, and the pool opened at two point zero. |
| 3 | 0:20–0:38 | README, the `Aqua.pull()` snippet, zoomed on `_balances[maker][msg.sender]` and `safeTransferFrom(maker, to, amount)` | **Aqua.pull checks only msg.sender** | Here is why. Aqua never takes your tokens. They stay in your wallet, and at settlement Aqua pulls from it, checking one thing: who is calling. So whichever app you ship to can take everything. Now hand that app to an autonomous agent. |
| 4 | 0:38–0:58 | `src/PolicyEnvelope.sol`, `exec()`: cursor on `ctx.runLoop()`, then the error lines | **Mandate hash = strategy hash → Guard wraps the program. 975 gas.** | Batas makes the limits the position's identity. The encoded mandate is the strategy bytes Aqua hashes, so a program with the limits removed is a different position nobody funded. And this is a new SwapVM instruction. It runs the rest of the program inside itself and checks the settled amounts on the way out. Placed first, nothing can undo it. It costs nine hundred and seventy-five gas. |
| 5 | 1:00–1:32 | `forge script script/Demo.s.sol:Demo --rpc-url http://127.0.0.1:8545 --broadcast`; show `settled: in 10… out 19.74…`, then `refused 101… over the mandate's cap` with the revert data | **10 in → 19.74 out. Real ERC-20. → 101 in → refused. No token moved.** | One command against a Sepolia fork. It ships the mandate, settles a swap inside it: ten tokens in, nineteen point seven out, a real transfer. Then it asks for a hundred and one against a cap of a hundred. Refused before any token moves, and that revert data is the cap and the amount asked for, straight out of the VM. |
| 6a | 1:32–1:50 | `node agent/killswitch.mjs --prove`: header, then `quote 1 A, name held -> 1.95 B` | **The agent's authority is an ENS name** | Now the part that matters most. The agent's authority is an ENSv2 subname. It expires at the same second as the mandate's own deadline. It is soulbound, because transfer admin was withheld. And the maker kept the right to revoke it. First, quote the live position: one token in, one point nine five out. |
| 6b | 1:50–1:55 | `revoking "agent" …` | *Sepolia tx ~40 s, trimmed* | Revoke the name. |
| 6c | 1:55–2:10 | `quote 1 A, name revoked -> refused: MandateNameNotHeld …` — hold on this line alone, 15 s | **Revoked. Every caller refused.** | Quote the same position again. Refused. MandateNameNotHeld. And look at who asked: a caller that has never heard of ENS and would happily trade. The name is not a rule the agent follows. It is an instruction in the program, so revoking it stops everyone at once. |
| 6d | 2:10–2:14 | `re-granting "agent" …` | *Sepolia tx ~40 s, trimmed* | Grant it back. |
| 6e | 2:14–2:24 | `quote 1 A, name restored -> 1.95 B`, and the closing line | **Same position, same price, back.** | And the position comes back at the same price. One transaction to stop, one to resume, no cooperation needed from the thing you are stopping. |
| 7a | 2:24–2:40 | `node agent/counterparty.mjs --paranoid --trade`: discovery via `/.well-known/x402`, then the three free answers | **A stranger's agent, its own money** | This is a different agent with its own wallet and its own rules, arriving at a position it did not create. It finds the service through the host's x402 discovery manifest, nothing hard-coded, and asks three free questions: what do the bytes permit, when did they go public on Hedera, does the name still hold. |
| 7b | 2:40–2:52 | `every free check passed / --paranoid: buying the full answer regardless` (or `but the grant is only Ns old…` when the grant is under an hour old and --paranoid is omitted) → `paying 0.001 HBAR…` → `settled 0.0.7162784@…` → `vouches true` | **Refuse for free. Pay 0.001 HBAR for doubt.** | A position it does not like costs nothing to refuse. Here everything checks out but one doubt remains, so it pays a tenth of a cent over x402 for the one answer it cannot compute alone: who operates this, and whether their ERC-8004 identity is held by the address that granted the mandate. It is. |
| 7c | 2:52–3:12 | `traded 1 A in / received 1.952… B` → `leaving feedback: 60bps above the floor` → `feedback success 0x…` | **Trades. Then says so on chain: +60 bps** | So it trades. One token in, one point nine five out. Then it writes what it saw into the ERC-8004 reputation registry: sixty basis points above the floor the mandate advertised. The registry will not let the agent say that about itself. That is what makes the number worth reading. |
| 8 | 3:12–3:38 | browser, *The live position* panel: Publication / Authority / Reputation | **Sepolia · Hedera · ENSv2 · ERC-8004. Live.** | Everything you just saw is live and public. The terms, on Sepolia. When they became public, on Hedera Consensus Service, from a mirror node that is not ours. Whether the name still holds, from ENSv2. What counterparties said, from ERC-8004. Three limits, checked in the two places that gate the money, and endable by a name the settlement itself obeys. |
| 9 | 3:38–3:50 | black card: Batas · github.com/PugarHuda/batas · batas-one.vercel.app | *(the sentence)* | The agent picks the limits, the settlement enforces them, and the maker takes them back in one transaction. |

### Cut notes

Six cuts, all on waits, each captioned so the no-speed-up rule is visibly kept:

| Where | Raw | Kept | Caption, top right |
|---|---|---|---|
| shot 5, compile chatter before the broadcast | ~8 s | 0 | *fork broadcast, ~8 s trimmed* |
| shot 6b, the revoke transaction | ~40 s | 5 s | *Sepolia tx ~40 s, trimmed* |
| shot 6d, the re-grant transaction | ~40 s | 4 s | *Sepolia tx ~40 s, trimmed* |
| shot 7b, the x402 settlement | ~15 s | 3 s | *x402 settlement, trimmed* |
| shot 7c, the trade transaction | ~40 s | 4 s | *Sepolia tx ~40 s, trimmed* |
| shot 7c, the feedback transaction | ~40 s | 4 s | *Sepolia tx ~40 s, trimmed* |

Shot 6c is the emotional peak: slow the narration down and let `MandateNameNotHeld` sit on screen
by itself. Nothing else in the video earns fifteen seconds of one line.

### Recording notes

- **Record shot 6 first, twice.** It is the shot that matters and the one with two live
  transactions in it; a second take is cheap insurance.
- **Shot 7 needs the name held.** Finish shot 6 — re-grant confirmed on chain — before starting 7.
  Never run `killswitch` and `counterparty` at the same time; one revokes what the other needs.
- One fullscreen terminal, 18 px mono (Cascadia or JetBrains Mono), about 118 columns × 30 rows,
  dark `#0d1117` on `#e6edf3`, ligatures off, prompt `$ `, `clear` before every command. Anvil runs
  in a second terminal that is never on screen.
- Browser at 1280×720, 125% zoom, light theme, scrolled to position *before* the recording starts.
- Captions: a lower-third band, `rgba(0,0,0,.65)`, 64 px tall, Inter 700 at 28 px in white, at most
  eight words. The *trimmed* notices sit top right at 18 px.
- Windows: `chcp 65001` first, or the em dashes and arrows in the agents' output render as boxes.

## If we reach the finals

Twelve questions a judge on one of the three tracks is likely to ask, each with the two-sentence
answer and where in the repository it is proven.

**1inch**

1. *Why redeploy SwapVM at all — is there not already a rate guard?* There is: `RequireMinRate`
   wraps `runLoop` and refuses on a bad rate, but it is not in `AquaOpcodes`, so it was never
   reachable on the Aqua router without exactly this redeployment. The envelope adds what it lacks —
   a per-trade cap and a direction in one frame, an app-surface twin compiled from one struct, a
   name the settlement obeys, and a length check on its own arguments.
2. *Why enforce on two surfaces? Is one not enough?* Because the fuzz found them disagreeing by
   one second at the expiry boundary — `<=` on the VM, `<` on the app — and a mandate that says
   different things depending on which door a trade arrives through is not a mandate. Both surfaces
   compile from one `Mandate` struct, so drift is a test failure rather than a discovery.
3. *What does the guard cost?* 975 gas warmed, about 0.8% of a settlement, measured by
   `test_TheGuardCostsAlmostNothing` settling the same trade with and without the envelope. The
   first version of that test read 14,590, which was the price of a cold position rather than of the
   guard.
4. *What stops someone routing around it?* The mandate is the strategy hash, and Aqua refuses to
   re-ship a hash it has seen: a program with the limits removed is a different position the maker
   never shipped tokens to. `test_EveryRouteAroundTheMandateIsClosed` walks the list — over the cap,
   under the floor, exactOut around the cap, terms rewritten — against one funded position.

**Hedera**

5. *Why HBAR and not an HTS token?* An HTS token must be associated with an account before it can
   be received, which is one more step between a caller and an answer. The client caps itself at
   0.01 HBAR per call, and that cap is tested on an unfunded key, so CI proves it binds without
   holding a secret.
6. *Which facilitator, and why does it matter?* Blocky402's testnet facilitator at
   `api.testnet.blocky402.com`, whose `/supported` sits at the root rather than under `/v1`. The
   official Hedera PoC points testnet at x402.org and reaches for Blocky402 only on mainnet, so
   copying it settles through the wrong facilitator with everything appearing to work.
7. *Aqua's `Shipped` event already has the terms. Why HCS?* Because a block timestamp belongs to
   whichever RPC served it, and a consensus timestamp from a mirror node that is not ours answers
   *when did these exact bytes become public* to a stranger who trusts neither us nor their RPC.
   Revocations are published to the same topic, because a ledger carrying only grants is the
   optimistic half of the story.
8. *What exactly is paid for, if three of four questions are free?* The operator's identity and
   whether it vouches — whether the ERC-8004 registration is held by the address that granted the
   mandate. `qa/service.spec.mjs` asserts the free decode carries neither `publication` nor
   `operator`, so the free door cannot quietly become the paid one.

**ENS**

9. *What here is specific to ENSv2 rather than ENS?* A `UserRegistry` deployed through ENS's
   `VerifiableFactory`, with a role bitmap: the holder gets `0x1100000`, the grantor keeps
   `ROLE_UNREGISTER`, `ROLE_CAN_TRANSFER_ADMIN` is withheld so the name is soulbound, and the name's
   expiry equals the mandate's `Deadline`. `agent/ens.test.mjs` pins each withheld role, because a
   wrong shift is silent — the registration succeeds and simply permits more.
10. *Does revocation need the agent to cooperate?* No: opcode `0x22` calls the registry's
    `getState` during settlement, so a revoked name reverts every caller's swap, including one that
    has never heard of ENS. The token id is the labelhash with its low 32 bits cleared, read through
    `findTokenId` off chain and handed to `getState` as a plain labelhash on chain, which is why a
    re-grant works rather than reading as revoked forever.

**General**

11. *What does a mandate not bound?* The floor is a fixed rate, not an oracle, so it bounds how far
    trading walks this position's own price and not whether A is worth that anywhere else; the cap
    is per trade, not per period; and the agent is named in the hash but gated by nothing, because a
    position only one address may trade against is not liquidity. All three are stated in the README
    under *What a mandate does not bound*, with the economics of one maximum fill per term.
12. *How do we know what is deployed is what is in the repo?* `agent/deployed.test.mjs` compares
    the runtime bytecode on Sepolia against the local build byte for byte, metadata dropped and
    immutables blanked, and checks `verification/` still describes `src/`. `agent/readme.test.mjs`
    walks the README and asks the chain about every address, transaction, topic and sequence number
    it cites.

And the one that comes from the Ethereum Magicians thread rather than from a track: *a spend
mandate on the token's transfer path — is that not the same thing?* A transfer-path gate sees one
leg, so it can bound how much leaves and never what comes back; a floor can live in an account-layer
post-execution balance check or a signed limit order, but both bind one delegate or one order.
Enforcement at the venue sees both legs for every taker, which is the one property none of the
others have, and `docs/spend-mandate-reply.md` is that argument with the measurement behind it.

## Still to do

- [ ] Record and upload the video (only a human can do this part)
- [ ] Paste title, description, repo link into the Hacker Dashboard
- [ ] Select the three partner prizes above
- [ ] Submit before 13 September, 12:00 pm EDT
