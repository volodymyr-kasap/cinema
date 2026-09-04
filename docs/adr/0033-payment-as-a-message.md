# 33. Payment travels as a message, and confirm answers `202`

**Status:** accepted (2026-09-04)

## Context

Confirming a booking is the first operation in this system that costs money and
depends on somebody else's uptime. A card processor is slow by the standards of
everything else here — tens to hundreds of milliseconds on a good day, and
seconds or a hung socket on a bad one.

Phase 4 built a retry ladder, a dead-letter queue and a worker for expiry
messages, which are the cheapest messages in the system: losing one costs
nothing, because lazy expiry is a complete backstop (ADR 0030). The one message
that genuinely matters was still missing.

## Decision

`POST /reservations/:id/confirm` moves the reservation to `PAYMENT_PENDING`,
inserts a `payments` row, publishes `payment.requested`, and answers **`202
Accepted`** with the reservation in its new state. The charge happens in the
worker, on the phase 4 ladder, against an HTTP provider.

`PAYMENT_MODE=off` is the default and keeps phase 2's behaviour exactly:
confirm answers `200 CONFIRMED` and no payment row is written. The switch is
one environment variable, in the shape ADR 0017 established for locking and
ADR 0024 for expiry.

## Alternatives considered

- **A synchronous charge inside the request.** The obvious thing, and wrong on
  two counts. It puts a slow third party directly into the user's latency
  budget and into a request holding a row lock; and it leaves the ladder, the
  DLQ and the worker — all built, all tested — unused for the one message where
  a retry actually saves a sale.
- **Fire-and-forget from the request, no message.** A charge that is dropped
  when the process restarts is a hold that never settles and a customer who
  never learns why.
- **Waiting on the message from the request handler.** A `202` that pretends to
  be a `200`. It reintroduces the latency it was supposed to remove and adds a
  correlation mechanism to do it.

## Consequences

- The API never talks to the provider. It has no timeout, no breaker and no
  reason to care that the provider exists; only the worker does.
- `202` is a real answer, not a placeholder: it carries the reservation with
  `status: PAYMENT_PENDING` and its `payment` object, so a client knows what was
  started and for how much.
- Clients must follow the reservation to a settled state. The SPA polls while
  `PAYMENT_PENDING` and stops on a terminal status.
- Two subsystems now share one worker process and one connection, which is what
  makes ADR 0028's "second entrypoint of the same image" pay for itself a
  second time.
