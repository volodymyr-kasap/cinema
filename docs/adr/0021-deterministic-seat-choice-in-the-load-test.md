# 21. Deterministic seat choice in the load test

**Status:** accepted (2026-08-28)

## Context

The correctness scenario makes 10 000 attempts against a 1000-seat hall and must
end with exactly 1000 reservations. That assertion has to hold every run, or it
is not an assertion.

## Decision

Attempt _n_ takes seat _n mod 1000_. Exactly ten clients contend for each seat.

## Alternatives considered

- **Random seat choice.** This is the coupon collector's problem with 10 000
  draws into 1000 bins: the expected number of seats nobody draws is
  `1000 × (1 - 1/1000)^10000 ≈ 0.045`. So `created == 1000` would fail roughly
  once in twenty runs for a reason with nothing to do with locking. A flaky
  correctness test is worse than no correctness test — it teaches the reader to
  re-run instead of to look.
- **Assert `created >= 995`.** Weakens the one guarantee the sub-project exists
  to demonstrate in order to accommodate the sampling method.

## Consequences

- Contention per seat is uniform rather than realistic. That is the right trade
  for a pass/fail assertion; a realistic popularity distribution belongs to the
  performance scenario if it is ever wanted.
- The run is reproducible: the same attempt always targets the same seat, so a
  failure can be re-run and read.
