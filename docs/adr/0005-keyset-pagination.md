# 5. Keyset pagination with an opaque cursor

**Status:** accepted (2026-08-27)

## Context

Collections are paginated. The seeded catalogue is small, but showtimes already
number in the hundreds and the load experiment will grow them.

## Decision

Every collection returns `{ data, nextCursor }`. The cursor is a base64url
encoding of the last row's ordering key — `[title, id]` for movies,
`[startsAt, id]` for showtimes — compared with a SQL row-value expression.

## Alternatives considered

- **`LIMIT`/`OFFSET`.** An insert between two page requests makes the reader
  skip or repeat a row, and the database still walks every skipped row, so cost
  grows with the offset.

## Consequences

- Cursors are opaque to clients, so the ordering can change without breaking
  them; a cursor the endpoint did not issue is rejected with a 400
  `invalid-cursor` problem document.
- Random access to "page 7" is not offered, which no screen in the SPA needs.
