# Cinema Booking Platform

Seat booking under contention, built as a study of the machinery real ticketing
systems need: transactions, distributed locking, asynchronous workers, event
streaming and observability.

This repository is being built in sub-projects. **Phase 5 — payment, idempotency
and the circuit breaker — is what exists today:** the catalogue API and seat map
from phase 1, seat holds and the proof that one seat cannot be sold twice from
phase 2, the advisory Redis lock and the numbers that say what each strategy
costs from phase 3, the expiry of a hold as a delivered message with the retry
ladder and dead-letter queue behind it from phase 4, and now a payment that
travels as a message, is charged through a real HTTP provider behind a circuit
breaker, and cannot be charged twice however the response is lost. See
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

| Path                    | What it is                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`    | Zod schemas shared by both sides. The API validates with them, the SPA parses responses with them, and the OpenAPI document is generated from them |
| `apps/api`              | NestJS on the Fastify adapter, Drizzle over PostgreSQL 18                                                                                          |
| `apps/web`              | Vite + React + Tailwind, TanStack Query for server state, URL for UI state                                                                         |
| `apps/payment-provider` | A fake payment provider: Fastify, no database, four scenarios. Its own service so that stopping it proves the breaker                              |

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

## Expiry as a message

A hold lasts ten minutes. Since phase 4 that deadline is also a message:
`create()` publishes `reservation.expire` into a queue with no consumer whose
TTL is the length of the hold, and when it lapses the broker delivers it to a
worker that settles the row.

```bash
RESERVATION_EXPIRY_MODE=queue docker compose up --build
docker compose exec rabbitmq rabbitmqctl list_queues name messages
```

The mode defaults to `lazy`, which is phase 3's behaviour exactly: no connection,
no queues, nothing published. That is not a fallback but the baseline — the whole
suite runs in both modes, and a worker that changed any answer phase 2 or phase 3
proved would be a worker that had quietly become load-bearing.

Stop the broker and holds still expire. That is the design, not a consolation:
lazy expiry never stopped being authoritative (ADR 0030).

## Payment

`PAYMENT_MODE=off` by default: confirm answers `200 CONFIRMED` exactly as it did
in phase 2, and no payment row is written. With `PAYMENT_MODE=queue` (and
`RESERVATION_EXPIRY_MODE=queue`):

```bash
RESERVATION_EXPIRY_MODE=queue PAYMENT_MODE=queue docker compose up --build
```

confirm answers `202` with `PAYMENT_PENDING`, the worker charges the provider on
phase 4's retry ladder, and the reservation settles to `CONFIRMED` or
`PAYMENT_FAILED`. `X-Payment-Scenario: success|decline|error|timeout` on the
confirm request picks the provider's behaviour; without it the `PROVIDER_*_RATE`
weights roll one.

Nothing charges twice, and no idempotency key is stored to arrange it: the row
lock plus `payments.reservation_id UNIQUE` make five concurrent confirms one
payment, and `Idempotency-Key: payments.id` — stable across every rung of the
ladder — makes a lost response one charge at the provider (ADR 0035).

Stop the provider and the API keeps answering `202`; after five consecutive
failures the worker's breaker opens, and the seats come back through
`PAYMENT_FAILED` when the deadline passes.

```bash
docker compose stop payment-provider
docker compose logs worker | grep -iE "unavailable|circuit"
```

## What phase 5 deliberately does not have

Still no authentication, no Kafka, no metrics and no rate limiting. Each arrives
in its own sub-project together with the problem it solves — the specification's
first principle is that no technology enters without one.

There is no outbox either, and its absence is deliberate rather than overlooked:
`payment.requested` publishes inside the transaction and throws, which buys back
the lost-message problem at the price of a broker round trip under a row lock
(ADR 0037). That price is worth paying for one message per transaction and stops
being worth paying for two, which is exactly where the outbox goes.

Compensation is not written. There is one scenario where money moves and no
booking exists — a charge that succeeds after its reservation has been reaped —
and closing it needs a `/void` path on the provider and a refund state on the
payment. It is named here rather than hidden.

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
  next caller who wants those seats, and that path remains the guarantee. The API
  runs no cron job and no timer of any kind; the only interval in the repository
  is the one-second tick that redraws the countdown in the browser.
- **A hold expires because a message was delivered, and also because someone
  wanted the seat.** Two paths write the same transition on purpose. Both take
  the same row lock, both are idempotent, and whichever arrives first wins —
  which is what lets a dead broker cost nothing but a warning.
- **The ten-minute delay is a queue, not a timer.** There is still no cron, no
  `setInterval` and no sweeper anywhere in the API: the wait queue's TTL is the
  clock, and the worker only ever acts on a message addressed to it. A sweeper
  scans for work that may not exist; this receives work that already does.
- **The hold's clock stops when payment starts, and `expires_at` is never
  rewritten.** A `reservation.expire` delivered during `PAYMENT_PENDING` takes
  nothing; the payment's own deadline reaps it instead. Extending the hold would
  mean a per-message delay, and the wait queue's fixed TTL is what lets phase 4
  avoid the delayed-message plugin (ADR 0036).
- **A declined card is not a provider failure.** The breaker counts only thrown
  errors, so a run of refused cards never stops the system from charging good
  ones — and the breaker never has to know what a card is (ADR 0038).
- **Overlapping showtimes are impossible by construction** — a GiST exclusion
  constraint over `tstzrange`, not an application check.
- **Every failure is an RFC 9457 problem document** carrying the request's
  `traceId`, which is the same id echoed in the `x-request-id` header and
  stamped on every log line.
- **The seat map is keyboard-navigable** — one tab stop, arrow keys across the
  hall — and never carries status by colour alone.
