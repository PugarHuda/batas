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

`test_TrailingInstructionCannotEscapeTheEnvelope` pins exactly this: a 10% out-fee placed after the
curve drags the rate from 2.0 to 1.8, and the mandate still catches it.

## Where to look

| What | File |
|---|---|
| Mandate terms, and why the hash is the strategy hash | [`src/Mandate.sol`](src/Mandate.sol) |
| Aqua application; limits checked before `pull()` | [`src/AmanatApp.sol`](src/AmanatApp.sol) |
| Wrapping SwapVM instruction, opcode slot `0x21` | [`src/PolicyEnvelope.sol`](src/PolicyEnvelope.sol) |
| Router carrying the extended instruction set | [`src/AmanatRouter.sol`](src/AmanatRouter.sol) |
| Aqua-layer tests | [`test/AmanatApp.t.sol`](test/AmanatApp.t.sol) |
| VM-layer tests | [`test/PolicyEnvelope.t.sol`](test/PolicyEnvelope.t.sol) |

Nothing in `node_modules/@1inch/**` is edited. `AmanatOpcodes` extends `Opcodes` through the
`_Ix` slots `OpcodeList.sol` reserves for third parties, and the router is a redeployment, which
the 1inch track permits.

> `AmanatOpcodes` extends `Opcodes`, not `OpcodesDebug`. The debug layer overrides `_runOpcode`
> without re-declaring it `virtual`, so it is terminal — you can have custom opcodes *or* debug
> opcodes, not both.

## Running it

```bash
npm install
forge test
```

Every dependency is pinned to an exact commit or version. That is deliberate: 1inch replaced
`InstructionBuilder` with a `MemoryPtr` streaming API during this hackathon, and an unpinned
install would silently hand a judge a different API than these tests pass on.

### Deploying to Sepolia

Aqua is already live on Sepolia at `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`, so the liquidity
layer is used as-is — only our app and the modified router are deployed.

```bash
cp .env.example .env    # then fill in SEPOLIA_PRIVATE_KEY
forge script script/Deploy.s.sol:Deploy --rpc-url $SEPOLIA_RPC_URL --broadcast
```

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
