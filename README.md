# Cinema Booking Platform

Seat booking under contention, built as a study of the machinery real ticketing
systems need: transactions, distributed locking, asynchronous workers, event
streaming and observability.

This repository is being built in sub-projects. **Phase 3 — Redis, distributed
locking and measurement — is what exists today:** the catalogue API and seat map
from phase 1, seat holds and the proof that one seat cannot be sold twice from
phase 2, and now an advisory Redis lock in front of the transaction together with
the numbers that say what each strategy costs. See
[`docs/superpowers/specs/`](docs/superpowers/specs/) for the design of each
phase and [`docs/adr/`](docs/adr/) for why each decision was made.

## Running

```bash
docker compose up --build
```

- SPA: <http://localhost:8080>
- API: <http://localhost:8080/api/v1/movies>
- OpenAPI: <http://localhost:8080/api/docs>

The API runs as three replicas behind the same nginx that serves the SPA
(`API_REPLICAS` changes the count), so it has no published port of its own. For
day-to-day work, one instance on the familiar port:

```bash
docker compose -f docker-compose.yml -f docker-compose.single-api.yml up
```

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

Since phase 3 the suite runs twice, once per `LOCK_STRATEGY`. The Redis path does
not inherit these guarantees, it re-earns them: an advisory lock that changed any
of these answers would be a lock that had quietly become authoritative.

## The experiment

Sub-project 3's deliverable is a comparison, not an opinion. Both strategies run
the same two scenarios against the same stack:

```bash
LOCK_STRATEGY=db    npm run load:correctness   # 10 000 attempts -> 1000 sold, 0 twice
LOCK_STRATEGY=redis npm run load:correctness
LOCK_STRATEGY=db    npm run load:performance   # 100 -> 500 -> 1000 -> 2000 req/s
LOCK_STRATEGY=redis npm run load:performance
```

k6 runs inside the stack's network and goes through nginx, so it competes with
nothing on the host loopback. The correctness run is pass/fail and does not
depend on how fast the machine is; the performance run asserts nothing except
that all three replicas were actually serving traffic — a run where one replica
answered everything is a measurement of one container, not of a cluster.

Results: [`docs/experiments/2026-08-28-db-vs-redis-locking.md`](docs/experiments/2026-08-28-db-vs-redis-locking.md).

## What phase 3 deliberately does not have

Still no authentication, no payments, no queues, no metrics. Each arrives in its
own sub-project together with the problem it solves — the specification's first
principle is that no technology enters without one.

Phase 3 admits exactly one new runtime dependency, `ioredis`, and it had to earn
it. ADR 0008 deferred Redis in phase 1 so that the database-only path would exist
as an honest baseline; the price of that path is that every loser pays a
transaction and a connection. Phase 3's job was to measure that price rather than
assert it, which is why both strategies still ship in the same build and the
comparison can be re-run on any commit.

## Notable details

- **Seats belong to halls, not to showtimes.** Availability attaches to the
  `(showtime, seat)` pair. Copying 1000 seats per showtime would mean 100k
  duplicate rows per hall per season.
- **No double booking is a partial unique index, not application code.**
  `reservation_seats (showtime_id, seat_id) WHERE released_at IS NULL` is the
  invariant; holds are taken with `INSERT ... ON CONFLICT DO NOTHING RETURNING`,
  so the index — not a service check — serialises the race, and the returned rows
  name the seats the caller lost.
- **The Redis lock is advisory, and the index still has the last word.** A key
  missing means Redis does not know, never that the seat is free. `FLUSHALL`
  against a running stack costs a wasted transaction per request and produces no
  double booking — there is a test that does exactly that.
- **Holds expire lazily, with no scheduler.** A lapsed hold is released by the
  next caller who wants those seats. The API runs no cron job, no worker and no
  timer of any kind; the only interval in the repository is the one-second tick
  that redraws the countdown in the browser.
- **Overlapping showtimes are impossible by construction** — a GiST exclusion
  constraint over `tstzrange`, not an application check.
- **Every failure is an RFC 9457 problem document** carrying the request's
  `traceId`, which is the same id echoed in the `x-request-id` header and
  stamped on every log line.
- **The seat map is keyboard-navigable** — one tab stop, arrow keys across the
  hall — and never carries status by colour alone.
