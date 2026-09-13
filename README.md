# Batas

*Batas* — Indonesian for **mandate**: authority entrusted within limits that must not be exceeded.

An autonomous agent can run your liquidity position. It cannot exceed the terms you granted it,
because the only contract allowed to touch your tokens refuses to settle a swap that breaks them.

![The Batas landing page at batas-one.vercel.app: the operating envelope drawn from the live reserves](docs/web-ui.png)

*Powered by SwapVM — © Degensoft Ltd 2025. The router is a redeployment of 1inch's SwapVM carrying
two instructions of ours; see [License](#license).*

---

## In sixty seconds

A maker grants an agent a **cap, a floor and an expiry**. Those three terms are `abi.encode`d and
handed to `Aqua.ship()` as the strategy bytes, so the mandate hash *is* the strategy hash — the
terms are the position's identity, not a label on it. Two contracts then refuse to settle a swap
that breaks them, and both refuse before any token moves.

```mermaid
flowchart TB
    subgraph OFF["off chain"]
        AG["<b>Agent</b><br/>reads the position, picks the terms,<br/>compiles the program itself"]
        EN["<b>ENSv2 subname</b><br/>expiring · revocable · soulbound<br/><i>the settlement asks, every time</i>"]
        AG -. "may I act?" .-> EN
    end

    subgraph SEP["Sepolia"]
        MD["<b>Mandate</b><br/>cap · floor · direction · expiry<br/>fee · salt · name"]
        RT["<b>BatasRouter</b><br/>SwapVM + PolicyEnvelope 0x21<br/>+ MandateName 0x22"]
        AP["<b>BatasApp</b><br/>Aqua application"]
        AQ["<b>Aqua.pull</b><br/><i>checks only msg.sender</i>"]
        WL["<b>Maker's wallet</b><br/>tokens never left it"]
    end

    subgraph HED["Hedera"]
        HC["<b>HCS topic</b><br/>when these exact bytes<br/>became public"]
        XP["<b>x402 endpoint</b><br/>metered, from 0.001 HBAR, for the answer<br/>a stranger cannot compute"]
    end

    AG -- "abi.encode(mandate) = strategy bytes" --> MD
    MD -- "Aqua.ship hashes it" --> RT
    MD --> AP
    AG -- "publishes the bytes" --> HC
    RT -. "still held?" .-> EN
    AP -. "still held?" .-> EN
    RT -- "guard passes, then" --> AQ
    AP -- "guard passes, then" --> AQ
    AQ -- "transferFrom" --> WL
    HC -.-> XP
    RT -.-> XP
```

| What stops the agent | Where it is enforced | What it costs to check |
|---|---|---|
| trade larger than the cap | `PolicyEnvelope` inside the VM, and `BatasApp` before `pull()` | nothing — it reverts |
| price under the floor | same two surfaces, on the settled registers | nothing |
| a mandate past its expiry | `Deadline` in the program, and `BatasApp` | nothing |
| the maker changing their mind | the ENSv2 name the *settlement* consults (`MandateName`, slot `0x22`), or `Aqua.dock()` | one transaction |
| *"was this grant ever public?"* | Hedera Consensus Service, read from a public mirror node | nothing, and it does not route through us |

## See it work

```bash
npm run walkthrough              # free: everything anyone can verify without us
npm run walkthrough -- --paid    # and then settle the metered price for the rest
```

Five steps that read public chains and a public mirror node, then one that pays. The split is the
argument: the limits are arithmetic on bytes anyone holds, so they cost nothing and route through
nothing of ours. What the payment buys is one answer assembled across three networks — the terms,
the consensus timestamp on which those exact bytes became public, and the identity behind the
position with a check that it is held by the address that granted the mandate.

## The problem

1inch's [Aqua](https://github.com/1inch/aqua) is a shared liquidity layer where a maker never
deposits anything. Tokens stay in their wallet; Aqua keeps a ledger of allowances and pulls
directly from the wallet at settlement time. That design removes custody risk — and concentrates
a different one.

`Aqua.pull()` checks nothing beyond `msg.sender`:

```solidity
// Aqua.sol
function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to) external {
    Balance storage balance = _balances[maker][msg.sender][strategyHash][token];
    ...
    IERC20(token).safeTransferFrom(maker, to, amount);
}
```

Whichever app the maker shipped to may pull their tokens. The entire security model is one
sentence: **you trust the app you ship to.** Hand that app to an autonomous agent and the
question becomes sharp — what stops it, and where is the stop enforced?

Most agent tooling answers "in the application layer", which means nowhere: anyone can call the
contract directly and skip your checks.

## The answer

A **mandate** — a size cap, a floor price, and an expiry — enforced in the two places that
actually gate the money.

How long the grant lasts is the maker's to choose, through `BATAS_MANDATE_HOURS` — the demo script
and the agent read the same variable, so the two cannot disagree about a term. The default is two
hours. The deployed demo runs on thirty days so the position stays live long enough to be looked
at; an agent that picked its own term would be choosing the one limit it is least entitled to.

### 1. The mandate *is* the Aqua strategy

`Aqua.ship()` hashes the strategy bytes you hand it. Batas passes the encoded mandate as those
bytes, so the mandate hash and the strategy hash are the same value. The terms are not metadata
attached to the position; they are its identity. Aqua refuses to re-ship a hash it has already
seen, so the terms cannot be quietly rewritten afterwards.

`Shipped` also carries the full mandate in its event data, so the grant is publicly auditable
without storing a byte of it.

### 2. The limits are checked before tokens move

[`BatasApp`](src/BatasApp.sol) is a constant-product Aqua application. Every swap validates the
mandate *before* `AQUA.pull()`, because after `pull()` the tokens have already left.

### 3. And again inside the VM

[`PolicyEnvelope`](src/PolicyEnvelope.sol) is a new SwapVM instruction, built the way SwapVM's own
fee instructions are: it delegates the rest of the program to `runLoop()` and inspects the settled
registers when that returns. Placed first, it becomes the outermost frame of the program.

```mermaid
sequenceDiagram
    autonumber
    participant T as Taker
    participant R as BatasRouter
    participant P as PolicyEnvelope 0x21
    participant I as rest of the program
    participant A as Aqua
    participant M as Maker's wallet

    T->>R: swap(order, amountIn)
    R->>P: outermost instruction
    P->>I: runLoop()
    Note over I: Deadline · MandateName · FeeFlatIn · XYCSwap · Salt
    I-->>P: settled amountIn / amountOut
    P->>P: amountIn within the cap?
    P->>P: rate at or above the floor?
    Note over P: reverts here, or returns
    P-->>R: program complete
    R->>A: pull / push
    A->>M: transferFrom
```

Read the order once and the design falls out: every transfer in `SwapVM.swap` happens *after*
`runLoop()` has returned, and `PolicyEnvelope` runs its checks inside that call. The guard is not
merely early in the program — it is before settlement itself, on both surfaces.

Two properties follow that a plain sequential guard cannot offer:

- **Placement stops mattering.** In `exactOut` mode `amountIn` is only final once the swap curve
  has run, so a sequential guard has to sit after the curve — a rule a program author can silently
  get wrong.
- **Nothing can undo the check.** Later instructions execute *inside* the wrapper. A fee appended
  behind the curve cannot push the amounts back out of bounds once the guard has already passed.

And it is close to free. `test_TheGuardCostsAlmostNothing` settles the same trade twice over
identical reserves, once with the envelope wrapped around the program and once without it, and the
difference is **975 gas** — about 0.8% of a settlement. Both positions are warmed first, because
the first version of that test read the guard as costing 14,590, which was mostly the price of
being the first swap against a fresh position rather than the price of the guard. A policy nobody
can afford to enforce is a policy nobody enforces, so the number is measured rather than asserted
to be small.

`test_FeeBehindTheGuardStillCounted` pins exactly this. `FeeFlatIn` sits after the envelope in
program order, yet it executes inside it: at 0.3% the rate lands near 1.974 and passes a 1.9 floor,
while at 5% the same mandate refuses the trade. A guard that merely ran first would have passed
before the fee ever touched the amounts.

### 4. And the maker can end it, on chain

The three terms bound what a settlement may do. `MandateName`, at opcode slot `0x22`, bounds
*whether there is one at all*: it asks an ENSv2 registry whether a name is still held by the
address the mandate names, and reverts the swap if it is not.

This closes a gap this document described before it filled. An ENSv2 subname expressed the agent's
authority from the first day — expiring, revocable, soulbound — and the agent consulted it before
acting. Nothing on chain did. So revoking the name stopped *this* agent, because this agent asks,
and stopped nobody else: not a second copy of it with the check removed, and not an ordinary taker
arriving at a position that was still shipped. The name was a control over the operator, and the
maker's only controls over the money were the expiry and `Aqua.dock()`.

Now the settlement itself asks. `agent/killswitch.mjs --prove` demonstrates it against the live
position, with two Sepolia transactions and three `eth_call`s that cost nothing:

```
$ node agent/killswitch.mjs --prove

position   0x4ed644d49b49c00c8913b87d4af774b4cf224890674052f36218bf7bc2104921
router     0xaAC338aC7776b40F0f2757B824D188f8fbe35E8E
kill switch  registry 0x945800bd6cdd60521b64a12d7b3f12fc90916a6b
             holder   0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e
             name     "agent"

quote 1 A, name held      -> 1952840679837944719 B

revoking "agent" …
quote 1 A, name revoked   -> refused: MandateNameNotHeld — the name is not held by the address the mandate names

re-granting "agent" …
quote 1 A, name restored  -> 1952840679837944719 B

the name gates the settlement, not merely the agent.
```

The caller making those quotes has never heard of ENS and would happily trade. That is the point:
the maker gets a kill switch that costs one transaction and needs no cooperation from the thing it
stops.

Four details are load-bearing, and three of them are lessons this project had already paid for once.

**Ownership is checked before expiry, and the order is the whole point.** `unregister` does not
zero a name's expiry — it sets it to the moment of revocation — so a name the owner pulled and one
that ran out are indistinguishable by timestamp. The first version checked the expiry first and
reported every revocation as `MandateNameLapsed`, which is the same wrong answer this project
already fixed off chain: the operator of a stopped agent told it had run out of time when its
authority had in fact been taken away. Burning clears the owner and lapsing does not, so asking who
holds it first separates them.

**The token id is the registry's business, and so is the shape of its answer.** The id is the
labelhash with its low 32 bits cleared, and those hold a version counter the registry bumps on
re-registration. The off-chain reader asks `findTokenId` for it; the instruction passes
`keccak256(label)` to `getState`, which accepts any id form and strips the version bits itself, so
the settlement path makes one call rather than two. That is also why the re-grant in that transcript
works: the name has a new id afterwards, and the registry resolves it either way.

`getState` is also where the router before this one was wrong, and how it was wrong is the lesson.
The interface declared the registry's `State` struct in the order the documentation describes it.
The registry returns it in the order the struct declares it — `status, expiry, latestOwner,
tokenId, resource` — and Solidity decodes a tuple by position, so the instruction read a status byte
as an expiry and a token id as an owner, and every settlement against a named mandate on that router
reverted with empty data. Every contract test passed while it did, because the mock registry had
been written to match the interface rather than the chain; a test double that agrees with your
declaration proves only that you declared it consistently.
`test_TheLiveRegistryAnswersInTheOrderTheInterfaceDeclares` now forks Sepolia and asks the deployed
registry — it skips without `SEPOLIA_RPC_URL`, so a fresh clone stays green offline — because a
disagreement between an interface and the contract it describes is a class of bug only a fork can
catch. The router and the app were redeployed for it, and `agent/deployed.test.mjs` holds this
repository to those two.

**The argument length is checked.** `InstructionArgs` performs no bounds validation, so a truncated
`MandateName` reads its registry address out of whatever follows it in calldata. A misparsed fee
produces a wrong price and somebody notices; a guard pointed at a contract that is not a registry
is a guard that passes.

**The expiry rule is strictly greater than, and deliberately not the rule the mandate's own
deadline uses.** SwapVM's `Deadline` is `block.timestamp <= deadline`, so a mandate is live through
its final second; a name is expired *at* its expiry, and `classifyName` off chain says so too. Each
surface matches the system it mirrors rather than matching the other one.

Naming no registry is a real choice rather than a default. Such a mandate is still a coherent grant
— it ends at its expiry, and the maker can still dock the position — and it is one fewer external
call on the settlement path. `explain()` reports which kind you are looking at as a fact rather
than as a warning.

## What already exists, and what does not

This is a crowded problem and an empty position. Both halves are worth stating plainly, and the
first is easier to state as a table than as a paragraph, because the field is not one thing.

| System | Enforced where | Bounds | Binds whom | Sees the second leg | Counterparty can verify |
|---|---|---|---|---|---|
| [Coinbase Spend Permissions](https://github.com/coinbase/spend-permissions) | on-chain, account | per-tx, per-period, expiry, revoke | the spender's key | no | yes |
| [MetaMask Delegation Framework](https://docs.metamask.io/smart-accounts-kit/reference/delegation/caveats/) (ERC-7710, draft) | on-chain caveats | per-tx, period, streaming, targets/methods/calldata, time, revoke, post-execution balance delta | the delegate | yes, per redemption (`ERC20BalanceChangeEnforcer`) | yes |
| [ERC-7579 Smart Sessions](https://docs.rhinestone.dev/smart-wallet/smart-sessions/overview) (Rhinestone/Biconomy) | on-chain validator | ERC-20 spend, value, timeframe, usage count, calldata rules | the session key | no | yes |
| [Zodiac Roles v2](https://github.com/gnosisguild/zodiac-modifier-roles) on Safe | on-chain module | targets, functions, param conditions, allowances | the role holder | no | yes |
| [Privy](https://docs.privy.io/controls/policies/overview) · [Turnkey](https://docs.turnkey.com/features/policies/delegated-access/agentic-wallets) · [CDP Agentic Wallets](https://eco.com/support/en/articles/14845485-coinbase-agentic-wallets-explained) · [Circle Agent Wallets](https://developers.circle.com/agent-stack/agent-wallets) | off-chain, enclave / policy server | value, recipients, calldata, chain, session caps | the signing key | no | no |
| [Openfort](https://www.openfort.io/blog/programmable-wallet-controls) · [Crossmint](https://www.crossmint.com/learn/agent-wallets-compared) | both: policy server + smart-account session keys | per-tx, per-period, allowlists, expiry | the session key | no | on-chain half only |
| [ERC-8226 RAMS](https://eips.ethereum.org/EIPS/eip-8226) (draft) · [Asset-Enforced Spend Mandate](https://ethereum-magicians.org/t/erc-asset-enforced-spend-mandate/28831) (discussion) | on-chain, token/registry | per-tx, cumulative (8226), allowed tokens, expiry, revoke, freeze | the agent, per asset | no | yes |
| [1inch Limit Order Protocol](https://github.com/1inch/limit-order-protocol/blob/master/description.md) | on-chain, venue, per order | limit price, expiry, allowed taker, predicates | one signed order | yes | yes |
| [Hyperliquid API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets) | venue (L1) | trade-only scope, no withdraw, ≤180-day expiry | the agent key | n/a | yes |
| [AP2 mandates](https://github.com/google-agentic-commerce/AP2) · [x402 client caps](https://github.com/x402-foundation/x402) | off-chain, signed intents / client SDK | price cap, expiry, merchant allowlist, per-payment cap | the agent, per purchase | n/a | signature only |
| **Batas** | on-chain, inside settlement (SwapVM frame + Aqua app) | per-trade cap, rate floor, direction, expiry, ENSv2 kill switch | **every taker against the position** | yes, on settled registers | yes, plus paid attestation |

Read the fourth column down and the position is visible. Most agent policy is enforced either off
chain at signing (Turnkey, Privy, CDP Agentic Wallets, Circle) or on chain in the agent's own
account (Coinbase Spend Permissions, MetaMask caveat enforcers, Smart Sessions, Zodiac Roles,
Openfort session keys). The second kind is verifiable and non-advisory — an earlier version of this
paragraph said all of it ran before a signature and off chain, which was wrong for most of the field
— but it binds the agent's key, not the position. Nothing stops a different caller from trading
against the same liquidity, and none of it can express a floor on what the position receives except
per-redemption balance checks on the delegate's own account. `PolicyEnvelope` runs during
settlement, has no prompt, and reverts for whoever arrived.

Three things in that last row appear in no other:

1. **The bound binds the counterparty, not the agent's key.** Every taker is refused at the same
   cap, floor and expiry; revoking the name stops takers, not just the operator. Every other row
   constrains the party that was given a key, and says nothing about the party that was not.
2. **The policy is the position's identity and cannot be edited.** The terms are hashed into the
   Aqua strategy hash, and Aqua refuses to re-ship a hash it has seen. Every other system's policy
   is a mutable record — a caveat, a session, a role, a row in a policy server — that the party
   holding admin can change.
3. **A counterparty-facing paid attestation with a timestamp that is not ours.** x402 for the
   answer, HCS for when the bytes became public, ERC-8004 for the identity behind them and what
   the last taker got above the floor. Openfort's own documentation concedes that an off-chain
   policy "can only be proven by the party running the engine"; the point of the last column is
   that here it can be proven by anyone.

**The problem is not speculative.** The **Asset-Enforced Spend Mandate** draft, posted to Ethereum
Magicians on 18 June 2026 (thread 28831), proposes token-level guardrails for agent wallets: a
`spendGate` on the transfer path, `checkTransfer` returning reason codes like `EXPIRED` and
`OVER_TX_CAP`. It reaches for the same word and nearly the same error taxonomy as this repository.
A Brickken ERC-8226 co-author and a MetaMask Delegation Framework contributor replied in the
thread, and neither raised the one-leg limitation.

That limitation is the ceiling of the approach. A gate on the token's transfer path sees one leg,
so a rate floor cannot live there. It can live in an account-layer post-execution balance check —
MetaMask's balance-change enforcers, paired with a transfer-amount enforcer, are a per-redemption
rate floor — or in a signed limit order, which is a rate floor and an expiry at the venue. But both
bound one delegate's or one order's execution. Batas puts the floor inside the venue so it binds
every settlement against the position, whoever the taker is.

[`docs/spend-mandate-reply.md`](docs/spend-mandate-reply.md) is that argument written out for the
thread, with the measurement behind it and two places where the draft's layer is clearly the better
one. It is drafted rather than posted: it goes out under a person's name, so that is their call.
[`UPSTREAM.md`](UPSTREAM.md) holds two findings on the same terms — one for swap-vm about what
changes when an instruction's job is to refuse rather than to price, and one for Foundry about
`forge build` and `forge test` writing different bytecode for the same contract.

**Judgement is not enforcement.** [ENShell](https://ethglobal.com/showcase/enshell-6t95y)
(ETHGlobal Cannes 2026 finalist, Chainlink CRE prize) routes agent intents through Chainlink CRE to
an LLM that scores them and answers approve/escalate/block, and gates on an on-chain strike count
(`AgentFirewall`, on Sepolia). The strike count is enforced; the score that feeds it is a judgement
made from a prompt, and a judgement can be argued with. A cap cannot.

**1inch has a wrapping rate guard of its own, and this document used to say otherwise.** An
earlier version of this paragraph claimed nobody had written a policy instruction for SwapVM. That
was wrong: `RequireMinRate` in the vendor tree (`instructions/MinRate.sol`) delegates to `runLoop`
and refuses when the settled rate is worse than a floor — the floor half of `PolicyEnvelope`, in
the 0xb0 rates bank. It is not in `AquaOpcodes`, so it was never reachable on the Aqua router
without the same redeployment this project makes, and it carries no size cap, no direction, no
kill switch and no length check on its own arguments. What is new here is the rest: a per-trade cap
and a direction in the same frame, an app-surface twin compiled from one struct so the two cannot
drift, a name the settlement obeys, and a guard that refuses to read its limits out of the
instruction that follows it. The two Aqua winners went deep into the VM in other directions:
[Aqua0](https://ethglobal.com/showcase/aqua0-u2krx) (Buenos Aires 2025, 1inch 4th, since incubated
by 1inch) built new AMM curves as AquaApps across chains, and
[KSwap-VM](https://ethglobal.com/showcase/kswap-vm-aix5n) (Lisbon 2026, 1inch 3rd) wrote
K-framework semantics and proofs for the *existing* swap-vm instructions, filing real bug reports
against them. Market structure and verification.

**Naming an agent is not the novel part, and this repo does not claim it is.**
[HumanENS](https://ethglobal.com/showcase/humanens-9qp31) issues per-agent subnames behind World ID,
[AgentRadar](https://ethglobal.com/showcase/agentradar-4dx17) resolves ERC-8004 agents through a
wildcard CCIP-Read resolver and ranks them, and Uniforum gave debating Uniswap agents subdomain
identities. Batas uses ENSv2 for something those do not: the subname is not a label but the
**revocation lever**. The holder is granted `0x1100000` and nothing more, `UNREGISTER` and `RENEW`
stay with the grantor, and withholding `ROLE_CAN_TRANSFER_ADMIN` makes the grant soulbound. Read
[The name is a kill switch, not a label](#the-name-is-a-kill-switch-not-a-label) for the bitmap.

**And the paid endpoint sells a different good than its neighbours.** Hedera's x402 bounty closed in
July 2026 with five winners; the two published ones — Pinout and Mystic — meter a resource by the
second. `/v1/mandate/explain` meters the reads an answer takes, not seconds of a resource, and what
it sells is a verdict that the party asking for it cannot produce alone: what a program's bytes actually permit, and whether the identity claiming to operate
it holds the registration it names.

What the table's other rows do that this one does not is not hidden either; it is under
[What a mandate does not bound](#what-a-mandate-does-not-bound), because a comparison that lists
only the column you win is an advertisement.

## Where to look

| What | File |
|---|---|
| Mandate terms, and why the hash is the strategy hash | [`src/Mandate.sol`](src/Mandate.sol) |
| Aqua application; limits checked before `pull()` | [`src/BatasApp.sol`](src/BatasApp.sol) |
| Wrapping SwapVM instruction, opcode slot `0x21` | [`src/PolicyEnvelope.sol`](src/PolicyEnvelope.sol) |
| The kill switch as an instruction, slot `0x22` | [`src/MandateName.sol`](src/MandateName.sol) |
| Router carrying the extended instruction set | [`src/BatasRouter.sol`](src/BatasRouter.sol) |
| Aqua-layer tests | [`test/BatasApp.t.sol`](test/BatasApp.t.sol) |
| VM-layer tests | [`test/PolicyEnvelope.t.sol`](test/PolicyEnvelope.t.sol) |

Nothing in `node_modules/@1inch/**` is edited. `BatasOpcodes` claims two of the `_Ix` slots
`OpcodeList.sol` reserves per family bank for third parties — `_21` and `_22`, in the 0x20-0x3f
conditions and access guards bank, beside `Deadline` and the taker gates, which is the right bank
for both: one bounds what a settlement may do, the other bounds who may still cause one. The router is a redeployment, which
the 1inch track permits.

Two things about which base class to extend, both learned the hard way (the sizes below are from the first deployment; the router carrying both instructions is 21,132 bytes):

> **`AquaOpcodes`, not `Opcodes`.** The full set carries 24 instructions an Aqua strategy never
> reaches for, including every balance instruction, because in Aqua mode balances come from Aqua
> rather than from bytecode. Carrying them puts the router at 28,618 bytes against EIP-170's
> 24,576 and it cannot be deployed at all. On `AquaOpcodes` it is 20,623.
>
> **Not `OpcodesDebug` either.** That layer overrides `_runOpcode` without re-declaring it
> `virtual`, so it is terminal — you can have custom opcodes *or* debug opcodes, not both.

## Running it

```bash
foundryup -i 1.8.0    # exactly: agent/deployed.test.mjs compares Sepolia against what this forge emits
npm install
npm test              # contracts, decoder, and the paid API surface
```

Four suites, run separately if you prefer:

| Suite | Command | What it covers |
|---|---|---|
| Contracts | `npm run test:sol` | Both enforcement surfaces, plus 2000 fuzz runs on their agreement |
| JavaScript | `npm run test:js` | The decoder, strategy recovery, and encoder parity with Solidity |
| Paid API | `npm run test:api` | Playwright against a local x402 endpoint, including what its 402 promises |
| Deployment | `npm run test:prod` | The same assertions against the URL the on-chain identity advertises |

The deployment suite runs daily in CI, and on a button, rather than on push: a push is what
causes the deploy, so the two race and the suite would report the deployment behind a commit it
has not been given time to become. Both times production actually fell behind, it was caught by
somebody remembering to run this by hand.

The API suite starts the service itself and asserts the payment requirement without spending
anything, so it runs anywhere. Settling a real payment needs Hedera credentials; that path is
exercised by `agent/inspect.mjs`.

### A cap that could never bind

The agent picked a floor 2% under spot and a cap of 10% of the reserve, as two independent
choices. They contradict: moving 10% of a constant product reserve walks the price about 9%, far
through a 2% floor. **The maximum trade the mandate advertised was one its own floor would refuse**
— a limit that reads like a limit and can never bind, which is worse than having none.

They are not independent choices at all. Solving the constant product for the largest input that
still clears the floor, after the fee, gives

```
amountIn ≤ reserveA · (slippage − fee) / ((1 − slippage)(1 − fee))
```

which at a 2% budget and a 0.3% fee is about **1.74% of the reserve**, not 10%. The cap is derived
from the floor now, and `capBps` only ever tightens it further.

The closed form is exact over the rationals and lands a hair under the floor once every step
rounds toward the maker, so the result is checked against the same arithmetic the contracts use
rather than trusted. Stepping down by wei does not converge — shrinking the input shrinks the
output in step, so both sides of the inequality move together — which is why the haircut is
relative. A position too small for the arithmetic to price gets a cap of zero, because a mandate
that permits nothing is safe and one that names an unreachable maximum is not.

### Two encoders, one format

The agent builds SwapVM programs in JavaScript; the contracts build them in Solidity through
`MandateLib.toProgram`. A program is just bytes, so nothing on chain would object to the two
drifting apart — which is exactly what had happened. **The agent was silently omitting the
`Deadline` instruction, so every mandate it granted was authority with no end**, while the project
described expiry as one of three terms.

`script/DumpPrograms.s.sol` now prints what Solidity emits for a fixed set of mandates, and
`agent/encoder-parity.test.mjs` runs it and asserts the JavaScript encoder produces the same bytes
case by case. Both sides now compile from one place, and one test asserts every compiled mandate
carries an expiry at all.

### A bug the fuzzer found

`testFuzz_SurfacesAgreeOnArbitraryTerms` failed at 1 wei of input. A 0.3% fee rounds up to the
entire input, leaving the curve nothing to price, so the output is zero. The VM refused the trade
through the order's `allowZeroAmountIn` trait; `BatasApp` accepted it, and the taker would have
paid a wei for nothing.

That is exactly the failure the agreement tests exist to catch — not one surface being wrong on its
own, but the two of them meaning different things. `BatasApp` now refuses zero output too.

### And one the tests could not run until it was fixed

`agent/inspect.mjs` recovered a program from Aqua's stored strategy by counting ABI words by hand.
`abi.encode(Order)` opens with an offset word because `Order` has a dynamic member, and the
hand-rolled version skipped it — surfacing as `Cannot convert 0x to a BigInt` from deep inside a
decoder, which sends you looking in the wrong place entirely. It uses viem's
`decodeAbiParameters` now, because the layout is already known by something that is not us.

Writing the test for it exposed a second problem: the file called `main()` at module scope, so
importing it ran the whole paid flow as a side effect of loading. `inspect.mjs`, `identity.mjs`
and `batas-agent.mjs` now only run when invoked directly.

### The fix that was never deployed

`BatasApp` on Sepolia was a version behind. `ZeroAmountOut` — the guard added after the fuzzer
found that a one-wei input has its whole value eaten by the rounded-up fee, leaving the taker
paying for nothing — existed in the source, in the tests and in this document, and not on chain.

Nothing looked wrong. The tests passed, the address held code, the explorer showed a verified
contract, and `verification/` offered a standard-json input to reproduce it. That input was a copy
of the source from before the fix, so it agreed with the deployment and disagreed with the
repository.

The first attempt to check this was wrong too. Searching the deployed bytecode for the error's
selector said "absent", which happened to be the right answer for the wrong reason — under
`via_ir` the optimizer does not leave selectors lying around as searchable constants, and the same
search on the freshly deployed contract also said "absent".

What settles it is comparing the whole runtime: metadata dropped, because it hashes the source
layout, and immutables blanked, because the artifact stores them as zeroes and the constructor
writes them. The old app came out 2,777 bytes against 2,797 in the source, first differing at byte
493.

`agent/deployed.test.mjs` does that comparison on every run, for both contracts, and checks that
the verification inputs still match the files they claim to be. A repository that says what is
deployed should be able to prove it.

It found one more thing immediately, and it was not what it looked like. The comparison passed
locally and failed in CI at byte 1,169, so the first guess was the toolchain — CI installed
`stable` while the deployment came from 1.8.0. Pinning it changed nothing. The lengths were the
clue: 20,596 bytes built against 20,538 on chain, with every jump destination after that point
shifted by the difference.

`forge build` and `forge test` do not compile `src/` the same way.

```
forge clean && forge build   →  BatasRouter runtime 20,538 bytes
forge clean && forge test    →  BatasRouter runtime 20,596 bytes
```

The deployed contract is the first, because that is what `forge create` produces. CI ran only
`forge test`, so it compared the chain against an artifact no deployment ever came from. The cause
took a second look to pin down and was not the tests: `forge test` compiles without `script/`, and
under via-IR the presence of any one of the three deployment scripts in the compilation unit — even
one that never imports the router — moves a few bytes of the router's optimised output. Adding or
removing files under `test/` leaves the hash alone. So the rule is about `script/`, and the fix is
the same either way: build first, test after. **The
bytecode a Foundry project deploys is not the bytecode its tests exercise**, which is worth knowing
independently of this check — and which nothing here would have surfaced without it.

CI now runs `npm run build:contracts` first; `forge test` afterwards reuses the cache rather than
replacing it. `--force` because the cache decides rather than the command — whichever compiled
first wins, so a warm tree from a test run survives a plain `forge build`, which is how this bit me
a second time after I thought it was fixed. The toolchain stays pinned anyway, because everything
else already is.

### What coverage found that reading did not

`forge coverage` reported lines, statements and functions at 100% and **branches at 16%**. Foundry
mis-attributes branches under `via-ir`, so the number itself is not worth much; what it was worth
was checking which reverts any test actually asserted. Three had none.

`InsufficientOutputAmount` — the taker's own slippage bound, never exercised. `ZeroAmountOut` — the
guard added to fix a bug the fuzzer found, asserted nowhere by name, so removing it would have
shown up only as a disagreement between two surfaces rather than as a failure. And `swap` hands
control to `msg.sender` after the output has left and before payment is checked, the same shape as
a flash swap, with a `nonReentrantStrategy` lock that nothing had ever tried to break.

The lock holds. Re-entering a *different* position of the same maker is allowed — the key is
`(maker, strategyHash)` — and that is now pinned too, because a per-position lock is the kind of
narrowing that looks like an oversight until someone checks the accounting survives it.

### A guard that read its limits from its neighbours

`InstructionArgs.at` is a raw `calldataload`, and 1inch says so plainly: *"the library does not
implement out-of-bounds read validations"*. Arg length is the program author's problem. For a fee
or a curve that is a fair trade — a misparse produces a wrong price and somebody notices. For
`PolicyEnvelope` it produces a guard that passes.

An envelope declaring sixteen bytes of args instead of thirty-two read `minRateE18` out of the
instruction that followed it. Removing the new length check and running
`test_RevertWhenEnvelopeArgsAreTruncated` gives a floor of
`148889121703133190954033214317794426880` — a position that refuses everything. That direction is
an accident of the layout: the value comes from whatever bytes happen to sit after the envelope,
and an envelope that is the last instruction reads past `order.data` entirely. A guard whose
strictness depends on its neighbours is not a guard.

It also settled a disagreement. The decoder in `agent/swapvm.mjs` already refused a short envelope
rather than half-reading it, so until now the report and the chain described different programs.

`parse` checks the length. The router was redeployed and re-verified for it.

### The same bug, twice, on opposite sides of the fence

The JavaScript agent once built its program instruction by instruction and left `Deadline` out, so
every mandate it granted was permanent. That was fixed by giving both sides one encoder —
`MandateLib.toProgram` in Solidity, `toProgram` in `agent/swapvm.mjs` — and a parity test that
compiles the first and compares it to the second.

`script/Demo.s.sol` was still chaining instructions by hand. It shipped four of the five, and the
one it dropped was `Deadline` again. Nothing caught it: the parity test compares the two encoders
to each other and says nothing about who calls them, and the mandate on chain decoded perfectly —
`101` cap, `1.92` floor, `0.3%` fee — with an expiry field that was simply absent.

Two things changed. The demo builds a `Mandate` and calls `MandateLib.toProgram`, so there is no
longer a second place to get it wrong. And `explain()` now says so out loud:

```
notes
  - No deadline: this mandate never expires and can only be ended by revoking it.
```

That omission was the one gap in the report. A missing cap was called out, a missing floor was
called out, an expiry in the past was called out — and the most open-ended grant of the set went
unremarked, in the answer people pay for. The program that shipped without a deadline is kept in
`swapvm.test.mjs` as the fixture for that note, because it is the real shape of the failure rather
than a constructed one.

Every dependency is pinned to an exact commit or version. That is deliberate: 1inch replaced
`InstructionBuilder` with a `MemoryPtr` streaming API during this hackathon, and an unpinned
install would silently hand a judge a different API than these tests pass on.

`verification/` holds the standard-json compiler input for each contract, for anyone who wants to
reproduce the bytecode independently of the explorer.

### Live on Sepolia

Aqua is already deployed on Sepolia, so the liquidity layer is used as-is. Only our own contracts
went out.

All four are source-verified on Etherscan — the router and the app are full matches on Sourcify
too — so the code below can be read on the explorer rather than taken from this repo on trust.

| Contract | Address |
|---|---|
| Aqua (canonical, not ours) | [`0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`](https://sepolia.etherscan.io/address/0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a) |
| `BatasRouter` (SwapVM + PolicyEnvelope + MandateName) | [`0xaAC338aC7776b40F0f2757B824D188f8fbe35E8E`](https://sepolia.etherscan.io/address/0xaAC338aC7776b40F0f2757B824D188f8fbe35E8E) |
| `BatasApp` | [`0xD2cB41A7E77af1171deb18A3c559c578f4D82146`](https://sepolia.etherscan.io/address/0xD2cB41A7E77af1171deb18A3c559c578f4D82146) |
| Demo token A | [`0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B`](https://sepolia.etherscan.io/address/0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B) |
| Demo token B | [`0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81`](https://sepolia.etherscan.io/address/0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81) |
| ERC-8004 identity registry (canonical) | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://sepolia.etherscan.io/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |

### Live on Hedera testnet

| What | Where |
|---|---|
| Mandate publication topic | [`0.0.10394165`](https://hashscan.io/testnet/topic/0.0.10394165) |
| Inspection service, paid | [`0.0.10388560`](https://hashscan.io/testnet/account/0.0.10388560) |
| Agent, paying | [`0.0.10388401`](https://hashscan.io/testnet/account/0.0.10388401) |

The topic is readable by anyone, with no account and no key:
`https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10394165/messages`

```bash
cp .env.example .env    # then fill in SEPOLIA_PRIVATE_KEY
forge script script/Deploy.s.sol:Deploy --rpc-url $SEPOLIA_RPC_URL --broadcast
forge script script/Demo.s.sol:Demo     --rpc-url $SEPOLIA_RPC_URL --broadcast
node agent/batas-agent.mjs
```

The demo and the agent default to the addresses above, so they run against a live position with no
setup. To point them at your own deployment instead, set `BATAS_ROUTER`, `BATAS_TOKEN_A` and
`BATAS_TOKEN_B` in `.env` — nothing needs editing in the source.

The whole chain is exercised against a local fork before each release:

```bash
anvil --fork-url $SEPOLIA_RPC_URL &
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
BATAS_ROUTER=<deployed> BATAS_TOKEN_A=<deployed> BATAS_TOKEN_B=<deployed>   forge script script/Demo.s.sol:Demo --rpc-url http://127.0.0.1:8545 --broadcast
```

> If `forge script --broadcast` fails to decode constructor arguments, `out/` is holding artifacts
> from source files that no longer exist and forge is matching a deployment against the wrong
> bytecode. `forge clean` fixes it. This bit us after a rename, and the failure mode is nasty
> because the script still prints plausible addresses while broadcasting nothing at all.

### A settled mandate, on-chain

`script/Demo.s.sol` grants a mandate and trades inside it against live Aqua. Real ERC-20
transfers, no mocked settlement:

| Step | Transaction |
|---|---|
| Ship liquidity under the mandate | [`0x9408b60a…`](https://sepolia.etherscan.io/tx/0x9408b60a7bfc5345f9909153f5d5bf97feb193b5716f3c0fae21c33b89830060) |
| Swap settled inside the mandate | [`0x8cdec703…`](https://sepolia.etherscan.io/tx/0x8cdec703361527046d60199bae327b8db7e784d55622897eace87b51c5909275) |

10 tokenA in, **19.743160687941225977 tokenB** out to
[`0x8474d483…`](https://sepolia.etherscan.io/address/0x8474d483Cc4374B8a16fE2D019717b23f0a5BD83) —
constant product less the 0.3% fee, judged against the 1.9 floor and allowed through.

An oversized trade against the same live position reverts with
`MandateAmountInExceeded(101e18, 100e18)` before any token moves — in the same run, right after the
settled one, so a single command shows both the trade the mandate allows and the trade it refuses:

```
settled: in 10000000000000000000 out 19743160687941225977
recipient received 19743160687941225977 of tokenB

refused 101000000000000000000 in, over the mandate's cap of 100000000000000000000
  revert data:
  0xb9f1dc1d00000000000000000000000000000000000000000000000579a814e10a7400000000000000000000000000000000000000000000000000056bc75e2d63100000
```

`0xb9f1dc1d` is `MandateAmountInExceeded(uint256,uint256)`; the two words after it are the amount
asked for and the cap that refused it. The refusal is a read-only call outside the broadcast, so it
costs nothing and does not fail the script — reverting is the result being demonstrated.

Each run salts the program, because Aqua permanently burns a strategy hash once it has been used.
`Salt` is the instruction that exists for exactly this: a no-op whose bytes change the program
hash, which is how the same terms get a fresh position.

### A banded, two-sided position (1inch Aqua)

The live position sells one direction along x*y=k. `agent/band.mjs` builds what a market maker would actually run, using only instructions the deployed BatasRouter already runs, so no new contract is needed:

```
JumpIfTokenIn(B) -> side 2
side 1, A in:  PolicyEnvelope(cap 500 A,  floor 1.96 B/A, aToB) · Deadline · Decay(600s) · FeeFlatIn(0.3%) · XYCConcentrate(1.8–2.2) · Jump(end)
side 2, B in:  PolicyEnvelope(cap 1000 B, floor 0.49 A/B, bToA) · Deadline · Decay(600s) · FeeFlatIn(0.3%) · XYCConcentrate(1.8–2.2) · Salt
```

- **Band:** all liquidity sits between 1.8 and 2.2 B per A (spot 2.0), so the same tokens give much deeper quotes near spot and run out at the edges.
- **A floor and a cap each way:** an envelope has one direction, so each branch gets its own. The only instruction before the envelopes is the jump, and a jump only picks which envelope runs.
- **Decay spread:** an immediate counter-trade gets a worse price, and the penalty fades to zero over 10 minutes.
- **Decoding:** `/v1/mandate/decode` reports the band as `guarded: true` with `mandate.sides`. Any jump outside that exact shape makes it report unguarded.

`npm run test:band` forks Sepolia with anvil, impersonates the maker, and ships to the real Aqua against the real router. Every balance change must match the JS mirror of the instructions to the wei:

```
band      1.8 – 2.2 B per A, spot 2
sell A    cap 500 A, floor 1.96 B/A
sell B    cap 1000 B, floor 0.49 A/B
fee       0.3%   decay 600s   program 272 bytes
shipped   906.866750716306163325 A / 1999.999999999999999999 B   hash 0x5d1b47be…c659cc   gas 85690
✔ the band ships to the real Aqua under the hash the deployed router computes
A → B     20 A in, 39.839234302834470749 B out, rate 1.991961715141723537
✔ selling A inside the band settles, and every balance moves exactly as priced
B → A     40 B in, 19.923696560570092498 A out, rate 0.498092414014252312
          decay spread cost the counter-trade 0.036750047654714491 A
✔ selling B back a minute later settles too, and pays the decay spread
refused   sell 480 A, under the 1.96 floor   MandateRateTooLow  (best rate 1.946208345931366881)
refused   sell 501 A, over the 500 A cap     MandateAmountInExceeded  (best rate 1.944169727723162668)
refused   sell 900 B, under the 0.49 floor   MandateRateTooLow  (best rate 0.487282197965157757)
refused   sell 1001 B, over the 1000 B cap   MandateAmountInExceeded  (best rate 0.486054730170726963)
refused   sell 2500 A, past the band edge    MandateAmountInExceeded  (best rate 1.891674322888669131, band drained)
✔ each side refuses past its cap, under its floor, and a trade that would drain the band
refused   sell 1 A after the deadline          DeadlineReached
✔ a trade inside every limit is still refused once the deadline passes
ℹ tests 5  pass 5  fail 0
```

No transaction reaches Sepolia. The fork runs on a free local port and is killed when the test ends.

### Checked against 1inch's official SDK

`agent/sdk-parity.test.mjs` (`npm run test:sdk`) reads the live Batas program from Sepolia and checks `agent/swapvm.mjs` against [`@1inch/swap-vm-sdk`](https://www.npmjs.com/package/@1inch/swap-vm-sdk) 0.4.4. It uses the SDK's own `ProgramBuilder`, opcode objects and argument coders, placed at the slots parsed from the `OpcodeList.sol` the router compiles against.

**Where they agree:**
- **Instructions the SDK defines.** `Deadline`, `XYCSwap` and `Salt` have the same opcode, offset, decoded arguments and bytes. This holds for the live program and for mandates at zero, typical and maximum deadline and salt.
- **Batas's own instructions.** The SDK has no `PolicyEnvelope` (0x21) or `MandateName` (0x22). Registered through its custom-instruction interface, they land at the same offsets `decodeProgram` reports, and the SDK writes the live program back byte for byte.
- **Program extraction and hashing.** `Order.decode` pulls out the same program from the shipped strategy. The SDK's Aqua rule, `keccak256(abi.encode(order))`, reproduces the live strategy hash, and `BatasRouter.hash` confirms it.

**Three places the SDK disagrees with the contracts Batas runs on.** Each is asserted with its bytes:
1. **Opcode numbering.** The SDK numbers opcodes as a dense array: `deadline` 13, `xycSwapXD` 17, `salt` 20, flat fee 21. `@1inch/swap-vm`'s `OpcodeList.sol` groups them by family: 0x20, 0x50, 0x02, 0x70. The SDK's `AquaProgramBuilder` fails on the live program. Worse, it silently reads 0x21 as `onlyTxOriginTokenBalanceNonZero`. With the table corrected, 0x21 and 0x22 decode as `empty` and their arguments are dropped.
2. **Flat fee.** `FeeFlat.sol` is `[uint24 feeBps]` on a 1e7 base. The SDK's `FlatFeeArgs` is a uint32 on a 1e9 base. The live 0.3% fee is `7003007530` on chain; the SDK's `AquaXYCAmmStrategy` writes 0.3% as `1504002dc6c0`, and its coder cannot read the on-chain one.
3. **Order data.** `MakerTraitsLib.build` puts tokenA and tokenB at the front of `data` and starts the data-slice offsets at 40. The SDK's `MakerTraits.encode` does neither. Round-tripped through the SDK, the live order becomes a different strategy: `0x1b03ef4c…` instead of `0x4ed644d4…`.

These are version gaps between the SDK and the contracts, not bugs in Batas's encoder. Batas's bytes match the Solidity that settles them.

## The agent

`agent/batas-agent.mjs` is the half the project is named for. It reads the live position on
Sepolia, decides what mandate to grant, encodes the SwapVM program itself, and ships it.

```bash
node agent/batas-agent.mjs          # observe and decide, no transaction
node agent/batas-agent.mjs --ship   # also grant the mandate it decided on
node agent/batas-agent.mjs --watch  # keep running it, rather than running once
```

`--watch` is what makes *an agent runs your position* true rather than aspirational. Until it
existed this was a command: it observed, decided, shipped and exited, and the word autonomous was
carrying a claim one invocation cannot support. A position is run over time — the mandate
approaches its deadline, the owner takes the name back and later hands it over again — and none of
that was anything the program could see.

```
watching every 300s; renewing inside 3600s of expiry
observing only; add --ship to let it act
...
renewal  706h left; nothing to do
```

It renews on **time and nothing else**. Not because the price moved — that is a decision rather
than an omission, since re-shipping burns a strategy hash and writes new terms, so an agent that
re-granted whenever spot drifted would be rewriting its own limits as a matter of routine, which is
the one thing this project exists to prevent it doing. `renewalDecision` is pure and pinned by
test, including that a live mandate carrying *no* deadline is replaced rather than read as "not due
yet".

**Renewing closes what it replaces**, and that is a gap the watch loop created rather than found.
Shipping a fresh position used to leave the previous one standing with its Aqua allowance intact,
so an agent left running for a week would accumulate live positions — each inside its own cap, and
none of them bounded by the others. The cap bounds a trade, the floor bounds a sequence, and
nothing bounded the number of sequences.

`Aqua.dock` keys on `msg.sender`, so only the maker can do it, and the agent does it immediately
after the new mandate is shipped — in that order, because a failure there should leave two live
positions rather than none. Docking is not emptying: `safeBalances` on a docked strategy *reverts*
rather than answering zero, so the replaced mandate stops being something anyone can trade against
at all.

Three guards, because a loop that sends transactions needs them: it ships only inside the renewal
window, never more than `--max-ships` times in one run, and the interval has a floor of 30 seconds
— an agent polling two chains every second is not attentive, it is a denial of service with good
intentions. A revoked name stops it acting without stopping the loop, because an agent that exited
on revocation would have to be restarted by the person who just demonstrated they can stop it
remotely.

A real run against the deployed position — read-only, so what it prints is a renewal it would
grant, judged against the mandate the position already runs under:

```
owner   0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E
router  0xaAC338aC7776b40F0f2757B824D188f8fbe35E8E
scanned 9000 blocks back from 11692084

observed 3 mandate(s); reading the newest
  hash   0x4ed644d49b49c00c8913b87d4af774b4cf224890674052f36218bf7bc2104921
  block  11692042

mandate name "agent": held and unexpired
  42761 minutes of authority left

reserves 1011 A / 1978.303998632220829304 B
spot     1.95677942495768628 B per A
  cap held at the previous mandate's 7.162902849964033514 A: renewal may tighten, never widen
  floor held at the previous mandate's 1.941043832593008104 B per A: renewal may tighten, never loosen

decision
  budget 108bps from 2 settled trade(s) — widest gap between settled trades was 108bps
  floor  1.941043832593008104 B per A  (0.80% under spot)
  cap    7.162902849964033514 A  (0.70% of what ships, the largest trade that still clears the floor)
  fee    0.3%
  expires in 2 hours

program  0x2121...056167656e74700300753050000208000000006aa5de5a (107 bytes)

encoding check
  local  0x1d4fa85b488edb400ac718f4fd18612ea061c6708b300411b7e146834d8a5dd5
  chain  0x1d4fa85b488edb400ac718f4fd18612ea061c6708b300411b7e146834d8a5dd5
  agree

run again with --ship to grant this mandate
```

Every number is read from the chain, including the slippage budget — which used to be 2% because
somebody typed 2%.

That number decides what the mandate refuses: too tight refuses every real trade, too loose
protects nothing. `volatilityBudget` reads the position's settled trades out of the router's
`Swapped` logs and takes the **widest gap between consecutive settlements**, clamped to 100-1000bps.

Be precise about what that measures, because the obvious reading is wrong. These are not
mid-prices: each rate is what a trade actually got, which already includes the slippage its own
size caused. What it measures is how far the price has moved between one settlement and the next
*at this position*, in practice, including the moving done by the trades themselves — which happens
to be exactly the quantity a floor has to survive. The widest gap rather than the average, because
a budget set to the typical move fails on the atypical one, and with a handful of samples there is
no percentile worth taking. A position with no history gets the 100bps floor, and the report says
which it got.

The floor is one budget under the spot the reserves imply, and the cap is derived from the floor -
which is what actually bounds how far one trade can walk the price.

The **encoding check** is the part worth pausing on. The agent assembles the instruction stream
itself, byte by byte, then asks the deployed router to hash the resulting order. If a single
opcode, length prefix or trait bit were wrong, the two hashes would differ and it refuses to ship.
The chain agrees rather than being taken on trust.

The mandate the position runs under was granted the same way, with `--ship`:
[`0x8c48c7d6…`](https://sepolia.etherscan.io/tx/0x8c48c7d63ff1752ab40ac34438ecaf078ee69c4c900a1874c27adc97c8efdf99),
published to the topic as `#13`, and the two-hour mandate it replaced was docked in the same run
([`0xa4997129…`](https://sepolia.etherscan.io/tx/0xa4997129b77f334333289013d8fad243c38fc2e1eb731a2adaf5a4cffeef3d45)).
Its expiry is the name's own — the agent caps a term at the authority it holds, because a mandate
that outlives the name that gates it is one nobody can switch off.

And the point of the whole design: the agent picks these numbers, but it cannot widen them once
granted. `PolicyEnvelope` enforces whatever it proposed, inside the VM, for as long as the mandate
lives.

### Two things the chain taught the encoder

`MakerTraits` for an Aqua-backed order with no hooks is the Aqua flag at bit 254 plus four `uint16`
order-data offsets, all 40, because `data` opens with two addresses and nothing else. That was
decoded from a live order rather than assumed.

`Aqua.Shipped` declares **no indexed parameters at all** — maker, app, strategy hash and strategy
bytes all sit in the data, and the log carries a single topic. A node therefore cannot filter these
events by maker or app, so the agent fetches and sifts client-side. Worth knowing before building
any indexer on Aqua.

## The mandate as a name

A mandate is authority granted within limits, for a while, revocably, to one holder. ENSv2 has all
four as primitives rather than as conventions someone agrees to honour, so the grant is expressed
as a name rather than described by one.

```bash
node agent/ens.mjs --deploy         # deploy the mandate registry, once
node agent/ens.mjs --grant agent    # grant a subname whose expiry matches the live mandate
node agent/ens.mjs --read agent     # what it currently authorises
node agent/ens.mjs --revoke agent   # take it back early
```

The registry is a `UserRegistry` proxy deployed through ENS's own `VerifiableFactory`, at
[`0x945800Bd…`](https://sepolia.etherscan.io/address/0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B).
Reading the granted name back off chain:

```
name          agent
expiry        2026-10-12T16:01:58.000Z
holder        0x1100000        SET_RESOLVER | SET_SUBREGISTRY
transferable  false
```

| Property of a mandate | ENSv2 primitive |
|---|---|
| Expiring | `expiry` is a parameter of `register()`, not a record anyone has to remember to check |
| Revocable | the grantor keeps `ROLE_UNREGISTER`; `unregister()` burns the token immediately |
| Non-transferable | `ROLE_CAN_TRANSFER_ADMIN` is withheld, so the name is soulbound to its holder |
| Scoped | the role bitmap names exactly what the holder may change, and nothing more |

**That expiry is not a coincidence.** It is read from the live position on chain and is the same
timestamp compiled into the program's `Deadline` instruction. The name and the authority it stands
for end at the same moment, because an identity that outlives the permission it represents is a
lie waiting to be believed.

### The name is a kill switch, not a label

The agent checks it before doing anything. Revoke the name and the agent stops, without touching
the position or spending anything on chain:

```
$ node agent/ens.mjs --revoke agent
revoked "agent"

$ node agent/batas-agent.mjs --ship
mandate name "agent": mandate name "agent" was revoked at 2026-09-06T22:18:24.000Z, ahead of its term
refusing to act without a valid mandate name

$ node agent/ens.mjs --grant agent      # and the agent resumes
mandate name "agent": held and unexpired
  43190 minutes of authority left
```

That check is what separates an integration from a mention: until the agent consulted the name,
"revocable" was a property the registry offered and nothing used.

> Running that cycle for real is what showed the report was wrong. `unregister` does not zero the
> expiry — it sets it to the moment of revocation — so a name the owner *pulled* and one that
> simply *ran out* both read as "expired", and the operator of a stopped agent was told the wrong
> reason. Worse, the branch meant to catch revocation was unreachable: it hung off a `try/catch`
> waiting for `ownerOf` to revert, and this registry answers a burned name with the zero address
> instead. Had the expiry check not shadowed it, the report would have been "held by 0x0000…",
> which is true and useless.
>
> Two signals separate them, and both cost nothing. `grant()` sets the name to expire with the
> mandate, so an expiry falling short of the mandate's own deadline means someone cut it short —
> and a name already burned while its term still runs is revoked outright. The judgement now lives
> in `classifyName`, apart from the chain reads, because logic that can only be exercised by
> sending a transaction does not get exercised.

> Making it load-bearing immediately exposed a bug. The registry's token id is the labelhash with
> its **low 32 bits cleared** — those hold a version counter it bumps on re-registration, so a
> stale approval cannot carry over to a name someone later re-registers. Passing a plain
> `keccak256(label)` asks about a token that does not exist, and the zero address that comes back
> reads as *revoked* rather than as a wrong question. The fix is to call the registry's own
> `findTokenId`; the re-grant above is visible in the token id ending `…561` where the first ended
> `…560`.

What the holder is refused matters as much as what it gets, and `agent/ens.test.mjs` pins each
one: no `ROLE_CAN_TRANSFER_ADMIN`, so the grant cannot be sold; no `ROLE_UNREGISTER`, so it cannot
erase the record of itself; no `ROLE_RENEW`, so it cannot extend its own authority; no
`ROLE_REGISTRAR`, so it cannot mint further names. Getting one of those shifts wrong is silent —
the registration still succeeds, the name simply permits more than intended.

> ENSv2 is in beta on Sepolia and the deployment moved once during this project: the registry
> contracts are a different size now than they were in August. Every address here was re-checked
> with `cast code` before use, and the role values came from the specification rather than from
> memory.

### The name is in the ENS hierarchy: agent.batas.eth

The mandate registry that the settlement reads ([`0x945800Bd…`](https://sepolia.etherscan.io/address/0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B)) is now the subregistry of **batas.eth** on ENSv2 Sepolia. The label `agent` that the kill switch checks is also the name `agent.batas.eth`, and any ENS client resolves it through ENS's own UniversalResolver. Registering batas.eth went through the ENSv2 registrar's commit and reveal ([commit](https://sepolia.etherscan.io/tx/0x0c8856d0243031abfa5a55cbc3d4c60040fe4d9d8e266ec8baca35cf729b96e5), [register](https://sepolia.etherscan.io/tx/0xe01d01d37a649db0a3573ad435913bf9530a594f5789d792d2ac22cee7dcb12f)). The mandate registry was set as its subregistry in that same registration. The records sit on a PermissionedResolver deployed through ENS's VerifiableFactory at [`0x671C506A…`](https://sepolia.etherscan.io/address/0x671C506Aaa2a123bE802Fe51975Ca9515AEC2516) ([deploy](https://sepolia.etherscan.io/tx/0xdcc86300c42270299558600463101617f3a91c94a17b86095e4a7aaa21ca9b6f)).

The `agent` label was pointed at that resolver ([tx](https://sepolia.etherscan.io/tx/0xfd6a6c72edb48ca778ce122d982699c76926e774e833b5fa867ff85e133f9613)), and the change touched nothing else. `getState` returns the same status, expiry, owner and token id before and after, so the kill switch did not move.

```bash
curl https://batas-one.vercel.app/v1/agent/name   # the same resolution, served live: records, alias, and the ENSIP-25 link
npm run ens:resolve          # agent.batas.eth through the UniversalResolver
npm run ens:verify           # ENSIP-25, both directions
node agent/ens.mjs --resolve mandate.batas.eth
```

```
agent.batas.eth
  resolver              0x671C506Aaa2a123bE802Fe51975Ca9515AEC2516
  addr                  0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E
  agent-endpoint[web]   https://batas-one.vercel.app
  agent-endpoint[mcp]   https://batas-one.vercel.app/mcp
  agent-endpoint[x402]  https://batas-one.vercel.app/.well-known/x402
  agent-context         what the agent is, where its kill switch lives, its ERC-8004 id
  agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][10123]  1
```

All of these records were written in [one multicall](https://sepolia.etherscan.io/tx/0x9d141f7051223969d48f49fce404b785780d21a7d1f4d6ba7778b5ec58eaa413).

| ENSv2 feature | What it does here |
|---|---|
| Subregistry | batas.eth → the existing mandate registry, so the name the settlement reads is also the name ENS resolves |
| PermissionedResolver | holds the ENSIP-26 agent records (`agent-context`, `agent-endpoint[...]`) and the ENSIP-25 `agent-registration` record |
| Wildcard | an unregistered label such as `anything.batas.eth` has no resolver of its own, so the UniversalResolver uses batas.eth's; it resolves and gets no records invented for it |
| Alias | `mandate.batas.eth` is registered nowhere. The resolver rewrites it to `agent.batas.eth` and answers with that name's records |
| Enhanced Access Control | the counterparty account holds `ROLE_SET_TEXT` on one key of one name ([grant](https://sepolia.etherscan.io/tx/0x3da4cc3543bad065175d920bdb63ca5deb6e1c54b8e7d78b7f5ac68a03f0e1cc)). It wrote that key itself ([tx](https://sepolia.etherscan.io/tx/0x09ab95bb180c7e7df8e5419c340b8ac5e23714522536e60647c23de3600276d2)), and the resolver refuses it `url`, the endpoint records, and the same key on batas.eth |

**ENSIP-25, both directions.** The name carries `agent-registration[<ERC-7930 registry>][10123] = 1`. ERC-8004 agent #10123's registration now lists `{ "name": "ENS", "endpoint": "agent.batas.eth" }` ([uri](https://sepolia.etherscan.io/tx/0x224e89f82d0cddf795f19f80abf7b33753ebfb7401bcccc8fbcde0653662d43c), [metadata](https://sepolia.etherscan.io/tx/0x3579958f264c9f5cf2db84c84d777354a29e8a57f5d4328c8f639b954c4b3b17)). `verifyAgentLink` accepts the link only when both halves agree. `mandate.batas.eth` shows why: it passes the forward check through its alias, but the registration does not claim it, so verification fails.

> One link could not be made. The mandate registry was initialised without `ROLE_SET_PARENT`, and no account holds that role's admin, so `setParent` is refused with `EACUnauthorizedAccountRoles(0, 256, maker)` and `getParent()` stays empty. Resolution never reads the parent link; it walks down from the root. The refusal is pinned in `agent/ens-hierarchy.test.mjs` so it is not forgotten.

## A name other software can look up

The agent is registered in the canonical
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Identity Registry as **agent #10123** on
Sepolia — [`0x7754ce40…`](https://sepolia.etherscan.io/tx/0x7754ce40fe3f6e892512965e1c4c23b43c52d9643b532eb6cfaaecefa42165e2).

```bash
node agent/identity.mjs                       # build the registration, simulate, show the id it would mint
node agent/identity.mjs --register            # mint it
node agent/identity.mjs --read 10123
node agent/identity.mjs --update 10123        # show what has drifted
node agent/identity.mjs --update 10123 --write
```

ERC-8004 is an ERC-721 whose token URI resolves to a file describing what an agent is and where to
reach it. The registry sits at `0x8004A818BFB912233c491871b3d84c89A494BD9e` — the same address on
Ethereum Sepolia **and** Hedera testnet, which happen to be the two chains this project runs on.
Both were checked for code before anything was written to either.

The registration is a `data:` URI rather than a hosted link. A hosted file is a promise that some
server stays up, and the point of an identity registry is that the answer survives. Alongside it,
metadata entries keep the on-chain facts queryable without fetching the URI at all:

```
batas.chain        eip155:11155111
batas.router       0xaAC338aC7776b40F0f2757B824D188f8fbe35E8E
batas.app          0xD2cB41A7E77af1171deb18A3c559c578f4D82146
batas.aqua         0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a
batas.enforcement  swapvm-opcode:0x21,0x22
batas.x402.network hedera:testnet
batas.x402.payTo   0.0.10388560
batas.hcs.topic    0.0.10394165
batas.ens.registry 0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B   the kill switch, discoverable from the identity
```

An earlier registration, agent #10120, named a source URL that turned out not to exist; #10123
replaces it. That is the cost of guessing at a fact instead of checking it.

Keeping it current is `--update`, not a second `--register`. Minting again would leave the first
identity standing and describing the same agent wrongly, with nothing to tell a reader which of the
two to believe. The update writes only what actually differs — it reads `getMetadata` for every key
first — so a run that changes nothing sends nothing.

Nothing is advertised that cannot be checked. No endpoint is listed that this repo does not serve,
because a registry full of dead links is worse than an empty one. The services list is what makes
the identity self-sufficient:

```
source     https://github.com/PugarHuda/batas
x402       https://batas-one.vercel.app/v1/mandate/explain
mandates   https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10394165/messages
```

The third one matters most. A reader who trusts neither this repository nor the paid endpoint can
still check any grant this agent made, on a mirror node that is public, unauthenticated, and not
ours. Identity leads to ledger; ledger holds the terms.

### The domain it names, proven

ERC-8004 lets an agent prove it controls an HTTPS endpoint domain by serving
`https://{domain}/.well-known/agent-registration.json` with a `registrations` entry that names its
on-chain id and registry. Agent #10123's URI is a `data:` URI, so no host serves the agentURI. Without
the well-known file, nothing would show that `batas-one.vercel.app` actually belongs to it.

The service publishes that file at
[`/.well-known/agent-registration.json`](https://batas-one.vercel.app/.well-known/agent-registration.json).
It is not a copy. On each request, with a one-minute cache, it reads what the registry holds for #10123,
so the file can only ever say what the token says.

Any agent can be checked the other way round:

```bash
node agent/domain-verify.mjs 10123
```

The script resolves the agent on Sepolia and fetches the well-known file from each distinct HTTPS
endpoint domain in its registration. It reports each domain as verified, or not verified with the
reason: unreachable, no registrations, or a registry/id mismatch. A domain that serves a hosted
agentURI counts as verified, as the spec allows. For #10123, `github.com` and the Hedera mirror node
are listed services, but they are not ours, and they come back not verified.

### And what anyone who traded here says about it

The identity registry answers *who is operating this position*. It cannot answer whether anyone has
traded against them and been treated well, and this project used one third of a standard whose
other two thirds are the part about trust.

ERC-8004's **reputation registry** is at
[`0x8004B663056A597D…`](https://sepolia.etherscan.io/address/0x8004B663056A597Dffe9eCcC1965A193B7388713),
and `getIdentityRegistry()` on it answers with the identity registry above — which is what actually
establishes the two are one deployment rather than two that happen to share a prefix. That check
was not ceremony: the addresses circulating for these include one beginning `0x8004B663056e9e57`,
which this document already warns about by name. The live one begins `0x8004B663056A597D`. Twelve
identical characters, then a different address.

```bash
npm run reputation 10123
node agent/counterparty.mjs --paranoid --trade    # trade, then say so on chain
```

The registry refuses feedback from the agent's own owner or operators:

```solidity
require(!isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed");
```

which is the property that makes any of it worth reading, and the reason this only became possible
once the counterparty had a wallet of its own. A maker praising their own agent is not a reputation
system, and the contract says so.

What gets written is not a rating. A star count about an autonomous market maker means nothing and
can be checked by nobody. The counterparty records **how far above its advertised floor the trade
actually settled**, in basis points, with the Hedera publication record as the feedback URI: two
numbers both parties hold and a pointer to the evidence, so a reader redoes the arithmetic instead
of trusting it.

```
  traded        1 A in
  received      1.952840679837944719 B
  leaving feedback: 60bps above the floor, tagged floor-honoured
  feedback      success  0x28f37ee5…
  reputation    4 feedback from 1 client(s), 106bps above the floor on average
```

A trade settled exactly on the floor scores zero — the mandate was honoured and nothing was given
away beyond it — and a negative score is representable on purpose. The contracts refuse a breach,
so a negative reading is not a complaint about service; it is a claim that the enforcement failed,
and a registry that could only carry good news would be worth nothing.

The **validation registry** is deliberately absent. The canonical repository lists none for Sepolia
— it is "still under active update and discussion with the TEE community" — and naming an address
for it would be inventing a deployment.

> Two addresses circulate for these registries. The ones in most write-ups —
> `0x8004A169…` and `0x8004BAa1…` — hold code on **mainnet only** and are empty on Sepolia. The
> testnet deployments in the official `erc-8004/erc-8004-contracts` repository are the pair above.
> Both were verified with `cast code` before use.

## Paying for what the bytecode says

A Batas position states its terms only as SwapVM bytecode. Anyone about to trade against one — or
about to let an agent run under it — has to decode that stream to find out what it actually
enforces. `agent/service.mjs` does that decoding and sells it per call over
[x402](https://www.x402.org/) on Hedera, settled through the
[Blocky402](https://blocky402.com/) facilitator.

Live at **https://batas-one.vercel.app** — the same Express app that runs locally, served by
Vercel Functions, so there is one implementation rather than a hosted copy that can drift.

```bash
curl https://batas-one.vercel.app/                       # free: what it sells and what it costs
node agent/inspect.mjs 0x2120...                         # pay the metered price and read the answer
BATAS_SERVICE_URL=http://localhost:4021 node agent/inspect.mjs 0x2120...   # against a local server
```

A serverless deployment answers its first request cold, and the facilitator handshake the paywall
needs runs on that request path, so the first caller after an idle period can see a 5xx where a
warm one sees the 402 immediately. `inspect.mjs` retries once. No payment is created for a failed
request, so the retry costs a second and nothing else.

A real settlement, confirmed on the Hedera mirror node:

```
result       SUCCESS
0.0.10388401  -0.001 HBAR     agent, paying
0.0.10388560  +0.001 HBAR     service, paid
0.0.7162784   -0.0024552      Blocky402 covering the network fee
```

No API key, no account, no subscription. The first request returns `402`, the client settles and
retries, and the payment is the authentication.

Decoded from the program the agent actually shipped, on a run of 2026-09-13 — the countdown in
the last line is why this is dated:

```
guarded by PolicyEnvelope: true
  @ 0 POLICY_ENVELOPE
  @35 DEADLINE
  @42 MANDATE_NAME
  @90 FEE_FLAT_IN
  @95 XYC_SWAP
  @97 SALT
enforced mandate
  max input   7.162902849964033514
  floor rate  1.941043832593008104
  direction   aToB
  fee         0.3%
  curve       constant product (x*y=k)
  expires     2026-10-12T16:01:58.000Z
  kill switch "agent" in 0x945800bd6cdd60521b64a12d7b3f12fc90916a6b
              held by 0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e
publication
  published   2026-09-12T23:12:30.035Z  (HCS consensus, topic 0.0.10394165 #13)
  granted by  0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e
  verify      https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10394165/messages/13
operator
  agent #10123  Batas
  held by     0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E
  vouches     yes — the identity is held by the address that granted the mandate
notes
  - The floor is a fixed rate chosen when this mandate was granted, not a reading of any
    market, and the mandate has 29 days left — past the 7 days this report treats as short.
    It bounds how far trading can walk this position's own price. If the market moves under
    it, trades that empty the position at a rate the maker would no longer accept still
    satisfy the mandate.
```

`guarded` is the field worth reading first. It is true only when `PolicyEnvelope` occupies the
outermost position; anywhere else, later instructions can undo whatever it checked, and the service
says so in plain words rather than leaving the caller to notice.

### Metered, not flat

`POST /v1/mandate/explain` is priced per request by the work the body asks for. The price is still settled with x402 `exact` on `hedera:testnet` through Blocky402. The paywall computes the price from the request body (`priceFor(body)` in `agent/service.mjs`, resolved by `@x402/core` as a dynamic price). The 402's `PAYMENT-REQUIRED` header states that exact amount. On the paid retry x402 recomputes the requirement from the same body and requires the signed payment to match, so a light quote cannot be replayed against a heavy body.

| Component | Tinybar | When |
|---|---|---|
| decode | 40,000 | always |
| instructions | 1,000 each, at most 256 billed | the program decodes |
| publication | 34,000 | the HCS mirror-node lookup runs |
| authority | 20,000 | the ENSv2 authority reads run |
| operator | 20,000 | a well-formed `agentId` (and `maker`, if given) is sent, so the ERC-8004 identity and reputation reads run |

The live mandate on its own (six instructions) costs exactly 0.001 HBAR (100,000 tinybar). With `agentId` and `maker` it costs 0.0012 HBAR. The most any request can cost is 0.0037 HBAR, under the 0.01 HBAR default cap in `agent/inspect.mjs`. A body that is not hex or does not decode is quoted the decode only, and x402 does not settle a 4xx answer.

Checking the bill: the paid answer carries `metering`, which lists each component and the total. `/.well-known/x402` publishes the rates and formula (`resources[0].metered`), and its `accepts[0].amount` is the ceiling. `GET /` and `/openapi.json` state the range.

```
{"program":"0x2121…"}                         -> 402 amount 100000
{"program":"0x2121…","agentId":"1","maker":…} -> 402 amount 120000
{"program":"0x5000…(200 instructions)","agentId":"1"} -> 402 amount 314000
```

### Every payment leaves an audit record

An x402 settlement is a public Hedera transaction, but the transaction only says that HBAR moved. It does not say what the HBAR bought. So once the mirror node confirms a settlement, `inspect.mjs` makes the **payer** publish a `batas.payment` record to the same HCS topic. The record holds the transaction id, payer, payee, amount in tinybars, asset, network, the resource URL, and a keccak256 of the exact request body and response body. The payer already holds a Hedera key, so the paid service needs no new secret for this. Anyone holding the two bodies can show that this payment bought that answer, at a consensus time neither party controls.

`node agent/hcs.mjs --payments` reads the trail back and checks each record against the ledger. A record counts as verified only if all of these hold:
- the HCS message was paid by the account the record names as payer (the topic has no submit key, so this is the signature)
- no earlier verified record claimed the same transaction
- the mirror node shows the transaction succeeded
- at least the stated amount left the payer and reached the payee

Anything else is listed as `UNVERIFIED` with the reason, never hidden. If the mirror node cannot answer, the record shows as `UNCHECKED`.

The first recorded payment, 0.001 HBAR from the agent to the service against the live deployment:

```
topic 0.0.10394165: 1 payment record(s), 1 verified against the ledger
  #16  2026-09-13T12:44:06.120Z  VERIFIED  0.001 HBAR  0.0.10388401 -> 0.0.10388560
     tx        0.0.7162784@1789303433.642299625  SUCCESS, settled 2026-09-13T12:44:02.000Z
     resource  https://batas-one.vercel.app/v1/mandate/explain
     request   0x9d10e77dbd715684e32beb2af08f32e401dc136ea75f93aa578837fd0d5c2e69
     response  0x16d381aa084d103c25a0adbdda187e4706b656161bf2de030cd27ce1cb7a92e8
     record    https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10394165/messages/16
     ledger    https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789303433-642299625
```

`agent/payment-trail.test.mjs` checks this record on the real mirror node. It also checks that forged, inflated, replayed, wrong-payee and non-HBAR records are reported as unverified.

### The part the caller could not have worked out alone

Decoding is arithmetic. A caller with the bytes and an afternoon could do it themselves, which
makes it a thin thing to charge for. The other two fields are not.

**`publication`** answers *when these bytes became public*, from
[Hedera Consensus Service](https://docs.hedera.com/hedera/sdks-and-apis/sdks/consensus-service).
The mandate already exists on Sepolia — Aqua puts the whole strategy in its `Shipped` event — but
that timestamp belongs to a block, and a counterparty checking it has to trust whichever RPC served
them. HCS is an ordering service and nothing else: a message gets a consensus timestamp the network
agrees on and a sequence number that cannot be reordered afterwards. `agent/hcs.mjs` submits the
program at grant time; the service matches on the bytes in the request, so no extra input is
needed. A program that decodes perfectly and has no record is a set of terms someone handed you a
minute ago, which is a different thing from a grant that has been standing.

The match is on the whole program, never a prefix or a hash. A mandate differing by one byte is a
different grant, and a loose match would let one publication vouch for all of them.

Reading it costs nothing and needs no account:

```bash
curl 'https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10394165/messages'
node agent/hcs.mjs --lookup 0x2120...      # or ask the same question locally
node agent/hcs.mjs --revocations agent     # and every time that name was taken back
```

**Withdrawals are published too, and that is not decoration.** A ledger carrying only grants tells
the optimistic half of the story: it says when authority was given and never when it was taken
back, so a reader arriving after a revocation sees a mandate that still looks to be standing. The
chain has the truth either way — the name is burned and the settlement refuses — but the record
that needs no account should not be the half that flatters us. `node agent/ens.mjs --revoke agent`
writes the note itself:

```
"agent" on topic 0.0.10394165: 5 revocation(s)
  #14  2026-09-12T23:13:40.774Z  registry 0x945800bd6cdd60521b64a12d7b3f12fc90916a6b
      https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10394165/messages/14
```

It is best effort on purpose. By the time that write is attempted the name is already revoked and
the authority already gone, so a failure to publish must not leave the operator thinking otherwise
— it says what it could not do and moves on.

A revocation names the *name*, not the program, because one name may gate more than one position,
and a topic is public and writable by anyone holding its submit key. `parseRevocationMessage` and
`parseMandateMessage` each refuse the other's records, which is pinned by a test: a revocation
counted as a grant would say authority was given at the moment it was taken away.

That is the property worth the trouble. The record is useful to a stranger *because* it does not
route through us.

**`operator`** answers *who is running this*, from the ERC-8004 registry, and `vouches` is the
field that matters: an identity held by someone other than the address that granted the mandate is
not evidence of anything, and the service says whose it actually is.

### Every morning

`GET /v1/position/health` is the report to read before anything else. It joins the live position
to its mandate: spot now against the floor; the marginal rate after the fee (`marginalBps`); how
much A the position can absorb before that rate falls under the floor; what one cap-sized trade
would take out of B; every settlement since the ship with its distance above the floor; and whether
the name, the ledger and the counterparties still agree. `status` is the worst alert or `ok`, and
`docked` when Aqua no longer answers for the strategy. The alert codes are the questions a maker
would otherwise ask by hand: `FLOOR_INVERTED`, `FLOOR_HEADROOM_LOW`, `TRADE_AT_FLOOR`,
`SELF_TRADE`, `EXPIRY_SOON`, `NAME_INVALID`, `NAME_SHORTER_THAN_MANDATE`, `RESERVES_DOWN`,
`NOT_PUBLISHED`, `LEDGER_DISAGREES`, `FLOOR_BREACH_REPORTED`. Free, behind the same brake as the
other free routes, and remembered for a minute so a dashboard polling it does not become the load.
The page shows the same report as its *This morning* panel.

### Two things worth knowing before building this

The official Hedera x402 proof of concept points its **testnet** configuration at `x402.org` and
reaches for Blocky402 only on mainnet. The Hedera track requires Blocky402. It does serve
`hedera:testnet` — at `api.testnet.blocky402.com`, whose `/supported` sits at the root rather than
under the `/v1` path the site advertises. Copy the PoC as-is and you settle through the wrong
facilitator with everything appearing to work.

Payment is priced in **HBAR first**. An HTS token has to be associated with an account before it
can be received; HBAR does not. That is one less step between a caller and an answer, which is the
entire point of paying per request. The client also caps itself at 0.01 HBAR per call through x402
spend controls — the same idea the contracts enforce, one layer up. A caller that has already
associated the project's own token can pay in it instead, and that path carries a fee schedule:

#### Pay in an HTS token with a custom fee schedule

`POST /v1/mandate/explain` accepts two payments. HBAR comes first (metered, from 0.001 HBAR, no association needed). Second is **Batas Inspection Credit (BIC)**, HTS token [`0.0.10523367`](https://hashscan.io/testnet/token/0.0.10523367): 1.00 BIC per answer, 2 decimals, treasury `0.0.10388560`. Both options appear in the 402 and in `/.well-known/x402`, and both settle through the Blocky402 facilitator, which pays the network fee. The hosted deployment needs no Hedera key for either.

The token carries a **custom fee schedule**: a fixed 0.01 BIC fee, paid in BIC by the sender and collected by the service account `0.0.10388560`. The x402 payload only moves 1.00 BIC. The network adds the fee at consensus, so every settlement in BIC pays the fee schedule on the ledger, and the mirror node records it in `assessed_custom_fees`:

- settlement [`0.0.7162784@1789303940.461488375`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789303940-461488375): 1.01 BIC left the agent `0.0.10388401`; 1.00 is the price and 0.01 is the fee assessed to `0.0.10388560`
- token created in `0.0.10388560@1789303696.616126043`; fee schedule set in `0.0.10388560@1789303922.098182218`

We found out why it is a fixed fee on the ledger. The token started with a 1% fractional fee, and the first BIC settlement (`0.0.7162784@1789303799.767974862`) succeeded but assessed nothing. The receiver is the treasury and the collector, and a fractional fee is not charged on a credit to that account. A fixed fee falls on the sender, so it is assessed every time.

```
npm run hts -- --status                                              # token, fee schedule, balances from the mirror node
BATAS_SERVICE_URL=http://127.0.0.1:4021 node agent/hts-pay.mjs       # pay in BIC, then check the credits moved and the fee was assessed
```

Only accounts associated with BIC can pay this way (`node agent/hts.mjs --create` associated and funded the demo agent).

## The other agent

Everything above is the maker's side: an agent that runs a position under terms it cannot exceed.
`agent/counterparty.mjs` is the other one — a different agent, with its own money and its own rules,
arriving at a position it did not create and deciding whether to trade against it.

It exists because *sold per call over x402* is a claim about a transaction between two machines, and
until now only one of those machines was in this repository. A CLI a person runs to buy an answer
demonstrates the payment. It does not demonstrate the **decision**, and the decision is the part
worth showing.

```bash
npm run counterparty                 # decide about the live position
node agent/counterparty.mjs --program 0x…    # decide about a program you were handed
node agent/counterparty.mjs --paranoid       # insist on knowing the operator, and pay for it
```

Nothing about the service is hard-coded into it. The endpoint, the price and the network come from
the host's own `/.well-known/x402` manifest, the way an indexer or a stranger's agent would find
them. Then it asks the three free questions and forms an opinion:

```
5. The decision
────────────────────────────────────────────────────────────
  walking away, having spent nothing:
    · no deadline: this authority never ends on its own
    · no on-chain kill switch: only the expiry and the maker docking can end this
    · these exact bytes have no publication record: they could have been written a minute ago

  Three of the four questions are free, which is what makes this possible.
  A position worth declining should cost nothing to decline.
```

That is the shape the payment is for. **An agent should be able to refuse for free.** Only when the
free evidence is good and a real doubt remains does it spend anything:

```
  every free check passed.
  but the grant is only 41s old, and who is behind it now matters.

  paying 0.001 HBAR for the operator's identity and whether it vouches …
  settled  0.0.7162784@1789254970.943070760
  agent         #10123  Batas
  vouches       true — the identity is held by the address that granted the mandate

  the identity operating this position is held by the address that granted it.
  trading against it.
```

And it acts on the verdict rather than announcing one. With `--trade` and its own key it takes the
trade it just decided was worth taking — live on Sepolia, from
[`0x1437aF57…`](https://sepolia.etherscan.io/address/0x1437aF5722D5Dfe6BAEda25f3A7A39aeCA374614),
one tokenA in for **1.952840679837944719 tokenB** out:
[`0xa4fb6b83…`](https://sepolia.etherscan.io/tx/0xa4fb6b83912013cf8ba250ab2822ce5457ee129711af1a5039a5182a460bc263).

Its own key, and that is the point rather than an inconvenience: a counterparty signing with the
maker's key is the maker, and a demonstration of two agents that shares one wallet is a
demonstration of one. Without `BATAS_COUNTERPARTY_KEY` it reaches the verdict and says it is
advising only.

It does not mint its input either. The first version tried, and `TokenMock.mint` is owner-only — it
reverted with `OwnableUnauthorizedAccount`, which was the contract making the right point. Those are
the maker's tokens, and a counterparty that could conjure the input side of a trade would not be a
counterparty. It arrives with its own inventory or it does not trade.

The rules are the counterparty's, not this project's — `POLICY` is six lines at the top of the
file, and a counterparty that does not insist on a kill switch is making a different bet and gets a
different answer rather than an argument. `doubtsAbout` is pure and separate from the three fetches
that feed it, because it is the only part anyone would want to argue with, and logic reachable only
by calling two chains is logic nobody runs. `agent/counterparty.test.mjs` pins each refusal by
name, including that an empty answer raises every doubt rather than reading as a clean bill of
health.

It no longer takes the maker's word for what the position permits, either. It fetches the shipped
strategy from Aqua's own event log, decodes the program locally with the same `explain()` the
service runs, and treats the service's `/v1/mandate/decode` answer as a claim to be checked against
those bytes: a server describing a floor, cap, expiry or kill switch the chain does not carry is a
doubt, and the trade is pinned to the strategy hash it read itself, never one the server supplied.
It reads the position's live reserves too, and refuses a floor sitting more than 10% under the
position's own spot. A counterparty with its own view of the market sets `BATAS_COUNTERPARTY_MIN_RATE`
(B per A) and the 1 A quote is held against it; a quote the position refuses is not a pass. Paying
for the operator's identity is a separate decision, `shouldPay`, made only after every free check is
clean: it buys the answer when the grant is under an hour old or when told to with `--paranoid`, and
otherwise trades without spending.

### Found through the registry, not a URL

The counterparty does not start from a host name. It reads agent #10123 from the ERC-8004 identity registry on Sepolia and takes the `x402` endpoint from the registration's `services`. It reads the payee and network from the on-chain metadata (`batas.x402.payTo`, `batas.x402.network`), then fetches `/.well-known/x402` from that endpoint's host. It calls the host only if the manifest lists a resource at exactly the registered endpoint and every payment option pays the registered account on the registered network. A manifest that pays anyone else is refused before anything is spent.

```
1. Find out what this host sells, without being told
  found via     ERC-8004 agent #10123
  registry      x402 at https://batas-one.vercel.app/v1/mandate/explain, pays 0.0.10388560 on hedera:testnet
  manifest      agrees with the registry on endpoint, payee and network
```

Setting `BATAS_SERVICE_URL` skips the registry, and the run says so (`found via BATAS_SERVICE_URL, set by hand; the registry was not consulted`). To see the registry path when your `.env` sets it, run `BATAS_SERVICE_URL= npm run counterparty`.

### Findable on Hedera: Hashgraph Online directory (HCS-10 / HCS-11 / HCS-14)

Batas is listed in the public HCS-10 registry on Hedera testnet. An agent that has never heard of it can find the paid endpoint and the ERC-8004 identity with nothing but a mirror node:

| What | Where |
|---|---|
| Registry entry | topic [`0.0.6913983`](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.6913983/messages/384) #384 (memo `hcs-10:0:300:3`), paid by the agent account `0.0.10388401` |
| Account memo | `hcs-11:hcs://1/0.0.10523695` |
| HCS-11 profile (HCS-1 file) | [`0.0.10523695`](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10523695/messages) — submit key, no admin key, sha256 in the memo |
| HCS-10 inbound / outbound | `0.0.10523692` (public) / `0.0.10523693` |
| UAID (HCS-14) | `uaid:aid:72998g8B43FWUQDt3TzhQE1RATUJgiv5Gykt2ppxXbRHRkeS8sD5V3g7eRfg2NK9ME;uid=0.0.10523692@0.0.10388401;registry=hol;proto=hcs-10;nativeId=hedera:testnet:0.0.10388401` |
| UAID for the ERC-8004 identity | `uaid:aid:5ADkVx3xBapT9QNKuQ5CiocADkd4ubCfWKodEVZi3JDPUY85mFvfJFeSK1iyh8PH4Y;uid=10123;registry=erc-8004;proto=erc-8004;nativeId=eip155:11155111:0x8004A818BFB912233c491871b3d84c89A494BD9e` |

The profile names the x402 endpoint `https://batas-one.vercel.app/v1/mandate/explain`, the ERC-8004 identity `eip155:11155111:0x8004A818BFB912233c491871b3d84c89A494BD9e/10123` and the mandate topic `0.0.10394165`.

```
node agent/hol.mjs --find     # walk the registry, follow the memo to the profile, print the endpoint and ERC-8004 id
node agent/hol.mjs --status   # topics, profile, UAID, registry sequence
```

The registry topic has no submit key, so an entry only counts when the account it names paid for it, and the mirror node reports the payer on every row. The profile is checked against its sha256 before it is believed. Kiloscribe's HCS-1 CDN, which this project does not run, also serves it: `https://kiloscribe.com/api/inscription-cdn/0.0.10523695?network=testnet`.

### A standing order, paid by the network

x402 sells one answer per call. Monitoring a position is ongoing, so it is paid for with a standing order: `agent/subscribe.mjs` wraps each payment in a Hedera Scheduled Transaction (`ScheduleCreateTransaction` with `waitForExpiry`). The agent signs once when it creates the order. Consensus then executes each payment at its due time, whether or not the process is still running. The agent keeps the admin key, so any payment that has not run yet can be deleted.

This is a recurring payment **beside** x402, not through it. These are plain HBAR transfers from the agent account to the service account. They are not settled through Blocky402 or any facilitator, and the mirror node is their only record.

```bash
npm run subscribe -- --create 3 --every 2   # three payments of 0.001 HBAR, two minutes apart
npm run subscribe -- --status               # pending / executed / deleted, with the paying transaction
npm run subscribe -- --cancel               # delete what has not run yet
```

A real order on testnet, from `0.0.10388401` to `0.0.10388560`:

```
order 1789303558  0.0.10388401 -> 0.0.10388560, 0.001 HBAR each
  1/3  0.0.10523344   executed  0.0.10388401-1789303551-913362817  SUCCESS
  2/3  0.0.10523346   executed  0.0.10388401-1789303555-150112982  SUCCESS
  3/3  0.0.10523347   executed  0.0.10388401-1789303557-316806181  SUCCESS

order 1789303573  0.0.10388401 -> 0.0.10388560, 0.001 HBAR each
  1/2  0.0.10523349   deleted
  2/2  0.0.10523350   deleted
```

Check it yourself: `https://testnet.mirrornode.hedera.com/api/v1/schedules?account.id=0.0.10388401`. `agent/subscribe.test.mjs` reads these schedules from the mirror node.

### Agent-to-agent: negotiate a fill, settle it over x402 (A2A)

The Batas agent speaks A2A. Its Agent Card at `/.well-known/agent-card.json` lists a JSON-RPC interface at `/a2a`, the skills `negotiate-fill` and `inspect-mandate`, and marks the [a2a-x402 extension](https://github.com/google-agentic-commerce/a2a-x402) (`https://github.com/google-a2a/a2a-x402/v0.1`) as required.

A counterparty agent sends a proposal as a `message/send` data part: `{ direction, amountIn, minAmountOut | limitRate }`. The Batas agent checks it against the live Aqua position at one Sepolia block. It reads the size cap and floor from the PolicyEnvelope bytes, finds the largest input that still clears the floor, and gets the output from the router's own `quote()`. If the proposal is outside the mandate, the task stays `input-required` with a counter-offer: a size over the cap gets the largest clearing size, and a limit under the floor gets a limit at the floor. If it is inside, the terms are accepted and the task asks for payment in `status.message.metadata`: `x402.payment.status: "payment-required"` plus real x402 `PaymentRequirements` (exact, `hedera:testnet`, HBAR, fee payer named by Blocky402). The counterparty signs and returns `x402.payment.payload` in the same task. The server checks the terms again, then verifies and settles through the facilitator. The task completes with `x402.payment.receipts` and a firm-quote artifact: the exact amountOut, the mandate limits it respects, and the block it was read at.

```
npm run a2a        # BATAS_SERVICE_URL=http://localhost:4021 to target a local service
```

![A real A2A negotiation against the deployed service: counter-offer, acceptance, and the x402 settlement on Hedera](docs/a2a-negotiation.png)

A real run: the counterparty opened at 14.33 A with a 1.747 limit. The agent countered with 5.1538 A, the largest input that clears now under the 7.16 A cap, at the 1.9410 floor. The counterparty accepted and paid 0.001 HBAR. The firm quote was 10.003783 B out at Sepolia block 11696032. Settlement tx: [`0.0.7162784@1789304188.020204394`](https://hashscan.io/testnet/transaction/1789304198.075219104), which the mirror node shows as SUCCESS: 100000 tinybar from 0.0.10388401 to 0.0.10388560.

Negotiation needs no key on the service side. The payer signs and the facilitator pays the Hedera fee.

## What the service does not keep

Nothing. There is no database behind the paid endpoint, no record of who bought what, and that is a
position rather than an omission.

The argument for keeping one is a receipt trail. But the receipt already exists somewhere better:
the x402 settlement is a Hedera transaction, public and permanent, and the client is handed its id
in the `PAYMENT-RESPONSE` header. And the answer itself is reproducible — four of its five parts
are free routes anyone can call, and the fifth is one read of a public registry. A payer who loses
the response can rebuild it from public data without our permission, which is a stronger guarantee
than a row in a table we control.

What a store would actually add is a dependency: something to provision, something to back up,
something that can be wrong about what it sold. For a service whose entire pitch is that its answers
route through nothing of ours, that is the wrong trade. If it ever needs to remember something, the
thing to reach for is the topic it already publishes to.

## And by a person

Everything above is a machine surface, and the suite holds every route to answering JSON because
the consumers are agents, indexers and facilitators. A human who pastes the hostname into a browser
is not one of those, and was being handed a wall of JSON.

**https://batas-one.vercel.app** now serves a page to anyone whose `Accept` header actually says
`text/html` — which browsers send and none of the clients here do. The x402 client, the
facilitator, an indexer and the test suite all send `*/*` or `application/json` and get exactly
what they got before. The rule was never *HTML is wrong*, it was *do not answer a machine in a
format it cannot read*, and `qa/service.spec.mjs` now pins both directions of that.

![The operating envelope with the trade probe dragged past the cap: the settlement refuses](docs/envelope.png)

![The instrument at /app: the live position decoded from its bytes, instruction by instruction](docs/app.png)

The landing page at `/` draws the operating envelope from the live reserves: drag the probe and it
says whether a trade of that size settles, falls under the floor, or is refused past the cap.
`/app` is the instrument. It decodes any program you paste and reads the live position as it loads:
what the bytes permit, when they were published to HCS, and whether the agent's name still holds.
Both URLs answer JSON to a client that does not ask for HTML.

It calls only free routes, and the suite asserts that the page never mentions the paid one. Those
routes are new as HTTP but not new as answers — they sit at parity with the free MCP tools, which
have given away the decode, the publication lookup and the authority check since they existed:

| Free | What it answers | Its MCP twin |
|---|---|---|
| `POST /v1/mandate/decode` | what a program permits | `read_mandate` |
| `POST /v1/mandate/publication` | when those exact bytes became public | `check_publication` |
| `GET /v1/agent/authority` | whether the ENSv2 name still holds, and if not, lapsed or revoked | `check_agent_authority` |
| `GET /v1/agent/reputation` | what clients have said, from ERC-8004 | — |

All seven of those call `agent/free.mjs` rather than each implementing the question. Two encoders for
one format is how this project once shipped mandates with no expiry, and two answers to one
question would be the same mistake wearing a different hat.

The free routes carry a brake — 60 requests a minute per caller, answered as a `429` in JSON with a
`Retry-After` and a note that the paid route is not what is being limited, because a settled payment
is its quota. The publication lookup walks a mirror node and the authority check makes three Sepolia
reads, and something has to stand between a runaway loop and two public networks this project does
not pay for. It is a per-instance counter rather than a shared one, which is stated in the code
along with what that means: the real ceiling is the number times however many instances are warm.

What stays paid is what it always was: the whole answer in one place, with the ERC-8004 identity and
whether it vouches for the address that granted the mandate. A test asserts the free decode carries
neither `publication` nor `operator`, so the free door cannot quietly become the paid one.

## Reachable by software that has never heard of it

Two additions, both to standards other people already read.

**`/.well-known/x402`** — a discovery manifest, per
[draft-hawkins-x402-dns-discovery](https://datatracker.ietf.org/doc/draft-hawkins-x402-dns-discovery/).
An indexer or a stranger's agent learns that this host takes payment, what it sells, and what it
costs, without first being told the URL of the paid route. It is a draft, and honestly: the surfaces that crawl x402 resources today are CDP's Bazaar
(facilitator-gated, no Hedera) and x402scan (self-registered); nothing was found that crawls this
path yet. It sits *outside* the paywall, because putting discovery behind it would mean only someone
who already knows the price can learn the price — and `qa/service.spec.mjs` cross-checks the
advertised price against the `402` the route actually returns, so the manifest cannot drift into
advertising terms nobody honours.

**An MCP server** — `agent/mcp.mjs`, over stdio:

```bash
claude mcp add batas -- node /path/to/agent/mcp.mjs
```

MCP is how the software people delegate to — Claude, Cursor, Windsurf — reaches an outside service.
Four tools, and the split between them is the point:

| Tool | Cost | Answers |
|---|---|---|
| `read_mandate` | free | what these bytes permit, and whether `PolicyEnvelope` is outermost |
| `check_publication` | free | when these exact bytes were published, from the mirror node |
| `check_agent_authority` | free | whether the ENS name still holds, and if not, lapsed or revoked |
| `inspect_mandate_paid` | **from 0.001 HBAR**, metered | all of it, plus the ERC-8004 identity and whether it vouches |

An assistant can establish for nothing whether a mandate was ever published and whether the agent
behind it is still authorised, and *then* decide the full answer is worth a payment. That is the
shape of the thing x402 is for: not a subscription, a decision. The paid tool says `THIS SPENDS
MONEY` in the description the model reads, and `agent/mcp.test.mjs` asserts that it does — a model
that discovers the cost by being charged has discovered it too late.

The payment path is not written twice. `inspect.mjs` exports `payForExplanation`, and the CLI and
the MCP tool both call it; the spend cap and the cold-start retry live in one place. The logger is
injected rather than assumed, because MCP speaks JSON-RPC over stdout and the narration the CLI
prints would corrupt the stream.

Three more documents in formats other people's software already reads, all generated from one
route table in `agent/openapi.mjs`, so none of them can describe a route the other two do not.
`/openapi.json` is an OpenAPI 3.1 description: every route, the free/paid split as an `x-cost` on
each operation, and the `402` documented as the interface it is. `/.well-known/agent-card.json` is
an A2A Agent Card — the questions as skills, with pointers to the x402 manifest and the ERC-8004
identity. `POST /mcp` is the same four tools over Streamable HTTP, stateless, behind the free brake.
And when `BATAS_ATTEST_KEY` is set, the paid answer carries an EIP-712 attestation over its own
canonical JSON (`agent/attest.mjs` recovers the signer; an edited body recovers nobody); unset, the
field is absent, and no other key stands in.

[`docs/INTEGRATE.md`](docs/INTEGRATE.md) is the five-minute version: `claude mcp add batas -- node
agent/mcp.mjs` for any MCP client, `import { explain, client } from 'batas'` for Node, one-file
adapters for the Vercel AI SDK, LangChain, the OpenAI Agents SDK, the Claude Agent SDK and Hedera
Agent Kit v4 over a single `TOOLS` table, a `batas` CLI, and a table of which command needs which
environment variable — for most, none. Importing the library reads no `.env` and opens no
connection, and `agent/index.test.mjs` asserts it.

## What the mandate is worth

Every other test answers *does the limit bind*. `test_WhatTheMandateIsWorth` answers the question a
maker actually asks, by running the same attacker against the same reserves twice — once under a
mandate, once under a position identical in every other way, same app, same fee, same curve, with
nothing that refuses:

```
$ forge test --match-test test_WhatTheMandateIsWorth -vv

the same reserves, the same attacker, 64 attempts each
                      trades   average rate   tokenB left in the position
  under a mandate  :  2        1.662          1667.53
  with none        :  64       0.270          271.86
```

The pool opens at 2.0. The mandate refuses the third trade and the position keeps **83%** of its
reserve, everything that left having gone at 1.662 or better. The unguarded one sells until the
curve is exhausted: 86% of the reserve gone at an average of **0.270**, a seventh of where it
started, and every one of those trades was a perfectly ordinary constant-product swap that no
application-layer check was there to stop.

That gap is the product. Not that a guard exists, but that a position without one is worth a
seventh of what it was by the time anyone notices.

## So what can an attacker actually do

Every other test in this repository checks one refusal, which is right for a suite and wrong for
answering the question anyone actually asks. `test_EveryRouteAroundTheMandateIsClosed` walks the
whole list against one funded position:

```
$ forge test --match-test test_EveryRouteAroundTheMandateIsClosed -vv

a mandate: at most 100 in, never under 1.9 out per 1 in

10 in, inside every limit                -> settles, out: 19743160687941225977
101 in, over the size cap                -> refused
90 in, under the cap but under the floor -> refused
190 out, exactOut around the cap         -> refused
terms rewritten to remove the limits     -> a position with no reserves
```

The third line is the one worth pausing on: 90 is inside the cap, and a size limit alone would let
it through. It is the floor that refuses it, because moving 90 through a 1,000-unit reserve walks
the price under 1.9. Caps bound one trade; floors bound what the trade is worth.

The last line is the property that makes the limits immutable rather than merely checked. An
attacker can compile any program they like — but the terms *are* the strategy hash, so a mandate
with the limits removed is a different position, and the maker never shipped a token to it.

It is a test rather than a script, so it cannot rot into a story the code stopped telling.

## What a mandate does not bound

The limits of this design, stated here because a mandate that is trusted for more than it
enforces is worse than one nobody trusts. Three are properties of the terms; two are economics the
terms do not see; and three are things the table under
[What already exists](#what-already-exists-and-what-does-not) credits to other systems.

**The floor is a number, not an oracle.** `minRateE18` is struck once, against the spot the
reserves implied when the mandate was granted, and it never moves again.
`test_RepeatedTradingCannotWalkThePositionBelowItsFloor` proves what it does bound: each trade is
priced on the reserves as they stand, so working the position makes it dearer and the mandate
refuses before the next trade breaches the floor. That is a statement about *this position's* price
path and nothing else. If the market moves underneath a long mandate, the floor keeps refusing
trades below a rate that stopped describing anything, while every trade that empties the position
at that stale rate satisfies it. The floor protects against this position's own price being walked;
it does not protect against A being worth less than the floor everywhere else. The default term is two hours, which is short enough that the two
prices are still the same price; the deployed demo runs thirty days so the position stays live for
someone to look at, and thirty days is long enough for them to part company. `explain()` now says
so whenever a mandate has more than seven days left, because the caller paying for an answer is
exactly the party that needs to know which of the two they are being sold.

**Revocation binds every caller now — but only for a mandate that names a registry.** This
paragraph used to say the opposite, and the fix is [`MandateName`](#4-and-the-maker-can-end-it-on-chain).
The four controls and their reaches:

| Control | Stops | Enforced by |
|---|---|---|
| ENSv2 subname, mandate names a registry | every caller, at once | both surfaces, on chain |
| ENSv2 subname, mandate names none | the agent, which checks it before acting | the agent's own cooperation |
| `expiry` | every caller, at a time fixed when the grant was made | both surfaces, on chain |
| `Aqua.dock()` | every caller, immediately, and returns the allowance | Aqua |

A mandate that names no registry is still a coherent grant, and the row above it is still true of
one: the name is then a control over the *operator*, and the maker's controls over the *money* are
the term and the dock. What changed is that it is now a choice rather than the only option.

**The mandate names its agent; it does not gate on it.** `Mandate.agent` is part of
`abi.encode(m)` and therefore part of the strategy hash, so the same terms granted to a different
operator are a different position and Aqua's `Shipped` event puts which one on chain. No contract
compares it to a caller, and none should: takers are whoever arrives, and a position only one
address may trade against is not liquidity.
`test_TheAgentNamesTheGrantAndGatesNobody` pins both halves, because a field that is part of the
hash and read by nothing looks like an oversight until someone checks which it is.

**What the cap and the floor bound together is smaller than it reads.** Under the agent's own
derived terms — a floor one budget under spot, and a cap solved for the largest trade that still
clears it — one cap-sized trade lands exactly on the floor and leaves the marginal rate below it.
The floor binds a trade's *average* rate, and the marginal move on `x·y=k` is about twice the
average, so the sequence the floor bounds is, per term, one maximum fill.
`test_RepeatedTradingCannotWalkThePositionBelowItsFloor` is true and the sequence it proves stops at
the second trade. Smaller trades do not get around that; they get less: 357 trades of 0.01 A drain
6.95 B before the floor refuses, against 13.9 B for one maximum fill. What the floor does not do is
ration volume over time.

**Renewal re-strikes the floor from the position's own reserves.** A maximum fill leaves spot about
1.4% lower, and a renewal that re-based the floor a budget under *that* would walk it down every
cycle — a rolling put with no premium. So on renewal the floor, like the cap, may only tighten; the
rules are under [Over time](#what-the-tests-prove). And between shipping a renewal and docking the
mandate it replaces, both positions are live. That order is chosen — a failure there should leave
two live positions rather than none — and a taker watching for the renewal can take one maximum fill
from each inside that window.

**And three things the table credits to others.** Per-period and cumulative caps — Coinbase's
per-period allowance, MetaMask's period and streaming caveats, ERC-8226's `maxCumulativeValue`,
Zodiac's allowances, Smart Sessions' usage counts: a mandate bounds one trade and one term, never a
day's volume, and the paragraph two above is as close as it comes. Target, method, recipient and
calldata scoping — Privy, Turnkey, MetaMask, Zodiac, Smart Sessions and Openfort all bound where a
key may point; here the agent's key is unconstrained outside this one venue and this one direction,
and a mandate says nothing about what the same key does at another contract. Policy that follows
the key across venues and chains, with a human above a threshold — Turnkey, Privy, Crossmint,
Coinbase and Circle, and Safe's or Openfort's *require a human above X*: a mandate is a property of
one position on one chain. That last gap has a sharper form. The agent here holds the maker's key,
so it cannot widen the mandate it granted, but it can ship a wider *new* one; the name and the dock
end both, and nothing else does. Account-layer systems separate the owner who grants from the key
that is bound, and this project does not.

## What the tests prove

**Aqua layer** — a swap inside every limit settles and moves real tokens; expiry refuses however
good the price is; the size cap binds even when the pool could serve the trade; a price under the
floor is refused by the mandate rather than by the taker; `quote()` rejects for the same reasons
`swap()` does, so an agent can test a trade without spending gas; and Aqua's refusal to reuse a
strategy hash makes the terms immutable.

One assertion is worth calling out: after a settled swap the maker still holds the full reserve in
their own wallet. The liquidity was virtual the whole time. That is Aqua's promise, checked rather
than described.

**VM layer** — a non-binding mandate leaves the strategy untouched; the cap and the floor both
revert inside the VM; and a trailing instruction cannot escape the envelope.

**Agreement, on every term** — the fuzz that compares the two surfaces varies all five terms now.
It used to hold `expiry` and `feeBps` fixed, which excused the two most able to disagree: the app
reads a `uint64` timestamp while the compiled program carries a five-byte one, and the fee is a
`uint24` fed into a basis of 1e7. Unfixing them found a disagreement on the first run, at the
expiry second itself — SwapVM's `Deadline` is `block.timestamp <= deadline` and `BatasApp` was
`<`, so for one second a mandate authorised a trade through the VM and refused it through the app.
The struct says the expiry is the timestamp *after* which nothing is authorised, so the vendor
instruction was reading the term correctly and this project's own surface was not. `MandateLib`
also declines to compile a term the program cannot carry — an expiry past what five bytes hold, or
a fee at the basis — rather than silently emitting a different one, which is the same argument as
`PolicyEnvelope`'s length check one layer up.

**Over time** — every other contract test settles one swap, and the claim this project makes is
about a position an agent runs for hours. The cap bounds a single trade, not a day's volume, so the
question worth answering is what stops someone taking the maximum again and again until the
reserves are gone at a price the maker never agreed to.

The floor does, without knowing anything about volume. Each trade is priced on the reserves as they
stand, so working the position makes it dearer, and the mandate refuses as soon as the next trade
would breach the floor. `test_RepeatedTradingCannotWalkThePositionBelowItsFloor` runs that sequence
and checks all of it: every settled trade clears the floor alone, the rate never improves for the
taker, the average across the whole run clears the floor too, and the position stops while the
maker still holds more than half the reserve.

Renewal is not a fresh grant, and three rules keep an agent that re-ships every couple of hours
from rewriting its own limits a little at a time. **The floor never loosens on renewal.** It is
re-measured from the position's own reserves, but the previous mandate's floor is a floor on the
next one — a maximum fill lands exactly on the floor and leaves spot below it, and re-striking one
budget under *that* every hour is a ratchet with no single step that looks like anything. **The
terms are derived from the amounts that actually ship** — `min(wallet balance, reserve)` per side,
fixed before the decision — so a trade landing between the reserve read and the ship cannot leave a
position whose floor refuses a tenth of a token for its whole term. **And a position that refuses
its own cap** — one whose floor rejects even one percent of its stated maximum at its live reserves
— is reported, and the loop stops. Renewing it would ship the same refusal again under a floor the
agent may not loosen, so that is a decision for the owner: dock the position, or grant a wider
mandate by hand. Together with the cap rule already in place, only the owner can widen anything;
the agent can only tighten, and only tell you when it has painted itself in.

**Off chain** — the two encoders agree byte for byte on arbitrary terms; the decision math never
returns a cap that its own floor would refuse; the ENSv2 role bitmaps withhold exactly the four
rights that would break the grant; an ERC-8004 identity held by someone else does not vouch; and a
publication record matches the whole program rather than a prefix, so one grant cannot stand in for
another.

**The paid surface** — Playwright drives the service the way a caller meets it: the free
description names the network, price, facilitator and topic; every payload is refused with a `402`
carrying a payment requirement rather than an error; and a malformed body cannot probe the decoder
for free.

It also checks that nothing answers with HTML. Body parsing fails before any route sees a request,
and Express answers those with `<!DOCTYPE html>` and a 400 — from a service whose every consumer is
an agent, an indexer or a facilitator, none of which can read markup. Malformed bodies now come back
as JSON, oversized ones as a `413` that states the limit so the next attempt can fit inside it, and
a wrong path as a `404` naming the routes that do exist.

The same suite checks the spend cap binds. The client is capped at 0.01 HBAR per call — the same idea the
contracts enforce, one layer up — and a cap that does not cap would be decoration on the one claim
this project is about. The test runs on a key it generates itself: the refusal happens while the
payload is being built, before anything is signed or sent, so an unfunded key reaches it, no HBAR
can move even if the assertion is wrong, and CI needs no secret to run it.

```
forge test          58 passing
npm run test:js    228 passing
npm run test:api    26 passing
npm run test:prod    7 passing
```

**This document** — `agent/readme.test.mjs` walks the README and asks the chain about everything it
points at: every contract in the deployment table holds code, every linked transaction is on Sepolia
and succeeded, the Hedera accounts and the publication topic exist, the sequence number quoted in the
worked example is really on that topic, and the tokens the walkthrough says were paid out are in the
recipient's balance. Two links have already gone wrong on this project — a registration naming a
GitHub URL that did not exist, and a registry address that holds code on mainnet only and reads as
empty on Sepolia, which looks exactly like a correct address for an unregistered agent. A dead link
costs more than a missing paragraph: it says the thing was described rather than built.

```bash
forge coverage --ir-minimum          # contracts
npm run coverage                      # everything off chain
```

Coverage is a question generator here, not a score. On the contracts it reported 100% of lines and
16% of branches, which is mostly Foundry mis-attributing under `via-ir` — but asking *which reverts
any test actually asserted* found three that none did. Off chain it sits at 67% of lines, and what
remains uncovered is almost entirely the paths that spend money or write to a chain: publishing to
HCS, settling an x402 payment, granting and revoking names. Those are exercised by hand and
recorded in this document rather than on every run, because a suite that costs HBAR to run is a
suite people stop running.

Two gaps it surfaced were worth closing. `latestProgramOnChain` had no test at all, and the
walkthrough, the MCP tools and `inspect.mjs` all read the live position through it. And the mirror
node answers `200` with an empty list for a topic id that never existed, so *"nobody published
this"* and *"we asked a topic that is not there"* arrived looking identical — the second means the
service is misconfigured, not that the mandate is unvouched. The topic endpoint does return `404`,
so one extra request in the negative case separates them.

Every Sepolia read defaults to `rpc.sepolia.ethpandaops.io`, in `agent/deployment.mjs` and nowhere
else. It used to be `ethereum-sepolia-rpc.publicnode.com`, repeated as an inline default in twelve
files, and it cost real time: publicnode fronts a pool whose backends do not all hold the same
receipts, which is what turned this suite red with *linked from the README but is not on Sepolia* —
a false statement about the chain assembled out of one endpoint's gaps. Measured over five calls
before switching: ethpandaops 5/5 up at 532ms and 8/8 receipts, tenderly 5/5 at 701ms, publicnode
4/5 at 1680ms and 7/8. A fork through publicnode also made the on-chain demo take 71 seconds and
then fail; through ethpandaops it takes 16.

The retry in `readme.test.mjs` stays regardless. A better endpoint makes a wrong answer rarer, and
the reason that test asks twice is that rare is not never.

The live checks in there are live on purpose. The ERC-8004 tests read the real registry on Sepolia
and the publication tests read the real mirror node, because an identity check tested against a
stand-in proves only that the stand-in agrees with itself.

## License

Two licenses apply, by file.

**Derivatives of SwapVM and Aqua** — `src/BatasRouter.sol`, `src/PolicyEnvelope.sol`,
`src/MandateName.sol`, `src/Mandate.sol` (SwapVM) and `src/BatasApp.sol` (Aqua) — extend
`@1inch/swap-vm` and `@1inch/aqua` and are published under the same licenses those carry:
`LicenseRef-Degensoft-SwapVM-1.1` and `LicenseRef-Degensoft-Aqua-Source-1.1`, texts in
[`LICENSES/`](LICENSES/), as §3.1 of each requires. Nothing in the vendor tree is edited; the
additions are two new instructions (`0x21`, `0x22`) and a router carrying them, written 6–13
September 2026. Our own lines in those files are additionally offered under MIT to anyone who has a
license to the SwapVM and Aqua parts. Redeploying a modified SwapVM is what §3 of that license
provides for, and what the ETHGlobal 1inch track asks for.

**Everything else** — `agent/`, `api/`, `qa/`, `script/`, `test/`, `src/IBatasCallback.sol` — is
MIT, see [`LICENSE`](LICENSE). It calls the vendor contracts and does not incorporate them.

Powered by SwapVM — © Degensoft Ltd 2025. Powered by Aqua — © Degensoft Ltd 2025. The paid answers
and the page are analyses of SwapVM programs; they carry the same notice.

The service charges 0.001 testnet HBAR per inspection. That is a demonstration on a network whose
currency has no value; a fee-charging deployment on a mainnet would need a Commercial License from
Degensoft under §5 of both licenses. See [`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES).

The SPDX line at the top of the five derivative files still reads `MIT`, and that is deliberate
rather than an oversight: the deployed bytecode's metadata hash pins those files byte for byte, and
`agent/deployed.test.mjs` holds the repository to the deployment. Rewriting the header would make
`verification/` describe a contract that is not the one on Sepolia. The licenses that apply are the
ones stated here.
