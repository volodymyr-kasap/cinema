# 26. `x-attempt`, not `x-death`, as the attempt counter

**Status:** accepted (2026-09-01)

## Context

Bounded retries need to know which attempt this is. RabbitMQ already records
something like that: every dead-lettering stamps an `x-death` entry onto the
message.

## Decision

A header we write ourselves. `x-attempt` carries the number of failed handlings
so far: the producer publishes `0`, and a handler that fails on `n` republishes
with `n + 1` into tier `n + 1`. Three tiers therefore cap the handler at four
runs.

## Alternatives considered

- **Reading `x-death`.** It is already there, and it looks like it means what we
  need. It does not. RabbitMQ collapses entries by `(queue, reason)` and stores a
  `count` in each, so an attempt number can only be reconstructed by knowing
  which queues are retry tiers and summing across them — and re-derived every
  time the topology changes. It is a control variable that breaks when a queue is
  renamed, which is a bad property for the thing that decides whether to give up.

## Consequences

- `x-death` is still forwarded and still logged. As a record of where a message
  has been it is genuinely useful; it is history, not control, and the two roles
  are kept apart deliberately.
- A message published by hand, or by an older build, arrives without the header.
  `attemptOf` treats a missing or nonsense value as `0`, so such a message starts
  at the beginning of the ladder rather than crashing the consumer that received
  it.
