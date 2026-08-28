# 6. A GiST exclusion constraint for showtime overlap

**Status:** accepted (2026-08-27)

## Context

Two showtimes must never overlap in the same hall. A showtime can start part way
through another, so the rule is about ranges, not about start times.

## Decision

```sql
ALTER TABLE showtimes ADD CONSTRAINT showtimes_no_overlap
  EXCLUDE USING gist (
    hall_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  );
```

## Alternatives considered

- **Unique index on `(hall_id, starts_at)`.** Only catches two showtimes
  starting at the same instant; a film beginning in the middle of another
  passes.
- **An application-level check before insert.** A check-then-act race: two
  concurrent inserts both read a clear hall and both proceed.

## Consequences

- The database rejects the overlap regardless of which code path attempts it,
  including the seed and any future admin tooling.
- The `[)` bound is deliberate: a showtime may start at the exact instant the
  previous one ends, which the seed relies on and a test pins.
- Requires the `btree_gist` extension, created in the same migration.
