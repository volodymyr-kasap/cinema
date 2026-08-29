# 16. Redis as an advisory lock in front of the invariant, not instead of it

**Status:** accepted (2026-08-28)

## Context

Sub-project 2 settles the seat race in the database and proves it: fifty
concurrent clients, one `201`, forty-nine `409`s. It also has a measurable cost.
Every loser pays a transaction. Nine thousand losers take nine thousand
connections from the pool, open nine thousand transactions and block inside
`ON CONFLICT` until the winner commits — contention for a seat becomes a queue
for a connection.

ADR 0008 deferred Redis precisely so that this cost would have an honest
baseline to be measured against. Sub-project 3 has to spend the deferral.

## Decision

`SET seat:{showtimeId}:{seatId} {reservationId} NX EX {ttl}` is taken **before**
the transaction opens. A caller who loses the key answers `409` in one
round-trip, without taking a connection and without opening a transaction.

The lock is advisory. The partial unique index `reservation_seats
(showtime_id, seat_id) WHERE released_at IS NULL` remains the invariant. The
absence of a key never means "the seat is free" — it means "Redis does not
know".

## Alternatives considered

- **Redis as the source of truth.** This requires that `FLUSHALL` can never
  happen, and it can — an operator, a restart without persistence, an eviction
  policy. A cold Redis would then permit double bookings, which is the single
  failure this project exists to prevent. The asymmetry in the decision above is
  what makes a cold, flushed or dead Redis degrade into sub-project 2 rather than
  into a double booking.
- **Row-level `SELECT ... FOR UPDATE` on the seat.** Still a transaction and a
  connection per loser. It moves the queue without shortening it.
- **Rejecting the request when Redis is unavailable.** Covered by ADR 0018; it
  makes an optional subsystem load-bearing.

## Consequences

- Two directions of divergence exist and are both tested. A key with no active
  row is a false rejection, bounded by the TTL, and documented rather than fixed.
  An active row with no key costs one wasted transaction, and the index has the
  last word — this is what a flushed Redis buys you.
- `NoopSeatLock` and `RedisSeatLock` implement one `SeatLock` port, so `create()`
  contains the order of operations exactly once (ADR 0017).
- The comparison this ADR exists to enable is recorded in
  `docs/experiments/2026-08-28-db-vs-redis-locking.md`.
