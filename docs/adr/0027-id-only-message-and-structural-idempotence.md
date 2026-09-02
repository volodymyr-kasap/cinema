# 27. The message carries an identifier and nothing else

**Status:** accepted (2026-09-01)

## Context

A `reservation.expire` message is published when a hold is taken and delivered
ten minutes later. In between, the hold may have been confirmed, cancelled, or
already expired by a caller who wanted the seat. The message is, by design, a
statement about a world that has since moved on.

## Decision

The body is `{ reservationId }`. Nothing else. The handler re-reads the row under
the same `SELECT ... FOR UPDATE` that `confirm` and `cancel` take, and decides
from what it finds: not found, terminal, not due, or expire it.

## Alternatives considered

- **Carrying `seatIds` and `expiresAt` in the message.** It would save a query,
  and it would let the handler act without reading the database at all. That is
  precisely the problem: the message would assert facts that were true when it
  was published, and acting on them means acting on a ten-minute-old view of the
  world. The confirm-versus-expire race becomes a real bug — a sold seat
  un-sold — rather than an impossible one.
- **Cancelling the in-flight message when a hold is confirmed.** AMQP has no
  such operation. Simulating one with a dedupe or tombstone table is bookkeeping
  in place of a design, and the bookkeeping would itself need to be correct under
  the same races.

## Consequences

- Idempotence is **structural**. A second delivery finds a row that is no longer
  `PENDING` and does nothing, so at-least-once delivery needs no dedupe table and
  no `Idempotency-Key` — that is an HTTP concern and stays in sub-project 5.
- `confirm` and `cancel` publish nothing and cancel nothing. They are unchanged
  by this phase, which is the clearest evidence that the message is not
  load-bearing.
- The handler always costs one row read, even for a message whose row is gone.
  That is the price of not trusting a stale payload, and it is cheap.
