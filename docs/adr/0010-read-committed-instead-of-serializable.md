# 10. READ COMMITTED instead of SERIALIZABLE

**Status:** accepted (2026-08-28)

## Context

Taking a hold is the hottest write path in the project: fifty clients may
contend for one seat. "Raise the isolation level to `SERIALIZABLE` and stop
worrying" is the first thing that comes to mind, which is exactly why the choice
is recorded rather than left implicit.

## Decision

Holds run at PostgreSQL's default `READ COMMITTED`, with no application-level
locks on the seat race.

## Alternatives considered

- **`SERIALIZABLE` plus a retry loop on `40001`.** It adds nothing here. The
  invariant is enforced by a unique index
  ([0009](0009-partial-unique-index-as-the-booking-invariant.md)), which holds at
  every isolation level. What `SERIALIZABLE` does add is serialisation failures
  on the busiest path in the system and a retry loop to absorb them — complexity
  bought to protect something already protected.
- **`SELECT ... FOR UPDATE` on the seat rows before inserting.** A pessimistic
  lock reintroducing the check-then-act shape the index exists to remove, and
  the seat rows being locked do not yet exist.

## Consequences

- The only pessimistic lock in the sub-project is the `SELECT ... FOR UPDATE`
  that confirm and cancel take on the single reservation row. It guards one row
  against its own concurrent endings, not against the seat race.
- Seats must be inserted in a deterministic order — sorted by `seat_id`. Without
  it two transactions with overlapping seat sets wait on each other crosswise:
  one holds A and wants B, the other holds B and wants A. PostgreSQL detects the
  deadlock and kills one with `40P01`, turning a request that had earned an
  honest 409 into a 500. A single ordering makes the cycle impossible and costs
  one `sort()`.
- The contention suite asserts the absence of 500s precisely so that a lost
  ordering shows up as a failing test rather than as a rare production error.
