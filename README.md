# Batas

*Batas* — Indonesian for **mandate**: authority entrusted within limits that must not be exceeded.

An autonomous agent can run your liquidity position. It cannot exceed the terms you granted it,
because the only contract allowed to touch your tokens refuses to settle a swap that breaks them.

---

## See it work

```bash
npm run walkthrough              # free: everything anyone can verify without us
npm run walkthrough -- --paid    # and then settle 0.001 HBAR for the rest
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

Two properties follow that a plain sequential guard cannot offer:

- **Placement stops mattering.** In `exactOut` mode `amountIn` is only final once the swap curve
  has run, so a sequential guard has to sit after the curve — a rule a program author can silently
  get wrong.
- **Nothing can undo the check.** Later instructions execute *inside* the wrapper. A fee appended
  behind the curve cannot push the amounts back out of bounds once the guard has already passed.

`test_FeeBehindTheGuardStillCounted` pins exactly this. `FeeFlatIn` sits after the envelope in
program order, yet it executes inside it: at 0.3% the rate lands near 1.974 and passes a 1.9 floor,
while at 5% the same mandate refuses the trade. A guard that merely ran first would have passed
before the fee ever touched the amounts.

## What already exists, and what does not

This is a crowded problem and an empty position. Both halves are worth stating plainly.

**The problem is not speculative.** The **Asset-Enforced Spend Mandate**
draft, posted to Ethereum Magicians in June 2026 with participation from the ERC-8226 authors and
MetaMask's delegation team, proposes token-level guardrails for agent wallets: a `spendGate` on the
transfer path, `checkTransfer` returning reason codes like `EXPIRED` and `OVER_TX_CAP`. It reaches
for the same word and nearly the same error taxonomy as this repository.

It also shows where the ceiling of that approach is. A gate on the transfer path sees one leg. It
can bound **how much leaves** and nothing else, because a token contract has no idea what comes
back. `minRateE18` is not expressible there. Enforcement inside the settlement venue sees both
legs, which is why Batas can bound the price a position accepts rather than only its size.

**Enforcement elsewhere is advisory.** [ENShell](https://ethglobal.com/showcase/enshell-6t95y)
(ETHGlobal Cannes 2026, top ten) routes agent intents through Chainlink CRE to an LLM that scores
them 0–100,000 and answers approve/escalate/block. Wallet infrastructure — Turnkey, Openfort —
places policy at the account layer. All of it runs before a signature and off-chain, which means a
counterparty has to trust the operator's server, and a judgement made from a prompt can be argued
with. `PolicyEnvelope` runs during settlement, has no prompt, and reverts.

**In 1inch's own ecosystem, nobody has written a policy instruction.** The two Aqua winners went
deep into the VM in other directions: [Aqua0](https://ethglobal.com/showcase/aqua0-u2krx) (Buenos
Aires 2025, 1inch 4th, since incubated by 1inch) built new AMM curves as AquaApps across chains,
and [KSwap-VM](https://ethglobal.com/showcase/kswap-vm-aix5n) (Lisbon 2026, 1inch 3rd) wrote
K-framework semantics and proofs for the *existing* swap-vm instructions, filing real bug reports
against them. Market structure and verification. No new constraint opcode, and no wrapping
instruction outside 1inch's own fee family.

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
second. `/v1/mandate/explain` meters nothing. It sells a verdict that the party asking for it cannot
produce alone: what a program's bytes actually permit, and whether the identity claiming to operate
it holds the registration it names.

## Where to look

| What | File |
|---|---|
| Mandate terms, and why the hash is the strategy hash | [`src/Mandate.sol`](src/Mandate.sol) |
| Aqua application; limits checked before `pull()` | [`src/BatasApp.sol`](src/BatasApp.sol) |
| Wrapping SwapVM instruction, opcode slot `0x21` | [`src/PolicyEnvelope.sol`](src/PolicyEnvelope.sol) |
| Router carrying the extended instruction set | [`src/BatasRouter.sol`](src/BatasRouter.sol) |
| Aqua-layer tests | [`test/BatasApp.t.sol`](test/BatasApp.t.sol) |
| VM-layer tests | [`test/PolicyEnvelope.t.sol`](test/PolicyEnvelope.t.sol) |

Nothing in `node_modules/@1inch/**` is edited. `BatasOpcodes` claims one of the `_Ix` slots
`OpcodeList.sol` reserves per family bank for third parties — `_21`, in the 0x20-0x3f conditions
and access guards bank, beside `Deadline` and the taker gates. The router is a redeployment, which
the 1inch track permits.

Two things about which base class to extend, both learned the hard way:

> **`AquaOpcodes`, not `Opcodes`.** The full set carries 24 instructions an Aqua strategy never
> reaches for, including every balance instruction, because in Aqua mode balances come from Aqua
> rather than from bytecode. Carrying them puts the router at 28,618 bytes against EIP-170's
> 24,576 and it cannot be deployed at all. On `AquaOpcodes` it is 20,623.
>
> **Not `OpcodesDebug` either.** That layer overrides `_runOpcode` without re-declaring it
> `virtual`, so it is terminal — you can have custom opcodes *or* debug opcodes, not both.

## Running it

```bash
npm install
npm test          # contracts, decoder, and the paid API surface
```

Three suites, run separately if you prefer:

| Suite | Command | What it covers |
|---|---|---|
| Contracts | `npm run test:sol` | Both enforcement surfaces, plus 2000 fuzz runs on their agreement |
| JavaScript | `npm run test:js` | The decoder, strategy recovery, and encoder parity with Solidity |
| Paid API | `npm run test:api` | Playwright against a local x402 endpoint, including what its 402 promises |
| Deployment | `npm run test:prod` | The same assertions against the URL the on-chain identity advertises |

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

which at a 2% budget and a 0.3% fee is about **1.73% of the reserve**, not 10%. The cap is derived
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

All four are source-verified on Etherscan, so the code below can be read on the explorer rather
than taken from this repo on trust.

| Contract | Address |
|---|---|
| Aqua (canonical, not ours) | [`0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`](https://sepolia.etherscan.io/address/0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a) |
| `BatasRouter` (SwapVM + PolicyEnvelope) | [`0x228E82831afaC5dd9EbDE3489E9e18Ae9c7bcbf4`](https://sepolia.etherscan.io/address/0x228E82831afaC5dd9EbDE3489E9e18Ae9c7bcbf4) |
| `BatasApp` | [`0x369D326cB0Ef400EB1AA1E2Aa62bC12F791c4849`](https://sepolia.etherscan.io/address/0x369D326cB0Ef400EB1AA1E2Aa62bC12F791c4849) |
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
| Ship liquidity under the mandate | [`0x00d0bc71…`](https://sepolia.etherscan.io/tx/0x00d0bc7132edd8ae9f18e1e5f3f71ca4c41ae3b50a6ae9e0d132d00d7b10561d) |
| Swap settled inside the mandate | [`0xe08a5613…`](https://sepolia.etherscan.io/tx/0xe08a5613d58047cea2e1bde85069fd2fdd65e9585d2f5ea98c3d57500ec32c20) |

10 tokenA in, **19.743160687941225977 tokenB** out to
[`0x8474d483…`](https://sepolia.etherscan.io/address/0x8474d483Cc4374B8a16fE2D019717b23f0a5BD83) —
constant product less the 0.3% fee, judged against the 1.9 floor and allowed through.

An oversized trade against the same live position reverts with
`MandateAmountInExceeded(101e18, 100e18)` before any token moves.

Each run salts the program, because Aqua permanently burns a strategy hash once it has been used.
`Salt` is the instruction that exists for exactly this: a no-op whose bytes change the program
hash, which is how the same terms get a fresh position.

## The agent

`agent/batas-agent.mjs` is the half the project is named for. It reads the live position on
Sepolia, decides what mandate to grant, encodes the SwapVM program itself, and ships it.

```bash
node agent/batas-agent.mjs          # observe and decide, no transaction
node agent/batas-agent.mjs --ship   # also grant the mandate it decided on
```

A real run against the deployed position:

```
observed 1 mandate(s); reading the newest
reserves 1010 A / 1980.256839312058774023 B
spot     1.960650335952533439 B per A

decision
  floor  1.92143732923348277 B per A  (2.00% under spot)
  cap    101 A                        (10.00% of reserve)

program  0x2120...0753050000208000000006a9d5ef4 (51 bytes)

encoding check
  local  0x4d113cd9c03a5ab7aebea6191fa903adf379e648c9c21911f956c09a24d9aeda
  chain  0x4d113cd9c03a5ab7aebea6191fa903adf379e648c9c21911f956c09a24d9aeda
  agree
```

Every number is read from the chain. The spot price is derived from the reserves Aqua reports, the
floor is one slippage budget under it, and the cap is a slice of the reserve — which is what
actually bounds how far one trade can walk the price.

The **encoding check** is the part worth pausing on. The agent assembles the instruction stream
itself, byte by byte, then asks the deployed router to hash the resulting order. If a single
opcode, length prefix or trait bit were wrong, the two hashes would differ and it refuses to ship.
The chain agrees rather than being taken on trust.

Mandate granted by that run:
[`0x380e5cca…`](https://sepolia.etherscan.io/tx/0x380e5ccaf22e81cdd51e28635fa8c4dd0c98ff4409cfaedd599707b18b579656).

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
expiry        2026-09-06T15:41:14.000Z
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
batas.router       0x228E82831afaC5dd9EbDE3489E9e18Ae9c7bcbf4
batas.app          0x369D326cB0Ef400EB1AA1E2Aa62bC12F791c4849
batas.aqua         0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a
batas.enforcement  swapvm-opcode:0x21
batas.x402.network hedera:testnet
batas.x402.payTo   0.0.10388560
batas.hcs.topic    0.0.10394165
batas.ens.registry 0x…                 the kill switch, discoverable from the identity
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
node agent/inspect.mjs 0x2120...                         # pay 0.001 HBAR and read the answer
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

Decoded from the program the agent actually shipped:

```
guarded by PolicyEnvelope: true
  @ 0 POLICY_ENVELOPE
  @34 DEADLINE
  @41 FEE_FLAT_IN
  @46 XYC_SWAP
  @48 SALT
enforced mandate
  max input   17.573127545903015167
  floor rate  1.92143732923348277
  fee         0.3%
  curve       constant product (x*y=k)
  expires     2026-10-06T22:09:10.000Z
publication
  published   2026-09-06T22:09:24.382Z  (HCS consensus, topic 0.0.10394165 #3)
  granted by  0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e
  verify      https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10394165/messages/3
operator
  agent #10123  Batas
  held by     0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E
  vouches     yes — the identity is held by the address that granted the mandate
```

`guarded` is the field worth reading first. It is true only when `PolicyEnvelope` occupies the
outermost position; anywhere else, later instructions can undo whatever it checked, and the service
says so in plain words rather than leaving the caller to notice.

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
```

That is the property worth the trouble. The record is useful to a stranger *because* it does not
route through us.

**`operator`** answers *who is running this*, from the ERC-8004 registry, and `vouches` is the
field that matters: an identity held by someone other than the address that granted the mandate is
not evidence of anything, and the service says whose it actually is.

### Two things worth knowing before building this

The official Hedera x402 proof of concept points its **testnet** configuration at `x402.org` and
reaches for Blocky402 only on mainnet. The Hedera track requires Blocky402. It does serve
`hedera:testnet` — at `api.testnet.blocky402.com`, whose `/supported` sits at the root rather than
under the `/v1` path the site advertises. Copy the PoC as-is and you settle through the wrong
facilitator with everything appearing to work.

Payment is priced in **HBAR rather than USDC**. An HTS token has to be associated with an account
before it can be received; HBAR does not. That is one less step between a caller and an answer,
which is the entire point of paying per request. The client also caps itself at 0.01 HBAR per call
through x402 spend controls — the same idea the contracts enforce, one layer up.

## Reachable by software that has never heard of it

Two additions, both to standards other people already read.

**`/.well-known/x402`** — a discovery manifest, per
[draft-hawkins-x402-dns-discovery](https://datatracker.ietf.org/doc/draft-hawkins-x402-dns-discovery/).
An indexer or a stranger's agent learns that this host takes payment, what it sells, and what it
costs, without first being told the URL of the paid route. Several facilitators already read this
path. It sits *outside* the paywall, because putting discovery behind it would mean only someone
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
| `inspect_mandate_paid` | **0.001 HBAR** | all of it, plus the ERC-8004 identity and whether it vouches |

An assistant can establish for nothing whether a mandate was ever published and whether the agent
behind it is still authorised, and *then* decide the full answer is worth a payment. That is the
shape of the thing x402 is for: not a subscription, a decision. The paid tool says `THIS SPENDS
MONEY` in the description the model reads, and `agent/mcp.test.mjs` asserts that it does — a model
that discovers the cost by being charged has discovered it too late.

The payment path is not written twice. `inspect.mjs` exports `payForExplanation`, and the CLI and
the MCP tool both call it; the spend cap and the cold-start retry live in one place. The logger is
injected rather than assumed, because MCP speaks JSON-RPC over stdout and the narration the CLI
prints would corrupt the stream.

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

**Off chain** — the two encoders agree byte for byte on arbitrary terms; the decision math never
returns a cap that its own floor would refuse; the ENSv2 role bitmaps withhold exactly the four
rights that would break the grant; an ERC-8004 identity held by someone else does not vouch; and a
publication record matches the whole program rather than a prefix, so one grant cannot stand in for
another.

**The paid surface** — Playwright drives the service the way a caller meets it: the free
description names the network, price, facilitator and topic; every payload is refused with a `402`
carrying a payment requirement rather than an error; and a malformed body cannot probe the decoder
for free.

```
forge test          21 passing
npm run test:js    104 passing
npm run test:api     8 passing
```

**This document** — `agent/readme.test.mjs` walks the README and asks the chain about everything it
points at: every contract in the deployment table holds code, every linked transaction is on Sepolia
and succeeded, the Hedera accounts and the publication topic exist, the sequence number quoted in the
worked example is really on that topic, and the tokens the walkthrough says were paid out are in the
recipient's balance. Two links have already gone wrong on this project — a registration naming a
GitHub URL that did not exist, and a registry address that holds code on mainnet only and reads as
empty on Sepolia, which looks exactly like a correct address for an unregistered agent. A dead link
costs more than a missing paragraph: it says the thing was described rather than built.

The live checks in there are live on purpose. The ERC-8004 tests read the real registry on Sepolia
and the publication tests read the real mirror node, because an identity check tested against a
stand-in proves only that the stand-in agrees with itself.

## License

MIT. Dependencies keep their own licenses; Aqua and SwapVM are source-available under
Degensoft terms.
