# 23. The reservation id comes from the application, and seat geometry is cached in process

**Status:** accepted (2026-08-28)

## Context

Two small consequences of putting a lock in front of the transaction.

The lock's value must exist **before** the row does, because the Lua release
compares the key against the reservation id (ADR 0019) — and the row is written
inside the transaction the lock is taken in front of.

And `SeatsUnavailableError` names seats the way a user reads them ("C7"). On the
fast path no seat row has been read yet, because not reading it is the point.

## Decision

`uuidv7()` in `apps/api/src/db/uuid-v7.ts` mints the id and passes it to the
`INSERT`; the column default stays as the guarantee for any other write path.
`SeatGeometryCache` memoises `seatId → label` per hall, lazily, in the process.

## Alternatives considered

- **`sessionId` as the lock value.** Breaks on an honest sequence: a session
  cancels an old reservation, the release deletes the key — and the key already
  belongs to that same session's _new_ reservation for the same seat.
- **`randomUUID()` for the id.** That is v4, unordered, and would cost exactly
  the B-tree locality ADR 0004 chose v7 for.
- **Fetching labels per loser.** Nine thousand `SELECT`s replacing nine thousand
  transactions: it moves the load Redis was added to remove rather than removing
  it.
- **Making `label` optional in the contract.** Degrades the public response to
  accommodate an internal detail of the server.

## Consequences

- The generator is strictly increasing, including inside one millisecond, and
  there is a test for it — "roughly ordered" gives away the property in exactly
  the burst where it matters.
- The cache has no invalidation, because the catalogue is seeded once and never
  edited in this sub-project. That is a recorded limitation, not an oversight:
  when an admin screen starts editing seats, the eviction hook goes on that
  class.
- The memoiser caches _promises_, so a cold cache under a thousand concurrent
  misses issues one query rather than a thousand, and a rejected load is evicted
  instead of being served forever.
