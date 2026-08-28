# 7. Testcontainers instead of mocked repositories

**Status:** accepted (2026-08-27)

## Context

The API's interesting behaviour lives in the database: the exclusion constraint,
`uuidv7()` defaults, `AT TIME ZONE` date filtering, and row-value cursor
comparisons.

## Decision

API integration tests start a real `postgres:18-alpine` through Testcontainers,
run the migrations against it, and exercise the app through `app.inject`.

## Alternatives considered

- **Mocked repositories.** Fast, but they would assert that the mock behaves as
  written — none of the four behaviours above would be exercised at all.
- **SQLite.** A different engine: no `tstzrange`, no GiST exclusion constraints,
  no `uuidv7()`, different time zone semantics.

## Consequences

- Docker must be running to test the API, locally and in CI.
- The suite takes seconds rather than milliseconds, which is an acceptable
  trade for testing the thing that actually ships.
- Phase 1 is read-only, so the suites share one seeded database; the two tests
  that write wrap themselves in `BEGIN`/`ROLLBACK`. Sub-project 2 will need a
  general rollback harness, and that is the right time to build it.
