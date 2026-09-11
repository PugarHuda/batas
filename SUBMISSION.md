# ETHOnline 2026 submission

Deadline: **Sunday 13 September 2026, 12:00 pm EDT**. The event ran 4–16 September; the first
commit here is 6 September, so this is a **Classic (from scratch)** project, not a Continuity one.

---

## The form

**Title**

```
Batas
```

**Short description**

```
Scoped, expiring authority for an autonomous market maker — enforced by the only contract
allowed to touch the maker's tokens, not by the app that shipped it.
```

**Description**

```
1inch Aqua is a shared liquidity layer where the maker never deposits anything. Tokens stay in
their wallet and Aqua pulls from it at settlement. Aqua.pull() checks nothing beyond msg.sender,
so whichever app you ship to may take your tokens: the entire security model is "you trust the
app you ship to". Hand that app to an autonomous agent and the question gets sharp — what stops
it, and where is the stop enforced?

Batas answers with a mandate: a size cap, a floor price and an expiry, enforced in the two places
that actually gate the money.

The mandate IS the Aqua strategy. Aqua.ship() hashes the strategy bytes, and Batas passes the
encoded mandate as those bytes, so the mandate hash and the strategy hash are the same value. The
terms are not metadata attached to the position, they are its identity — and Aqua refuses to
re-ship a hash it has seen, so they cannot be rewritten afterwards.

The limits are checked twice. BatasApp validates them before AQUA.pull(), because after pull() the
tokens have already left. And PolicyEnvelope, a new SwapVM instruction in the third-party opcode
slot 0x21, wraps the rest of the program: it delegates to runLoop() and inspects the settled
registers when that returns, the same way 1inch's own fee instructions are built. Placed first it
is the outermost frame, so a fee appended behind the curve cannot push the amounts back out of
bounds after the guard has passed. A 2000-run fuzz proves the two surfaces price and refuse
identically across all five terms — it found a one-second disagreement on the expiry boundary,
which is fixed and pinned.

The agent reads the live position, derives a floor from observed spot, compiles the SwapVM program
itself and checks its own bytes against the deployed router's hash before shipping. Its authority
is an ENSv2 subname: expiring, revocable, soulbound, and scoped by a role bitmap that withholds
transfer, unregister, renew and registrar. The agent consults it before acting, so revoking the
name stops it without touching the position or spending gas.

Every grant is published to Hedera Consensus Service, and a paid x402 endpoint on Hedera sells the
one answer a counterparty cannot compute alone: what a program's bytes actually permit, when those
exact bytes became public, and whether the ERC-8004 identity claiming to operate the position is
held by the address that granted it. Decoding is free arithmetic; provenance and identity are not.
The service is reachable from MCP, and three of its four tools are free — an assistant can
establish for nothing whether a mandate was published and whether the agent is still authorised,
then decide the full answer is worth 0.001 HBAR.

Everything is live on Sepolia and Hedera testnet. A README suite walks the document and asks the
chain about every address, transaction, topic and timestamp it points at, and a deployment check
compares the bytecode on Sepolia against this repository's build byte for byte.
```

**Repository**

```
https://github.com/PugarHuda/batas
```

**How it's made** — the three things worth telling a judge that the description does not:

- `AquaOpcodes`, not `Opcodes`: the full instruction set puts the router at 28,618 bytes against
  EIP-170's 24,576 and it cannot be deployed at all. Not `OpcodesDebug` either — it overrides
  `_runOpcode` without re-declaring it `virtual`, so custom opcodes and debug opcodes are mutually
  exclusive.
- The official Hedera x402 proof of concept points its *testnet* config at x402.org and reaches for
  Blocky402 only on mainnet. Copy it as-is and you settle through the wrong facilitator with
  everything appearing to work.
- ENSv2's `UserRegistry` token id is the labelhash with its low 32 bits cleared — a version counter
  it bumps on re-registration. A plain `keccak256(label)` asks about a token that does not exist,
  and the zero address that comes back reads as *revoked* rather than as a wrong question.

---

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
| *Bonus:* ERC-8004 agent identity | agent #10123, and the paid answer says whether it vouches |
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
forge build --force                      # so nothing compiles on camera
anvil --fork-url $SEPOLIA_RPC_URL &      # the demo runs against a fork; no gas, no waiting
curl -s https://batas-one.vercel.app/ >/dev/null   # warm the serverless cold start
```

Two terminals, font large enough to read at 720p.

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

*(Two Sepolia transactions inside that run, roughly 30 seconds each — cut between them rather than
waiting on camera. The three quotes are eth_calls and return instantly.)*

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
> granted the mandate. It is. It trades.

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
