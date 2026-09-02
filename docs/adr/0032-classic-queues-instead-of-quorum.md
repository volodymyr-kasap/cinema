# 32. Classic queues, not quorum queues

**Status:** accepted (2026-09-01)

## Context

RabbitMQ 4 offers quorum queues, and with them `x-delivery-limit`: bounded
redelivery and automatic dead-lettering, with no retry tiers and no hop-counting
code at all. It is a much smaller topology than ADR 0025's.

## Decision

Classic queues, and the retry tiers of ADR 0025.

## Alternatives considered

- **A quorum work queue with `x-delivery-limit`.** Fewer queues, no `x-attempt`
  header, no `nextHop`, and the broker enforces the cap. But quorum redelivery is
  **immediate**: a handler failing on a two-second database blip would burn its
  entire delivery budget in milliseconds and dead-letter a message that would
  have succeeded on the next tier. The backoff is the whole point of the ladder,
  and quorum queues do not provide one.

## Consequences

- No replication. That costs nothing in a single-broker stack, and would need
  revisiting the day the broker is clustered.
- The retry topology is ours to maintain, which is why `nextHop` is a pure
  function with its own tests rather than a broker setting.
