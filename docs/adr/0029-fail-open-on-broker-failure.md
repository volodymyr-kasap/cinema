# 29. Fail open when the broker fails, and `/ready` does not check it

**Status:** accepted (2026-09-01)

## Context

An expiry message that could fail a hold would have made an optional subsystem
load-bearing. This is the same shape as ADR 0018, one subsystem later.

## Decision

Publication errors, unroutable returns and confirmation timeouts
(`RABBITMQ_PUBLISH_TIMEOUT_MS`, default 200 ms) are logged at `warn`, counted in
`ExpirePublisher.failureCount`, and the `201` is returned unchanged. Readiness
still means "PostgreSQL answers".

The same rule governs startup. A broker that is unreachable at boot, **and a
broker that is reachable but holding a topology we cannot assert**, both yield a
null connection and a loud warning rather than a failed or hanging boot. The
second case is not hypothetical: amqplib's recovery catches a failing `setup`
and reschedules for ever without resolving or rejecting, so an unguarded
connection would hang boot permanently on a `RESERVATION_TTL_SECONDS` change
(ADR 0024). The connection factory asserts the topology on a throwaway probe
first, precisely so that case becomes a rejection it can fail open on.

This also records a deviation from spec §7's table: `RABBITMQ_URL` has **no**
default, because a default makes the "refuse to start without it" rule
unreachable.

## Alternatives considered

- **Fail closed.** Trades a guarantee we have — holds are completely correct
  without a broker — for one we do not need.
- **Adding the broker to `/ready`.** Takes every replica out of rotation over a
  subsystem the service demonstrably works without, turning a degraded feature
  into an outage.
- **Crashing at boot on a topology mismatch.** Loud, and arguably honest. But
  every replica would crashloop simultaneously over a queue argument, so a
  misconfiguration of an optional subsystem would stop ticket sales entirely.

## Consequences

- A hold created while the broker is down is settled by lazy expiry, and nothing
  is lost.
- The API's `depends_on` deliberately omits `rabbitmq`.
- The cost of a dead broker is one timeout per hold. That is where sub-project
  5's circuit breaker goes — it now has two subsystems with the same failure
  shape to abstract over rather than one hypothetical one.
