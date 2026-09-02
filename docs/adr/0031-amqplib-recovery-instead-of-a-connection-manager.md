# 31. amqplib's own recovery, not `amqp-connection-manager` and not `@nestjs/microservices`

**Status:** accepted (2026-09-01)

## Context

A long-lived consumer must survive a broker restart. AMQP channels do not
survive their connection, so recovery means reopening the connection,
re-asserting the topology and re-establishing every subscription.

## Decision

`connect(url, { recovery: … })`, added in amqplib 1.1.0: backoff, jitter, and a
`setup` hook that re-asserts topology after every successful connection. The
publisher and the consumer reopen their channels on the `connect` event.

## Alternatives considered

- **`amqp-connection-manager`.** The standard answer, and for years the correct
  one. It solves a problem the library now solves itself, and it is a second
  dependency against a phase that admits exactly one.
- **`@nestjs/microservices`' RMQ transport.** Idiomatic Nest, and it would hide
  ack, nack, prefetch and requeue behind decorators — which are precisely the
  mechanics spec §10 exists to learn. It also pulls in a whole transport layer to
  consume a single queue.

## Consequences

- `amqplib` is the only new runtime dependency.
- `@types/amqplib` must **not** be installed: the package has bundled its own
  declarations since 1.2.0, and the DefinitelyTyped package would shadow them
  with an older shape.
- `heartbeat` is never passed as `0`. amqplib 2.0.0 made zero mean "disable"
  rather than "defer to the server", so the way to take the server's value is to
  omit the option entirely.
- Recovery's unbounded retry budget is right for runtime and wrong for boot, so
  the initial connection is preceded by a throwaway probe. ADR 0029 records what
  that probe is for.
