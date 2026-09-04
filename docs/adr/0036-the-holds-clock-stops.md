# 36. The hold's clock stops at `PAYMENT_PENDING`, and `expires_at` is never rewritten

**Status:** accepted (2026-09-04)

## Context

A hold lives for `RESERVATION_TTL_SECONDS` (600 by default). A payment may still
be running when that runs out — the ladder alone spans several seconds, and a
hung provider spans thirty.

Two clocks now bear on the same seats, and something has to say which one wins.
Getting this wrong in either direction is a real failure: expiry taking seats
from a charge that succeeds means money moved and no booking exists; a hold that
never expires means a seat owned for ever by a charge nobody is making.

## Decision

`PAYMENT_PENDING` transfers ownership of the seats from the hold's clock to the
payment's. Concretely:

- `expires_at` is **never rewritten**. It keeps the value the hold was created
  with, for its whole life.
- A delivered `reservation.expire` for a `PAYMENT_PENDING` row answers
  `awaiting-payment` and takes nothing.
- The lazy sweep gains a second arm: a `PAYMENT_PENDING` row whose payment is
  older than `PAYMENT_DEADLINE_SECONDS` (300 by default) becomes
  `PAYMENT_FAILED` and hands its seats back.
- The Redis key is moved onto the same clock. `confirm` calls
  `retainFor(…, PAYMENT_DEADLINE_SECONDS)` rather than leaving the key on the
  hold's TTL, so the advisory layer and the row stop at the same moment.

## Alternatives considered

- **Extend the hold — push `expires_at` out when payment starts.** The obvious
  move, and it breaks the mechanism underneath it. ADR 0024 implements the delay
  with a per-TTL wait queue whose `x-message-ttl` is fixed at assert time; a
  reservation whose deadline moves needs a delay that is computed per message,
  which means the delayed-message plugin that ADR was written to avoid. A single
  authoritative TTL is what makes that queue possible.
- **Let expiry win — release the seats and compensate if the charge lands.**
  This needs a `/void` path on the provider, a refund state on the payment, and
  an answer to "what if the void fails" that is another compensation. It trades
  a bounded wait for an unbounded failure mode, to save at most a few minutes of
  seat availability.
- **A separate `payment_expires_at` column.** Two deadline columns, one of which
  is meaningless in most states, and every query that asks "is this over?" has
  to know which. `payments.created_at` plus a configured deadline says the same
  thing with a column that already exists and can never disagree with itself.

## Consequences

- The seats are unavailable for up to `PAYMENT_DEADLINE_SECONDS` past the hold's
  own expiry. That is the price, it is bounded and configurable, and it is paid
  only by reservations that reached payment.
- `reservation.expire.wait` keeps its single fixed TTL, so ADR 0024 stands.
- The reaper is the only thing that can end an abandoned payment, and it needs
  neither the broker nor the provider to do it — ADR 0030's rule, extended to
  the new status.
- Because the key and the row now expire together, a request for a seat whose
  payment is over is admitted to the transaction where the reaper runs. Leaving
  the key on the hold's TTL had the two out of step in the worst direction: the
  lock is acquired _before_ the transaction opens, so a stale key refuses the
  very request that would have triggered the reap.
- `PAYMENT_PENDING` cannot be cancelled. `DELETE` answers 409 naming the payment
  in flight, because the money may already have moved.
