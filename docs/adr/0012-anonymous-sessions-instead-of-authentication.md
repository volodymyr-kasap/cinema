# 12. Anonymous sessions instead of authentication

**Status:** accepted (2026-08-28)

## Context

A reservation belongs to someone, so phase 2 needs an owner. The seed already
contains a `users` table, and adding a login would give reservations a real
foreign key.

## Decision

A reservation belongs to a browser session. `reservations.session_id` is a
non-null `uuid` minted by the SPA with `crypto.randomUUID()`, kept in
`localStorage`, and sent as `X-Session-Id` on every reservation request. The
header is required on all five reservation endpoints and optional on the public
seat map, where its absence simply means `heldByYou` is false everywhere.

A reservation belonging to another session answers **404, not 403**: 403 would
confirm that the id exists. "Not found among yours" is also literally true from
where the caller stands.

## Alternatives considered

- **A JWT login over the seeded users.** Authentication introduced to satisfy a
  foreign key, not to solve a problem anyone has — the opposite of `spec.md`'s
  first principle. It also drags in password storage, token lifetimes and
  refresh, none of which phase 2 needs.
- **A nullable `user_id` column added now, as a seam.** `NULL` in every row is
  not preparation, it is a dead field. The column is added when logging in earns
  its place, and `session_id` becomes it.

## Consequences

- `users` stays seeded and referenced by nothing, exactly as phase 1 left it.
- Clearing browser storage loses access to holds that browser is holding. They
  expire on their own ([0011](0011-lazy-hold-expiry-without-a-sweeper.md)), so
  nothing leaks permanently.
- A session id is trivially forgeable. That is acceptable while there is nothing
  to steal — no payment, no personal data, no confirmed ticket worth money.
  Sub-project 5 changes that calculus, and authentication arrives with it.
- `GET /reservations` is always scoped to the header's session; an endpoint
  listing all reservations does not exist.
