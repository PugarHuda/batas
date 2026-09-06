# Amanat

*Amanat* — Indonesian for **mandate**: authority entrusted within limits that must not be exceeded.

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

`Aqua.ship()` hashes the strategy bytes you hand it. Amanat passes the encoded mandate as those
bytes, so the mandate hash and the strategy hash are the same value. The terms are not metadata
attached to the position; they are its identity. Aqua refuses to re-ship a hash it has already
seen, so the terms cannot be quietly rewritten afterwards.

`Shipped` also carries the full mandate in its event data, so the grant is publicly auditable
without storing a byte of it.

### 2. The limits are checked before tokens move

[`AmanatApp`](src/AmanatApp.sol) is a constant-product Aqua application. Every swap validates the
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
| Aqua application; limits checked before `pull()` | [`src/AmanatApp.sol`](src/AmanatApp.sol) |
| Wrapping SwapVM instruction, opcode slot `0x21` | [`src/PolicyEnvelope.sol`](src/PolicyEnvelope.sol) |
| Router carrying the extended instruction set | [`src/AmanatRouter.sol`](src/AmanatRouter.sol) |
| Aqua-layer tests | [`test/AmanatApp.t.sol`](test/AmanatApp.t.sol) |
| VM-layer tests | [`test/PolicyEnvelope.t.sol`](test/PolicyEnvelope.t.sol) |

Nothing in `node_modules/@1inch/**` is edited. `AmanatOpcodes` claims one of the `_Ix` slots
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
forge test
```

Every dependency is pinned to an exact commit or version. That is deliberate: 1inch replaced
`InstructionBuilder` with a `MemoryPtr` streaming API during this hackathon, and an unpinned
install would silently hand a judge a different API than these tests pass on.

### Live on Sepolia

Aqua is already deployed on Sepolia, so the liquidity layer is used as-is. Only our own contracts
went out.

| Contract | Address |
|---|---|
| Aqua (canonical, not ours) | [`0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`](https://sepolia.etherscan.io/address/0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a) |
| `AmanatRouter` (SwapVM + PolicyEnvelope) | [`0xe2fC5c03b4103dC703316bB3D781a1b47E82561E`](https://sepolia.etherscan.io/address/0xe2fC5c03b4103dC703316bB3D781a1b47E82561E) |
| `AmanatApp` | [`0x73dc537aC0e276dED9B9a84a69CBF1705eFbfEd9`](https://sepolia.etherscan.io/address/0x73dc537aC0e276dED9B9a84a69CBF1705eFbfEd9) |
| Demo token A | [`0xD1BE5EeD764424BFA0389BF79964B6fBE7725B54`](https://sepolia.etherscan.io/address/0xD1BE5EeD764424BFA0389BF79964B6fBE7725B54) |
| Demo token B | [`0xd504a056906583c9F9Ac3622FBE8edBA4cD9d3E8`](https://sepolia.etherscan.io/address/0xd504a056906583c9F9Ac3622FBE8edBA4cD9d3E8) |

```bash
cp .env.example .env    # then fill in SEPOLIA_PRIVATE_KEY
forge script script/Deploy.s.sol:Deploy --rpc-url $SEPOLIA_RPC_URL --broadcast
forge script script/Demo.s.sol:Demo     --rpc-url $SEPOLIA_RPC_URL --broadcast
```

### A settled mandate, on-chain

`script/Demo.s.sol` grants a mandate and trades inside it against live Aqua. Real ERC-20
transfers, no mocked settlement:

| Step | Transaction |
|---|---|
| Ship liquidity under the mandate | [`0x6a808592…`](https://sepolia.etherscan.io/tx/0x6a8085926ffd8f6a63f9ecb0b1e7fe3029b3f5d8656683bdd85b50b2679f9840) |
| Swap settled inside the mandate | [`0x9c063a11…`](https://sepolia.etherscan.io/tx/0x9c063a1127c40c456306a8b57ceccfe64c99baa062f3868b8ead59474bcb24b3) |

10 tokenA in, **19.743160687941225977 tokenB** out to
[`0x03ca8eaa…`](https://sepolia.etherscan.io/address/0x03ca8eaa1b939fd7a7bbcebd107ad48f52557b43) —
constant product less the 0.3% fee, judged against the 1.9 floor and allowed through.

An oversized trade against the same live position reverts with
`MandateAmountInExceeded(101e18, 100e18)` before any token moves.

Each run salts the program, because Aqua permanently burns a strategy hash once it has been used.
`Salt` is the instruction that exists for exactly this: a no-op whose bytes change the program
hash, which is how the same terms get a fresh position.

## The agent

`agent/amanat-agent.mjs` is the half the project is named for. It reads the live position on
Sepolia, decides what mandate to grant, encodes the SwapVM program itself, and ships it.

```bash
node agent/amanat-agent.mjs          # observe and decide, no transaction
node agent/amanat-agent.mjs --ship   # also grant the mandate it decided on
```

A real run against the deployed position:

```
observed 1 mandate(s); reading the newest
reserves 1010 A / 1980.256839312058774023 B
spot     1.960650335952533439 B per A

decision
  floor  1.92143732923348277 B per A  (2.00% under spot)
  cap    101 A                        (10.00% of reserve)

program  0x2120...0753050000208000000006a9d5af1 (51 bytes)

encoding check
  local  0x1530fd094a015fdeee9bb6be195e8043b8f62ed61f2e636727c107d42529f2cb
  chain  0x1530fd094a015fdeee9bb6be195e8043b8f62ed61f2e636727c107d42529f2cb
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
[`0x8379a396…`](https://sepolia.etherscan.io/tx/0x8379a396285fd97b5ea189238c697afbb9e0160fc5f171a2ce1121d4daa10b3a).

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
