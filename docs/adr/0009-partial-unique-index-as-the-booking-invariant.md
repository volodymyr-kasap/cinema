# 9. A partial unique index is the no-double-booking invariant

**Status:** accepted (2026-08-28)

## Context

The founding technical requirement of the whole project is that any number of
simultaneous attempts to take one seat produce exactly one reservation. Phase 2
is the first sub-project where correctness depends not on what the service
says, but on what the database permits.

## Decision

`reservation_seats` carries a partial unique index:

```sql
CREATE UNIQUE INDEX reservation_seats_active_uq
  ON reservation_seats (showtime_id, seat_id)
  WHERE released_at IS NULL;
```

A row with `released_at IS NULL` means the seat is taken; cancelling or expiring
stamps `released_at` and the seat is free again. Holds are taken with
`INSERT ... ON CONFLICT DO NOTHING RETURNING seat_id` inside one transaction; if
fewer rows come back than seats were asked for, the request lost and rolls back.

`showtime_id` is denormalised onto `reservation_seats` for exactly one reason: a
partial unique index can only see columns on its own row. It is the only
denormalisation in the schema and it is forced.

## Alternatives considered

- **`SELECT` for availability, then `INSERT`.** The textbook check-then-act
  race: two transactions read the same free seat and both proceed. No amount of
  care in the service can close it, because the gap is between two statements.
- **Catching `23505` from a bare `INSERT`.** Also correct, and also a 409. But
  `ON CONFLICT DO NOTHING ... RETURNING` returns the seats that _were_ taken, so
  the difference names the seats that were **lost** — the client can say "C7 and
  C8 were just taken" instead of "something went wrong".
- **Denormalising `status` onto the seat rows.** The same work on a transition
  (update N rows), but state duplicated in two places that can diverge.
  `released_at` is one column with no second source of truth.
- **A trigger asserting `reservation_seats.showtime_id` matches its parent.**
  Both rows are written by one transaction from one value, and no other write
  path exists. A guard against an invariant that cannot be violated is cost
  without benefit.

## Consequences

- No write path — a future admin console, sub-project 4's worker, or a bug in
  the service — can produce a double booking, because the index forbids it.
- `ON CONFLICT DO NOTHING` is also the waiting mechanism: a competitor that has
  inserted but not committed blocks us until it commits or rolls back. No
  application lock is needed; the index performs the serialisation.
- Seats are inserted in `seat_id` order so overlapping requests cannot deadlock
  crosswise. See [0010](0010-read-committed-instead-of-serializable.md).
- Repeated ids in `seatIds` are rejected by the contract rather than collapsed,
  because `seat_id = ANY(...)` would count `[A, A]` once and the "fewer rows than
  asked for" check would then report a conflict on a seat nobody holds.
