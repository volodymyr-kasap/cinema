# 24. A wait queue with a TTL, not a delayed-message plugin

**Status:** accepted (2026-09-01)

## Context

A hold lasts ten minutes, and something has to happen at the end of it. RabbitMQ
has no native scheduling: a broker will deliver a message now, or it will hold
it until a consumer asks, but it will not sit on one until a wall-clock deadline
passes and then release it.

ADR 0011 already rejected a sweeper for this job, so the delay has to belong to
the broker rather than to a timer in our process.

## Decision

`create()` publishes `reservation.expire` into `reservation.expire.wait`: a
durable queue **with no consumer**, an `x-message-ttl` equal to the length of a
hold, and a dead-letter exchange pointing at the work queue. Nothing reads that
queue. When a message's TTL lapses the broker moves it on, and the worker sees
it for the first time ten minutes after it was published.

The delay is therefore a property of the topology, not of any running process.

## Alternatives considered

- **`rabbitmq_delayed_message_exchange`.** The purpose-built answer, and it
  needs a custom Dockerfile for the broker — a plugin to install, a version to
  track, and an image to rebuild before the stack can start. It also holds
  delayed messages _outside_ any queue, so they do not show up as depth and
  survive a restart on different terms from everything else. Convenience bought
  with a non-stock broker, on a phase whose whole point is learning the
  mechanics.
- **A polling worker with a due-check query.** `SELECT ... WHERE expires_at <=
now()` on a schedule. This reintroduces exactly the sweeper ADR 0011 rejected,
  and it makes the queue a timer rather than a carrier of commands: the message
  would say "look for work" instead of "settle this hold".

## Consequences

- The stock `rabbitmq:4-management-alpine` image is enough. No plugin, no custom
  broker build.
- **The head-of-line rule becomes a recorded precondition.** A queue expires only
  its head, so this design is correct _only while every hold shares one TTL_. A
  sub-project that gives holds different lengths — a payment window, say — must
  replace this queue rather than reconfigure it. This is written twice in the
  spec and repeated in ADR 0025 because it is the assumption most likely to be
  broken by accident.
- Changing `RESERVATION_TTL_SECONDS` on a live stack means deleting and
  recreating the queue: arguments are part of a queue's identity, and asserting
  the same queue with a different TTL is `PRECONDITION_FAILED`. The API fails
  open when that happens rather than hanging (ADR 0029).
