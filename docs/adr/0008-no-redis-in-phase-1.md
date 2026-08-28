# 8. No Redis in phase 1

**Status:** accepted (2026-08-27)

## Context

The prototype already had working Redis seat locks (`SET NX PX` plus a Lua
check-then-act release), and it would be easy to carry them forward.

## Decision

Phase 1 ships no Redis. Seat holds arrive in sub-project 2 backed by PostgreSQL,
and Redis enters in sub-project 3.

## Alternatives considered

- **Reuse the prototype's Redis lock immediately.** Faster to a working hold,
  but sub-project 3's headline experiment is a measured comparison of database
  locking against Redis locking under 10,000 concurrent users. Without an
  honest PostgreSQL implementation measured first, there is nothing to compare
  against, and the project's founding principle — that no technology enters
  without the problem it solves — would be broken at the first opportunity.

## Consequences

- Sub-project 2 must make row locking genuinely correct rather than leaning on
  an external lock.
- The comparison in sub-project 3 has a real baseline, which is the point of
  building this at all.
