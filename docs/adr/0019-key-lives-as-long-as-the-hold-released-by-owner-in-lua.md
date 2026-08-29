# 19. The key lives as long as the hold, and is released by owner in Lua

**Status:** accepted (2026-08-28)

## Context

The key's lifetime and the row's lifetime are two different facts kept by two
different clocks: the row expires against PostgreSQL's `now()` (ADR 0011), the
key against Redis's. For an authoritative value that drift would be a bug; for an
advisory one it is affordable, but only if the key can never outlive its purpose
by much.

Releasing is the sharper problem. "Read the value, compare it, delete it" as
three client commands is the same check-then-act race the database path exists to
avoid: between the `GET` and the `DEL` the key can lapse and be re-taken, and we
would delete a lock belonging to somebody else.

## Decision

`SET ... NX EX RESERVATION_TTL_SECONDS` on acquisition. Release and retain are
Lua scripts that compare the stored value against the reservation id before
acting, executed server-side as one step.

## Alternatives considered

- **`GET` then `DEL` from the client.** The check-then-act race above. It fails
  rarely and silently, and the symptom — a seat released out from under its
  holder — would surface as a double booking attempt in the database rather than
  as an error anyone could trace to Redis.
- **A key that lives for a day.** Every failed release would then block a free
  seat until tomorrow. The TTL is the blast radius of a lost release.
- **`MULTI` instead of a pipeline for acquisition.** Buys an atomicity that is
  not wanted — the partial acquisition is rolled back deliberately, by us, so
  that a request that has already failed does not sit on seats nobody holds — and
  costs a server-wide block.

## Consequences

- Keys are **not** sorted before acquisition. In the database the order is
  mandatory: `INSERT` _waits_ for the competing transaction, so without a common
  order two requests deadlock (ADR 0010). `SET NX` never waits — it fails
  immediately — so no wait cycle can form and there is nothing to break.
- A repeated `release` is a no-op. That is the only idempotence this sub-project
  has, and it is deliberately not `Idempotency-Key`, which belongs to
  sub-project 5 where a repeat costs money.
- `retain` on confirmation extends to the showtime's start rather than deleting,
  because a confirmed seat is never free again.
