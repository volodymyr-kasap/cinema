# Cinema Booking Platform

Seat booking under contention, built as a study of the machinery real ticketing
systems need: transactions, distributed locking, asynchronous workers, event
streaming and observability.

This repository is being built in sub-projects. **Phase 2 — reservations and
contention — is what exists today:** the catalogue API and seat map from phase 1,
plus seat holds, a reservation lifecycle, and the proof that one seat cannot be
sold twice. See
[`docs/superpowers/specs/`](docs/superpowers/specs/) for the design of each
phase and [`docs/adr/`](docs/adr/) for why each decision was made.

## Running

```bash
docker compose up --build
```

- SPA: <http://localhost:8080>
- API: <http://localhost:3000/api/v1/movies>
- OpenAPI: <http://localhost:3000/api/docs>

Migrations and the seed run as their own one-shot compose services before the
API starts.

### Development

Node 24.9 or newer is required (`.nvmrc` pins 24). Jest loads the pure-ESM
Fastify adapter through `require(ESM)`, which needs the synchronous `vm` module
APIs added in 24.9.

```bash
npm install
docker compose up -d postgres
npm run db:migrate && npm run db:seed
npm run dev:api    # http://localhost:3000
npm run dev:web    # http://localhost:5173, proxying /api
```

## Layout

| Path                 | What it is                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | Zod schemas shared by both sides. The API validates with them, the SPA parses responses with them, and the OpenAPI document is generated from them |
| `apps/api`           | NestJS on the Fastify adapter, Drizzle over PostgreSQL 18                                                                                          |
| `apps/web`           | Vite + React + Tailwind, TanStack Query for server state, URL for UI state                                                                         |

## Testing

```bash
npm test                      # contracts, api (Testcontainers), web
npm run e2e -w @cinema/web    # Playwright, against a running compose stack
```

API integration tests start their own `postgres:18-alpine` through
Testcontainers, so Docker must be running.

## Proving it

The deliverable of phase 2 is a test, not a claim:

```bash
npm test -w @cinema/api -- reservations-contention
```

Fifty clients race for one seat. Exactly one gets a `201`, forty-nine get a
`409`, none get a `500`, and exactly one active row exists afterwards. A second
case holds 1000 distinct seats of the premiere hall concurrently and expects
1000 successes — the invariant serialises a seat, not a showtime.

## What phase 2 deliberately does not have

No authentication, no payments, no Redis, no queues, no metrics. Each arrives in
its own sub-project together with the problem it solves — the specification's
first principle is that no technology enters without one. Phase 2 added no new
runtime dependency at all, which is what makes sub-project 3's measured
comparison of PostgreSQL against Redis worth running.

## Notable details

- **Seats belong to halls, not to showtimes.** Availability attaches to the
  `(showtime, seat)` pair. Copying 1000 seats per showtime would mean 100k
  duplicate rows per hall per season.
- **No double booking is a partial unique index, not application code.**
  `reservation_seats (showtime_id, seat_id) WHERE released_at IS NULL` is the
  invariant; holds are taken with `INSERT ... ON CONFLICT DO NOTHING RETURNING`,
  so the index — not a service check — serialises the race, and the returned rows
  name the seats the caller lost.
- **Holds expire lazily, with no scheduler.** A lapsed hold is released by the
  next caller who wants those seats. There is no cron job, no worker and no
  `setInterval` anywhere in the codebase.
- **Overlapping showtimes are impossible by construction** — a GiST exclusion
  constraint over `tstzrange`, not an application check.
- **Every failure is an RFC 9457 problem document** carrying the request's
  `traceId`, which is the same id echoed in the `x-request-id` header and
  stamped on every log line.
- **The seat map is keyboard-navigable** — one tab stop, arrow keys across the
  hall — and never carries status by colour alone.
