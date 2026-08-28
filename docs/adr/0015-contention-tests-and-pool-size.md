# 15. Contention tests over `app.inject()`, with a configurable pool size

**Status:** accepted (2026-08-28)

## Context

The contention test is not an addition to this sub-project, it is its result.
`successful reservations = 1` has to be demonstrated, not asserted, and the way
it is demonstrated decides whether the demonstration means anything.

## Decision

Concurrency is produced by `Promise.all` over `app.inject()` — fifty in-process
requests against the real Nest application. The pool size becomes configurable
(`DATABASE_POOL_MAX`, default 10), and the contention suite raises it above its
client count before the module compiles.

## Alternatives considered

- **A default-sized pool.** This is the trap. At `max: 10`, forty of fifty
  clients queue for a connection rather than for a seat. The test still reports
  one `201` and forty-nine `409`s, and it passes for entirely the wrong reason —
  it would keep passing with the unique index dropped from a smaller set of truly
  concurrent transactions. Raising the pool above the client count is what makes
  the transactions actually overlap.
- **Driving load over HTTP with a real listener, or with k6.** `app.inject()` is
  not network traffic, but it produces genuine parallel transactions: the `pg`
  pool hands out distinct connections, and `ON CONFLICT` blocks on another
  transaction's uncommitted insert exactly as it does under load. Requests still
  travel through the validation pipes, the exception filter and the service — the
  whole path production load will take. Real load generation is `spec.md` §25 and
  sub-project 3, where the numbers are the point.
- **Unit-testing the service with a mocked database.** It would test the mock.
  The behaviour under test belongs to PostgreSQL.

## Consequences

- `apps/api/test/reservations-contention.e2e.spec.ts` asserts exactly one `201`,
  forty-nine `409`s, **no other status**, and exactly one active row. A 500 there
  means a deadlock or an unmapped constraint violation escaped, so the absence of
  500s is part of the assertion.
- A second test holds 1000 distinct seats of the premiere hall concurrently and
  expects 1000 successes — proof that the invariant serialises one seat, not the
  whole showtime.
- Suites that write now `TRUNCATE reservations, reservation_seats CASCADE` in
  `beforeEach`. The catalogue is untouched: it is seeded once and only read.
- These numbers are the baseline the Redis comparison in `spec.md` §25 is
  measured against.
