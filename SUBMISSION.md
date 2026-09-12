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

**Short description** — 87 of the 100 characters allowed

```
An autonomous market maker on 1inch Aqua that cannot exceed the mandate it was granted.
```

**Description** — 4,629 characters against a 280 minimum

```
1inch Aqua is a shared liquidity layer where the maker never deposits anything. Tokens stay in their own wallet, Aqua keeps a ledger of allowances, and it pulls directly from that wallet at settlement. That removes custody risk and concentrates a different one, because Aqua.pull() checks nothing beyond msg.sender. Whichever app the maker ships to may take their tokens. The entire security model is one sentence: you trust the app you ship to. Hand that app to an autonomous agent and the question gets sharp — what stops it, and where is the stop enforced? Most agent tooling answers "in the application layer", which means nowhere, because anyone can call the contract directly and skip your checks.

Batas answers with a mandate: a size cap, a floor price, and an expiry.

The mandate IS the Aqua strategy. Aqua.ship() hashes the strategy bytes you hand it, and Batas passes the encoded mandate as those bytes, so the mandate hash and the strategy hash are the same value. The terms are not metadata attached to the position — they are its identity. An attacker can compile a program with the limits removed, but that is a different strategy hash, and the maker never shipped a token to it.

The limits are checked in the two places that gate the money. BatasApp validates them before AQUA.pull(), because after pull() the tokens have already left. And PolicyEnvelope, a new SwapVM instruction at third-party opcode slot 0x21, wraps the rest of the program: it delegates to runLoop() and inspects the settled registers when that returns. Placed first it is the outermost frame, so a fee appended behind the curve cannot push the amounts back out of bounds after the guard has passed, and in exactOut mode — where the input is only final once the curve has run — placement stops being something a program author can silently get wrong. It costs 933 gas.

What that is worth, measured rather than asserted: the same attacker against the same reserves, twice. Under a mandate, two trades at an average rate of 1.662 and 83% of the position still there. With no mandate, sixty-four trades at 0.270 — a seventh of where the pool opened — and it is gutted. Every one of those was an ordinary constant-product swap that no application-layer check was there to stop.

A second instruction at slot 0x22 makes the kill switch binding. The agent's authority is an ENSv2 subname: expiring, with the expiry compiled into the program's own deadline; revocable, because the grantor keeps ROLE_UNREGISTER; soulbound, because ROLE_CAN_TRANSFER_ADMIN is withheld. MandateName reads that registry during settlement, so revoking the name reverts the swap for every caller rather than only stopping an agent polite enough to ask. agent/killswitch.mjs --prove demonstrates it live: quote the position, revoke, quote again and get MandateNameNotHeld from a caller that has never heard of ENS, re-grant, and the position comes back at the same price.

The agent reads the live position, derives its floor from measured price movement rather than a constant, compiles the SwapVM program itself, checks its bytes against the deployed router's hash before shipping, and publishes the grant to Hedera Consensus Service. Run with --watch it keeps running the position: it renews inside the expiry window, docks the mandate it replaces, and stops acting the moment the name is revoked without needing to be restarted by the person who just stopped it.

A paid x402 endpoint on Hedera sells the one answer a counterparty cannot assemble alone: the decoded terms, the consensus timestamp on which those exact bytes became public, and the ERC-8004 identity behind the position with a check that it is held by the address that granted the mandate. Three of the four questions are free, deliberately — an agent should be able to refuse a position for nothing. agent/counterparty.mjs is that second agent: it finds the service through the host's own x402 discovery manifest, asks the free questions, walks away for free from a position it does not like, and pays a tenth of a cent only when a real doubt remains. Then it trades, and writes what it saw into ERC-8004's reputation registry — 143 basis points above the floor the mandate advertised. The registry refuses feedback from the agent's own owner, which is what makes that number worth reading.

Everything is live on Sepolia and Hedera testnet, and the repository is held to it: a README suite walks the document and asks the chain about every address, transaction, topic and timestamp it points at, and a deployment check compares the bytecode on Sepolia against this repository's build byte for byte.
```

**How it's made** — 4,890 characters against a 280 minimum

```
Solidity 0.8.30 with Foundry, via_ir, pinned to forge 1.8.0. Contracts: a Mandate struct and library, BatasApp (an Aqua application), PolicyEnvelope and MandateName (two new SwapVM instructions), and BatasRouter, a redeployment of SwapVM carrying both. Nothing in node_modules/@1inch/** is edited; the 1inch track permits redeploying a modified SwapVM. Off chain it is Node 24 and viem, an Express service on Vercel Functions, and an MCP server over stdio.

Two things about extending SwapVM that were learned the hard way. Extend AquaOpcodes, not Opcodes: the full set carries 24 instructions an Aqua strategy never reaches for, including every balance instruction, because in Aqua mode balances come from Aqua rather than from bytecode — carrying them puts the router at 28,618 bytes against EIP-170's 24,576 and it cannot be deployed at all. And not OpcodesDebug either, which overrides _runOpcode without re-declaring it virtual, so it is terminal: you can have custom opcodes or debug opcodes, not both.

The hacky part worth mentioning is the guard's own argument handling. InstructionArgs.at is a raw calldataload and 1inch documents plainly that the library does no bounds validation. For a fee or a curve that is a fair trade, because a misparse produces a visibly wrong price. For an instruction whose job is to refuse it produces a guard that passes, which is silent by construction: a PolicyEnvelope declaring sixteen argument bytes instead of thirty-two reads its floor out of the next instruction's bytes, and one that is last in the program reads past order.data entirely. Both instructions check their length. That finding is written up in UPSTREAM.md as a documentation suggestion for swap-vm.

A fuzz of 2000 runs compares the two enforcement surfaces on all five terms — it used to hold expiry and feeBps fixed, which excused the two most able to disagree, and unfixing them found a real one-second disagreement at the expiry boundary: SwapVM's Deadline is block.timestamp <= deadline and BatasApp was <, so for one second a mandate authorised a trade through the VM and refused it through the app.

Hedera: x402 through the Blocky402 facilitator, priced in HBAR rather than USDC because an HTS token must be associated with an account before it can be received, and that is one more step between a caller and an answer. Note that the official Hedera x402 proof of concept points its testnet config at x402.org and reaches for Blocky402 only on mainnet; Blocky402 does serve hedera:testnet, at api.testnet.blocky402.com, whose /supported sits at the root rather than under /v1. Copy the PoC as-is and you settle through the wrong facilitator with everything appearing to work. Grants and revocations are both published to a Hedera Consensus Service topic, readable by anyone with no account, because a ledger carrying only grants is the optimistic half of the story.

ENSv2 on Sepolia, through a UserRegistry proxy deployed by ENS's own VerifiableFactory. The registry's token id is the labelhash with its low 32 bits cleared — those hold a version counter it bumps on re-registration — so a plain keccak256(label) asks about a token that does not exist, and the zero address that comes back reads as revoked rather than as a wrong question. Both the off-chain reader and the on-chain instruction call findTokenId instead. Revocation also sets a name's expiry to the moment it happened rather than zeroing it, so a name the owner pulled and one that ran out are indistinguishable by timestamp; ownership is checked before expiry, because burning clears the owner and lapsing does not.

ERC-8004 identity and reputation, both on Sepolia. Two addresses circulate for these registries and the ones in most write-ups hold code on mainnet only, reading as empty on Sepolia — which looks exactly like a correct address for an unregistered agent. The reputation registry needed the same care: the address that circulates begins 0x8004B663056e9e57 and the live one begins 0x8004B663056A597D. What settles it is that getIdentityRegistry() on it answers with the identity registry this project already uses. The registration is a data: URI rather than a hosted link, because the point of an identity registry is that the answer survives.

Two implementation notes on reading chains that cost real time. Aqua's Shipped event indexes nothing at all — maker, app, strategy hash and strategy bytes all sit in the data — so a node cannot filter it and every consumer sifts client-side. And ethereum-sepolia-rpc.publicnode.com fronts a pool whose backends do not all hold the same receipts: asked eight times for a transaction demonstrably on the canonical chain, it answered seven, which turned the README suite red with a false claim about the chain. Measured five calls each before switching to rpc.sepolia.ethpandaops.io, which was 5/5 up at 532ms against publicnode's 4/5 at 1680ms.
```

**GitHub repository** — `PugarHuda/batas`, marked Primary. It is public, and the Hedera and 1inch
tracks both require that.

**The rules the form restates, and where this stands on each:** started from scratch — first
commit 6 September, the event opened on the 4th; version control with frequent commits — 60-odd
across the event, each one a single argued change; public repository — yes; video under four
minutes with no speed-ups — the script below targets 3:45 and says which two beats to cut rather
than accelerate.

## Partner prizes — pick these three

The form allows up to three. These are the three the project is actually built on.

### 1. Hedera — AI & Agentic Payments on Hedera ($6,000, up to 3 teams)

| Requirement | Where it is met |
|---|---|
| Live x402-gated service on Hedera via Blocky402 | https://batas-one.vercel.app/v1/mandate/explain, facilitator `api.testnet.blocky402.com` |
| A platform consuming it, ≥1 real paid request | `agent/counterparty.mjs` — a second agent that discovers the service through `/.well-known/x402`, asks the three free questions, and pays only when a real doubt remains. Settled `0.0.7162784@1789095743.757413333` |
| *Bonus:* multi-agent | two agents on opposite sides of one position: one grants the mandate, the other decides whether to trust it and buys the evidence |
| Public repo with README | yes |
| Demo video ≤5 min | the 2–4 min video below satisfies both this and ETHGlobal's limit |
| *Bonus:* pay-per-call metering | the endpoint charges per call, not per subscription |
| *Bonus:* ERC-8004 agent identity | agent #10123 in the identity registry, **and** client feedback in the reputation registry — `143bps above the floor`, written by the counterparty, which the contract will not let the agent write about itself |
| *Bonus:* HCS audit trail | topic `0.0.10394165`, publicly readable with no account |

Not claimed: HTS tokens (payment is in HBAR on purpose — an HTS token must be associated with an
account before it can be received, and that is one step between a caller and an answer), multi-agent
negotiation, scheduled transactions.

### 2. 1inch — Build an Aqua App ($5,000)

| Requirement | Where it is met |
|---|---|
| Official Aqua/SwapVM contracts | Aqua used as-is at `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`; nothing in `node_modules/@1inch/**` edited |
| Redeployed modified SwapVM (permitted, and scored higher) | `BatasRouter` carries two new instructions: `PolicyEnvelope` at `0x21` and `MandateName` at `0x22` |
| On-chain execution of token transfers, demoed | `script/Demo.s.sol` ships, settles and refuses in one run — real ERC-20 transfers, no mocked settlement |
| Proper git commit history | 47+ commits across the event, each one a single argued change |

### 3. ENS — Best Use of ENSv2 ($4,500)

| Requirement | Where it is met |
|---|---|
| Built on ENSv2, Sepolia | `UserRegistry` proxy via ENS's own `VerifiableFactory`, `0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B` |
| ENSv2 features central to the product | the subname *is* the agent's authority: expiry matches the mandate's own deadline, grantor keeps `ROLE_UNREGISTER`, `ROLE_CAN_TRANSFER_ADMIN` withheld so it is soulbound |
| Functional demo | `node agent/killswitch.mjs --prove` — revoke the name and the *settlement* refuses |
| Open source + video | yes |

The part worth leading with: `MandateName` is a SwapVM instruction at opcode slot `0x22` that reads
the ENSv2 registry during settlement. Revoking a subname does not merely stop a cooperating agent,
it reverts the swap for every caller. That makes ENSv2 an enforcement primitive rather than a
labelling one, which is not something the other ENS entries this project surveyed do.

---

## The video

2–4 minutes, enforced. 720p minimum, spoken narration by a human, no text-to-speech, not filmed on
a phone, no artificial speed-ups. Target **3:45**. Six beats, and the middle four are each a single
command.

**Before recording**

```bash
forge build --force                      # ~36s, so nothing compiles on camera
anvil --fork-url $SEPOLIA_RPC_URL &      # ~25s to be ready; the demo runs against this
curl -s https://batas-one.vercel.app/ >/dev/null   # warm the serverless cold start
```

Two terminals, font large enough to read at 720p.

**Check `SEPOLIA_RPC_URL` first.** It must not be `ethereum-sepolia-rpc.publicnode.com`. Measured
over five calls: publicnode was up 4/5 at 1680ms, and a fork through it made the demo beat take 71
seconds and then fail outright. `rpc.sepolia.ethpandaops.io` was 5/5 at 532ms and the same beat took
16. `sepolia.gateway.tenderly.co` is the alternate.

**Measured run times**, so nothing is a surprise on camera:

| Beat | Command | Takes |
|---|---|---|
| what it is worth | `forge test --match-test test_WhatTheMandateIsWorth -vv` | 1s |
| on chain, one run | `forge script … Demo.s.sol --broadcast` (fork) | 16s |
| the kill switch | `node agent/killswitch.mjs --prove` | **92s** — two Sepolia transactions |
| the other agent | `node agent/counterparty.mjs --paranoid --trade` | **103s** — Hedera payment, then two Sepolia transactions |

The last two are the ones to cut in. Each waits on a block twice; the quotes between them return
instantly, so cut on the waits and keep the answers.

**0:00–0:20 — the problem**

On screen: the `Aqua.pull()` snippet in the README.

> Aqua is a shared liquidity layer where the maker never deposits. Their tokens stay in their own
> wallet and Aqua pulls from it at settlement. And `pull` checks nothing except who is calling. So
> whichever app you ship to can take your tokens. That is the whole security model — you trust the
> app. Now hand that app to an autonomous agent.

**0:20–0:45 — where the stop lives**

On screen: `src/PolicyEnvelope.sol`, the `exec` function.

> Batas makes the mandate the strategy itself. Aqua hashes the strategy bytes, so the terms are the
> position's identity, not a label on it. And this is a new SwapVM instruction that wraps the whole
> program: it runs everything else inside itself and checks the amounts after they settle. Placed
> first, nothing can escape it.

**0:45–1:05 — what that is worth**

```bash
forge test --match-test test_WhatTheMandateIsWorth -vv
```

> The same attacker, the same reserves, twice. Under a mandate: two trades, average rate one point
> six six, eighty-three percent of the position still there. With no mandate: sixty-four trades,
> average rate nought point two seven — a seventh of where the pool opened — and it is gutted. Every
> one of those was an ordinary constant-product swap. Nothing in the application layer was there to
> stop them.

**1:05–1:50 — on chain, in one run** *(the 1inch requirement)*

```bash
forge script script/Demo.s.sol:Demo --rpc-url http://127.0.0.1:8545 --broadcast
```

> One command ships the mandate, settles a swap inside it, and then asks for a trade over the cap.
> Ten tokens in, nineteen point seven out — a real ERC-20 transfer to an address nobody holds the
> key for. Then a hundred and one against a cap of a hundred: refused, before any token moves. That
> revert data is the cap and the amount asked for, straight out of the VM.

**1:50–2:35 — the kill switch** *(the ENS requirement, and the strongest 45 seconds here)*

```bash
node agent/killswitch.mjs --prove
```

> The agent's authority is an ENSv2 subname — expiring, and that expiry is the same timestamp
> compiled into the program's deadline. Soulbound, because transfer admin was withheld. Revocable,
> because the grantor kept unregister. And it is not the agent that obeys it. Watch: quote the live
> position, one token in, one point nine five out. Revoke the name. Quote the same position again —
> refused, `MandateNameNotHeld`, from a caller that has never heard of ENS and would happily trade.
> Re-grant it, and the position comes back. The name is an instruction in the program, so revoking
> it stops every caller, not only the one that asks permission.

*(92 seconds measured end to end: two Sepolia transactions, roughly 40 seconds each. The three
quotes are eth_calls and return instantly, so cut on the two waits and keep the three answers.)*

**2:35–3:20 — the other agent pays** *(the Hedera requirement)*

```bash
node agent/counterparty.mjs --paranoid
```

> This is a different agent, with its own money and its own rules, arriving at a position it did not
> create. It finds the service through the host's own x402 discovery manifest — nothing is
> hard-coded. Then three free questions: what do the bytes permit, when did they become public on
> Hedera Consensus Service, does the name still hold. A position it does not like costs it nothing
> to refuse. Here everything checks out, so it settles a tenth of a cent over x402 for the one thing
> left — who is operating this, and whether their ERC-8004 identity is held by the address that
> granted the mandate. It is. It trades — one token in, one point nine five out — and then writes
> what it saw into ERC-8004's reputation registry: a hundred and forty-three basis points above the
> floor the mandate advertised. The registry will not let the agent say that about itself.

**3:20–3:45 — close**

> Three limits, checked in the two places that gate the money, publishable where anyone can read
> them without asking us, and endable by a name the settlement itself obeys. The agent picks the
> numbers. It cannot widen them once granted, and the maker can take the authority back in one
> transaction.

## Still to do

- [ ] Record and upload the video (only a human can do this part)
- [ ] Paste title, description, repo link into the Hacker Dashboard
- [ ] Select the three partner prizes above
- [ ] Submit before 13 September, 12:00 pm EDT
