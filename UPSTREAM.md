# Two findings worth sending upstream

Both were found by building on these tools rather than by auditing them, and both cost this project
real time before they were understood. Neither is a vulnerability in anyone's deployed code. They
are written out here ready to file, rather than filed, because they go out under a person's name
and that is the person's call.

---

## 1. swap-vm — `InstructionArgs` bounds, and what changes when the instruction is a guard

**Repository:** [1inch/swap-vm](https://github.com/1inch/swap-vm)
**Type:** documentation / hardening note for third-party instruction authors
**Not a vulnerability in swap-vm's own instructions.** See "why it is different for guards" below.

### What the library says

`InstructionArgs.at` is a raw `calldataload`, and the library documents this plainly:

> the library does not implement out-of-bounds read validations

Argument length is the program author's problem. For every instruction in the shipped set that is
the right trade — the check would cost gas on every settlement to defend against a program the
maker wrote wrongly themselves.

### Why it is different for guards

For a fee or a curve, a misparse produces a **wrong price**, and a wrong price is loud: the taker
sees it, the maker sees it, and the trade either reverts on a threshold or somebody notices the
number.

For an instruction whose job is to *refuse*, a misparse can produce a **guard that passes**, and
that is silent by construction. Nothing looks wrong. The program decodes, the swap settles, and the
limit that was supposed to bind simply did not.

We hit this building a policy instruction that carries `[uint128 maxAmountIn][uint128 minRateE18]`.
An envelope declaring sixteen argument bytes instead of thirty-two read its floor price out of the
**next instruction's bytes**. Removing our length check and running the test gives a floor of

```
148889121703133190954033214317794426880
```

which happens to refuse everything — but that direction is an accident of the layout. The value
comes from whatever bytes happen to sit after the instruction, and an instruction that is last in
the program reads past `order.data` entirely. **A guard whose strictness depends on its neighbours
is not a guard.**

### What would help

Nothing in the library needs to change. One sentence in the `InstructionArgs` doc comment would
have saved us the afternoon:

> Instructions that *permit or refuse* rather than *price* should validate `args.length` before
> reading. An out-of-bounds read in a pricing instruction yields a visibly wrong amount; in a guard
> it can yield a guard that passes.

If it is wanted as code instead, a `atChecked(bytes calldata, uint256 shift, uint256 needed)` that
reverts on a short read would let an author opt in per instruction without costing the existing
set anything.

### Reproducing

The test is `test_RevertWhenEnvelopeArgsAreTruncated` in this repository. Delete the
`require(args.length >= 32)` from `PolicyEnvelope.parse` and it goes from refusing the program to
accepting one with a floor nobody wrote.

---

## 2. Foundry — `forge build` and `forge test` do not produce the same `src/` bytecode

**Repository:** [foundry-rs/foundry](https://github.com/foundry-rs/foundry)
**Type:** documentation gap, or a footgun worth a warning
**Version:** forge 1.8.0, solc 0.8.30, `via_ir = true`, `optimizer_runs = 700`

### What happens

From a clean tree, the two commands write different runtime bytecode for the same contract:

```
$ forge clean && forge build && <read out/BatasRouter.sol/BatasRouter.json>
21178 bytes

$ forge clean && forge test  && <read out/BatasRouter.sol/BatasRouter.json>
21236 bytes
```

A 58-byte difference, reproducible, with every jump destination after the divergence shifted.
`forge create` produces the first. So **the bytecode a project deploys is not the bytecode its
tests exercise.**

### Why it matters more than it sounds

We keep a test that compares the runtime bytecode on Sepolia against the local build, because a fix
had once been written, tested, documented and never deployed, and nothing in the repository could
tell. That check passed locally and failed in CI at byte 1,169.

The first guess was the toolchain, since CI installed `stable` and the deployment came from 1.8.0.
Pinning the version changed nothing. The lengths were the clue: CI ran only `forge test`, so it was
comparing the chain against an artifact no deployment had ever come from.

Anything that reasons about deployed bytecode hits this — size checks against EIP-170, verification
workflows, deterministic-deployment tooling, bytecode diffing between a repository and a chain.

### The likely cause, and why it is still worth a warning

This is probably not a Foundry bug. Solidity compiles the whole input as one unit, so adding
`test/` changes the input, and under `--via-ir` the optimizer's output for `src/` contracts can
differ as a result. That is defensible compiler behaviour.

It is still a footgun, because nothing anywhere says it. The artifact path is the same, the
contract name is the same, the file mtime moves, and whichever command ran last silently wins. Our
workaround is `forge build --force` before anything that reads an artifact, with `--force` because
the cache rather than the command decides — a warm tree from a test run survives a plain
`forge build`, which bit us a second time after we thought it was fixed.

### What would help

Either a note in the docs — *"artifacts written by `forge test` may differ from those written by
`forge build`; use `forge build` before consuming artifacts for deployment or verification"* — or
separate artifact output directories for the two commands so the question cannot arise.
