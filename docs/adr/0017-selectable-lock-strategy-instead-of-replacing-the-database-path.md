# 17. A selectable lock strategy instead of replacing sub-project 2's path

**Status:** accepted (2026-08-28)

## Context

ADR 0008 deferred Redis so that the comparison in `spec.md` §25 would have an
honest baseline. A comparison that cannot be re-run is not a result, it is an
anecdote — so the baseline has to stay executable on the same commit as the
thing it is compared against.

## Decision

`LOCK_STRATEGY=db|redis`, both adapters compiled into every build, `db` the
default. A new subsystem does not switch itself on; enabling it is an explicit
act.

## Alternatives considered

- **Delete the database path once Redis works.** The baseline would then be an
  old tag, built by a different compiler against different dependencies. Any
  difference measured would include the difference between two builds, and the
  one number the sub-project is meant to produce would be uninterpretable.
- **A build flag.** The same problem in a smaller form, plus two artefacts to
  keep honest and a second CI matrix to keep them honest with.
- **A request header or per-request switch.** Would make the strategy a property
  of a request rather than of a deployment, and the two would interleave inside
  one measurement.

## Consequences

- `NoopSeatLock` exists so that strategy `db` is _the same_ `create()` with a
  do-nothing adapter, not a second code path. The experiment therefore measures
  the lock and not two implementations.
- `reservations-contention.e2e.spec.ts` runs twice, once per strategy: the Redis
  path re-earns sub-project 2's guarantees instead of inheriting them.
- The experiment can be reproduced on any commit from here on.
