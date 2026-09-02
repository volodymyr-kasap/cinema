# 25. Retry tiers with fixed TTLs, not one retry queue with per-message TTLs

**Status:** accepted (2026-09-01)

## Context

A handler that fails should try again, and it should wait longer each time.
Backoff means different delays for different attempts, and the delay mechanism
available to us is the one ADR 0024 just chose: a queue with an `x-message-ttl`
that dead-letters when it lapses.

## Decision

One queue per rung of `RABBITMQ_RETRY_DELAYS_MS` — `reservation.expire.retry.1`,
`.2`, `.3` — each with its own fixed `x-message-ttl`, all dead-lettering back to
the work queue. A handler that fails republishes into the tier matching its
attempt number.

## Alternatives considered

- **One retry queue with a per-message `expiration`.** The obvious economy: one
  queue, and each message carries its own delay. It violates the very
  precondition ADR 0024 accepted one decision earlier. A queue expires only its
  head, so a 5-second message sitting behind a 120-second message waits the full
  120 seconds. The design would contradict itself two decisions apart, and the
  symptom — retries that are occasionally far too slow — would be almost
  invisible in testing.
- **A single fixed retry delay.** Simpler, and defensible. But then the backoff
  is not a backoff: a handler failing against a slow dependency retries into the
  same slowness at the same interval, which is the behaviour that turns a blip
  into an outage.

## Consequences

- Three extra queues in the management UI, which is a real cost in a topology
  someone has to read.
- The number of retries is the length of a list rather than a constant in code.
  That is what lets the tests run the whole ladder in milliseconds
  (`[100, 200, 400]`) while production runs it in minutes.
- The tiers are ours to maintain, which is why `nextHop` is a pure function with
  its own tests rather than arithmetic inlined in the consumer.
