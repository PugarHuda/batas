# Draft reply: Asset-Enforced Spend Mandate, and the leg it cannot see

*A post for the Ethereum Magicians thread on the Asset-Enforced Spend Mandate draft. Written to be
posted, not posted — it goes out under a person's name, so that is their call. It argues one narrow
technical point and offers an implementation as evidence rather than as a pitch.*

---

## The proposal is right about the problem

The draft proposes token-level guardrails for agent wallets: a `spendGate` on the transfer path and
a `checkTransfer` returning reason codes like `EXPIRED` and `OVER_TX_CAP`. The premise — that an
autonomous agent's limits belong somewhere a counterparty can verify rather than in the application
that happens to be driving — is one I agree with enough to have spent a hackathon building the same
idea at a different layer.

What follows is not an objection to the draft. It is an argument that the layer it picks has a hard
ceiling, that the ceiling is worth naming in the spec, and that something has to live above it.

## A gate on the transfer path sees one leg

`checkTransfer(from, to, amount)` is called on the way out. It knows how much is leaving. It cannot
know what is coming back, because a token contract has no idea it is the sell side of a swap.

That bounds a real and useful class of harm — `OVER_TX_CAP`, `EXPIRED`, per-period totals — and it
is exactly the right place for those. It cannot express the limit that matters most to anyone whose
agent is *trading* rather than *paying*:

> never accept less than X of the other asset per unit of this one.

Call it `minRate`. It is a statement about two balances at one instant, and a transfer hook can only
ever see one of them. An agent operating under a perfect spend gate, with a cap it never exceeds
and an expiry it honours, can still sell a position to zero at any price the market will give it and
break no rule the token knows about.

This is not hypothetical arithmetic. Running the same attacker against the same constant-product
reserves twice, once with a rate floor enforced at settlement and once without:

```
                     trades   average rate   reserve left
  with a rate floor :  2        1.662          83%
  without one       : 64        0.270          14%
```

Both runs are inside any per-transaction cap you care to set. The difference is entirely in the
second leg, which the first layer cannot see.

## What I would ask of the draft

Not a change of design — a sentence of scope. Something like:

> `checkTransfer` observes the outgoing leg only. Policies that depend on what is received in
> exchange (a minimum rate, a maximum slippage) cannot be expressed here and must be enforced by
> the venue that settles both legs.

That costs the draft nothing and saves an implementer the discovery that their "mandate" bounds
half of what they thought. It also makes the two layers composable on purpose rather than by
accident: the token bounds how much may leave over time; the venue bounds what each departure is
worth.

## What enforcement at the venue looks like

I built the second half to find out whether the argument survives contact. It is on Sepolia, it is
open source, and the parts relevant here are small.

1inch's Aqua is a shared liquidity layer where the maker never deposits — tokens stay in the wallet
and Aqua pulls at settlement. Its security model is one sentence: whichever app the maker ships to
may pull their tokens. So the app is the venue, and the venue is where both legs are visible.

The mandate is three terms — a size cap, a rate floor, an expiry — and it is encoded as the strategy
bytes themselves. `Aqua.ship()` hashes those bytes, so the mandate hash *is* the strategy hash: the
terms are the position's identity rather than metadata attached to it, and they cannot be rewritten
without becoming a different position that nobody funded.

Enforcement is a new instruction in 1inch's SwapVM that wraps the rest of the program, delegates to
the interpreter, and inspects the settled registers when it returns. Two properties follow that a
sequential check cannot offer: in exact-output mode the input is only final after the curve has
run, so placement stops being something an author can get wrong; and later instructions execute
*inside* the wrapper, so a fee appended behind the curve cannot push the amounts back out of bounds
after the guard has passed. It costs 933 gas.

The rate check itself is one line, and it is the line a transfer hook cannot write:

```solidity
require(amountOut * 1e18 >= amountIn * minRateE18, MandateRateTooLow(amountOut, amountIn, minRateE18));
```

## Where the draft's layer is clearly better

Two places, and they are not small.

**Coverage.** A venue-level guard binds the venue it lives in. An agent with a funded wallet can
walk to a different one. A token-level gate binds every transfer of that asset regardless of
destination, which is a strictly larger claim and the reason the draft's approach is worth having
at all.

**Generality.** Most agent spending is not a swap. Paying for an API call, settling an invoice,
funding a subaccount — all one-legged, all exactly what `checkTransfer` is for, and none of them
have a rate to floor.

The honest summary is that these are different guarantees rather than competing ones, and an agent
operating real money probably wants both: the token bounding the aggregate, the venue bounding each
exchange.

## One implementation note the draft may care about

The reason-code design is right, and I would push it further than the draft currently does.

We hit a case where revocation and expiry became indistinguishable. The registry we use for the
agent's authority sets a name's expiry to the moment of revocation rather than zeroing it, so a
grant the owner *pulled* and one that simply *ran out* produced identical timestamps — and the
operator of a stopped agent was told it had run out of time when in fact its authority had been
taken away. Those are different situations with different remedies, and a reason code that collapses
them is worse than no reason code, because it is confidently wrong.

If `checkTransfer` is going to return `EXPIRED`, it is worth deciding now whether `REVOKED` is a
separate code and what a caller may infer from each.

---

*Implementation: https://github.com/PugarHuda/batas — MIT, Sepolia, and every claim above has a test
next to it.*
