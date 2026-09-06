# Batas

*Batas* — Indonesian for **mandate**: authority entrusted within limits that must not be exceeded.

An autonomous agent can run your liquidity position. It cannot exceed the terms you granted it,
because the only contract allowed to touch your tokens refuses to settle a swap that breaks them.

---

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
| Decoder | `npm run test:js` | The instruction walker the paid service sells answers from |
| Paid API | `npm run test:api` | Playwright against the x402 endpoint, including what its 402 promises |

The API suite starts the service itself and asserts the payment requirement without spending
anything, so it runs anywhere. Settling a real payment needs Hedera credentials; that path is
exercised by `agent/inspect.mjs`.

### A bug the fuzzer found

`testFuzz_SurfacesAgreeOnArbitraryTerms` failed at 1 wei of input. A 0.3% fee rounds up to the
entire input, leaving the curve nothing to price, so the output is zero. The VM refused the trade
through the order's `allowZeroAmountIn` trait; `BatasApp` accepted it, and the taker would have
paid a wei for nothing.

That is exactly the failure the agreement tests exist to catch — not one surface being wrong on its
own, but the two of them meaning different things. `BatasApp` now refuses zero output too.

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

## A name other software can look up

The agent is registered in the canonical
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Identity Registry as **agent #10123** on
Sepolia — [`0x7754ce40…`](https://sepolia.etherscan.io/tx/0x7754ce40fe3f6e892512965e1c4c23b43c52d9643b532eb6cfaaecefa42165e2).

```bash
node agent/identity.mjs             # build the registration, simulate, show the id it would mint
node agent/identity.mjs --register  # mint it
node agent/identity.mjs --read 10123
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
```

Its services list points at the source and at the live paid endpoint. An earlier registration,
agent #10120, named a source URL that turned out not to exist; #10123 replaces it. That is the
cost of guessing at a fact instead of checking it, and it is cheap only because registering again
is cheap.

Nothing is advertised that cannot be checked. No endpoint is listed that this repo does not serve,
because a registry full of dead links is worse than an empty one.

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
  @34 FEE_FLAT_IN
  @39 XYC_SWAP
  @41 SALT
enforced mandate
  max input   101
  floor rate  1.92143732923348277
  fee         0.3%
  curve       constant product (x*y=k)
```

`guarded` is the field worth reading first. It is true only when `PolicyEnvelope` occupies the
outermost position; anywhere else, later instructions can undo whatever it checked, and the service
says so in plain words rather than leaving the caller to notice.

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

## License

MIT. Dependencies keep their own licenses; Aqua and SwapVM are source-available under
Degensoft terms.
