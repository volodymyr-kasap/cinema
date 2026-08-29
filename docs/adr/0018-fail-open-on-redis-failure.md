# 18. Fail open when Redis fails, and `/ready` does not check Redis

**Status:** accepted (2026-08-28)

## Context

The lock is advisory (ADR 0016), so correctness never depended on Redis. An
advisory lock that can fail a request has quietly made an optional subsystem
load-bearing — the opposite of what it was added for.

## Decision

Connection errors and command timeouts (`REDIS_COMMAND_TIMEOUT_MS`, default
200 ms) are logged at `warn`, counted on `RedisSeatLock.failureCount`, and the
request continues on the database path. `acquire` returns "nothing lost".
Readiness still means "PostgreSQL answers".

This ADR also records a deliberate deviation from spec §7's table, which lists
`REDIS_URL` with a default of `redis://localhost:6379` while the paragraph below
it requires the process to refuse to start with `LOCK_STRATEGY=redis` and no
URL. Both cannot be true: a default means the variable is never absent and the
refusal never fires. The refusal is the rule with teeth, so `REDIS_URL` has no
schema default and is optional; `redis://localhost:6379` lives in `.env.example`
where a developer can see it.

## Alternatives considered

- **Fail closed.** Trades a guarantee we have — correctness without Redis — for
  one we do not need. A Redis outage would become an outage of the product.
- **Add Redis to `/ready`.** Takes every replica out of rotation over a subsystem
  the service works without, turning a throughput problem into a total one.
- **A circuit breaker now.** The right next step, and §20 with sub-project 5
  gives it a real client (the payment provider) and one shared abstraction.
  Writing it here means writing it twice.

## Consequences

- While Redis is down, each request pays the command timeout before falling
  through. That is the cost this ADR accepts, and the place the circuit breaker
  will go.
- A failed `release` is worse than a failed `acquire`: the key outlives the row
  and holds a seat that is genuinely free. It is bounded by the TTL, which is
  exactly why the TTL is the length of a hold and not a day (ADR 0019).
- `failureCount` is in logs today and is what §22 will scrape on its first day.
