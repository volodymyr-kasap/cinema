# 37. `payment.requested` publishes inside the transaction, and throws

**Status:** accepted (2026-09-04)

## Context

ADR 0029 says the opposite for expiry: publish after the commit, fail open, log
a warning, return the `201`. That is right for expiry because lazy release is a
complete backstop — a lost `reservation.expire` costs nothing (ADR 0030).

Payment has no such backstop. A lost `payment.requested` is a reservation that
sits in `PAYMENT_PENDING` with nobody charging anything, until the deadline
reaps it. The customer clicked Confirm and, minutes later, silently lost the
seats.

The two subsystems have opposite failure economics, so they get opposite
orderings. That asymmetry is the decision, and it only holds in one direction.

## Decision

`publishPayment` is called **inside** `confirm`'s transaction, as its last
statement, and it **throws** on any publish failure — an unroutable return, a
confirmation timeout, a dead connection. The transaction rolls back, the
reservation stays `PENDING`, no `payments` row exists, and the caller gets an
error for something that genuinely did not happen.

Publishing before the commit means a message can exist for a transaction that
later rolls back. That is the cheap failure: the consumer finds no row and
discards. The expensive failure — a committed payment with no message — is the
one this ordering removes.

## The race this creates, and how it is closed

Publishing before the commit means the consumer can be handed the delivery and
run its first `SELECT` **before the producer's `COMMIT` lands**. The row is not
visible, and that is indistinguishable from a transaction that really did roll
back. This was measured, not assumed: on a co-located broker and database — the
topology the worker actually runs in — `claimPayment` reported `not-found`
roughly **2 ms** before the producing transaction committed.

Acking on that `not-found` would strand the very hold this ordering exists to
protect. So:

1. **A short grace re-read.** Ten attempts, 20 ms apart — 180 ms, two orders of
   magnitude over the measured race. A fast commit resolves here and never
   touches the ladder.
2. **After the grace window, `not-found` is thrown, not believed.** The caller's
   ordinary failure handling climbs the retry ladder, so a legitimately slow
   commit settles one hop later, about five seconds on, with the row certainly
   present.
3. **A genuine rollback therefore ends in the DLQ**, repeating `not-found` on
   every hop.

That last outcome is accepted deliberately. It trades a silently stranded hold
for a dead-lettered message a human can see, which is the opposite of silent.
It is also the rare side of the trade: `publishPayment` is the last statement
before the transaction returns, so a rollback arriving _after_ it — rather than
a broker error or timeout _before_ it, both handled by the throw — is close to
unreachable.

## Alternatives considered

- **ADR 0029's ordering: publish after the commit, fail open.** Correct for
  expiry, wrong here, for exactly the reason 0029 gives for its own case: it is
  safe when a backstop covers the loss, and payment has none.
- **A transactional outbox.** The actually-correct answer, and the one to reach
  for when a transaction needs to emit more than one message. It costs a table,
  a poller and an ordering guarantee for a system currently publishing one
  message per transaction. `uuidv7()` is already in place to give outbox rows
  their ids when that day comes.
- **Publish after the commit and reconcile with a sweeper.** A second scheduled
  process to find `PAYMENT_PENDING` rows with no message — which is an outbox,
  built accidentally and without the table that would make it reliable.

## Consequences

- A confirm holds a row lock across a broker round trip. It is bounded by
  `RABBITMQ_PUBLISH_TIMEOUT_MS`, and it is the honest price of this ordering.
- A broker outage makes confirms fail. That is intended: it fails the operation
  that could not be started, rather than accepting it and losing it.
- This is the outbox seam. When a second message per transaction appears, the
  price above stops being worth paying and the table earns its place.
- The grace constants live next to the consumer, with the measurement that
  justifies them recorded beside the code.
