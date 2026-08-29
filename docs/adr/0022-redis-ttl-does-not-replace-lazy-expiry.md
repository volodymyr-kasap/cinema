# 22. Redis TTL does not replace lazy expiry (amends ADR 0011)

**Status:** accepted (2026-08-28)

## Context

ADR 0011 chose lazy expiry over a sweeper and said, in as many words, that
sub-project 3's Redis TTL would take the job over. Having built it, that turns
out to be wrong, and saying so here is cheaper than leaving the earlier ADR to
mislead the next reader.

## Decision

Lazy expiry stays authoritative. A key lapsing writes nothing to PostgreSQL, and
PostgreSQL is the source of truth, so a lapsed key leaves a `PENDING` row past
`expires_at` that only a caller can settle. `releaseStaleHolds` still does the
settling, and now also drops the stale owner's key after the commit.

## Alternatives considered

- **Redis keyspace notifications driving a listener that expires the row.** A
  background worker with no delivery guarantee, arriving one sub-project before
  the one that gives the project a real one. Notifications are fire-and-forget:
  a listener that is restarting when the key lapses never learns it lapsed.
- **A scheduler or `setInterval` sweeper.** Ruled out by ADR 0011 and still
  ruled out; the reasons have not changed.

## Consequences

- The TTL is a bound on how long a _lock_ can outlive its hold, not on how long
  a hold can outlive its expiry. Two different facts, two different mechanisms.
- The real replacement is `reservation.expire` over RabbitMQ in sub-project 4,
  and `releaseStaleHolds` is the seam it replaces.
- Because the sweep releases another reservation's key, the ownership check in
  the Lua (ADR 0019) is what makes it safe.
