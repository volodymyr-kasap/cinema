# 11. Lazy hold expiry, with no background sweeper

**Status:** accepted (2026-08-28)

## Context

A hold lasts ten minutes (`spec.md` §9). Something has to make the seats
available again when the user walks away. The obvious answers are a scheduled
job that sweeps expired holds, or an external TTL.

## Decision

Expiry is lazy and nothing runs in the background. A `PENDING` reservation past
its `expires_at` is released by the next caller who wants those seats: step 3 of
the hold transaction marks such reservations `EXPIRED` and stamps `released_at`
on their seat rows, scoped to the seats this request asked for.

The same predicate — `status = 'CONFIRMED' OR (status = 'PENDING' AND
expires_at > now())` — decides both "this hold blocks an insert" and "this seat
reads as taken" on the seat map. One definition of occupied, not two that can
disagree. Comparisons use the database's `now()`, never the Node clock.

## Alternatives considered

- **A scheduled sweeper (cron, `setInterval`, a worker).** A process to deploy,
  monitor and reason about, whose only job is to tidy rows that bother nobody. A
  lapsed hold is invisible until someone wants the seat, and at that moment the
  person it inconveniences is right there and can clear it.
- **Doing nothing at all.** Then a lapsed hold blocks its seats forever, and the
  ten-minute limit means nothing.
- **Releasing every expired hold of the showtime on each attempt.** Correct, but
  it makes every hold on a busy screening write the same rows — an artificial
  contention point invented exactly where it is least wanted. The work is bounded
  by the size of the request instead.

## Consequences

- No scheduler, no cron entry, and no `setInterval` exists anywhere in the
  codebase — an assertion the Definition of Done checks.
- A reservation may sit in `PENDING` past its expiry until someone asks for the
  seats. That is a display detail, not a correctness one: every read applies the
  same expiry predicate, so it never reads as held.
- Confirm re-checks `expires_at` under its row lock and records the expiry before
  answering 409 — whoever discovers the expiry is the one who writes it down.
- `RESERVATION_TTL_SECONDS` is configurable because the contention tests need it
  expressed in seconds.
- This is the seam sub-project 3 replaces with a Redis TTL and a
  `reservation.expire` message on RabbitMQ, which is what gives that comparison
  something to measure against.
