# Cinema Booking Platform

Seat booking under contention, built as a study of the machinery real ticketing
systems need: transactions, distributed locking, asynchronous workers, event
streaming and observability.

This repository is being built in sub-projects. **Phase 1 — the foundation — is
what exists today:** the catalogue API, the seat map, and the infrastructure
everything later rests on. See
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

## What phase 1 deliberately does not have

No authentication, no booking, no Redis, no queues, no metrics. Each arrives in
its own sub-project together with the problem it solves — the specification's
first principle is that no technology enters without one.

## Notable details

- **Seats belong to halls, not to showtimes.** Availability will attach to the
  `(showtime, seat)` pair in sub-project 2. Copying 1000 seats per showtime
  would mean 100k duplicate rows per hall per season.
- **Overlapping showtimes are impossible by construction** — a GiST exclusion
  constraint over `tstzrange`, not an application check.
- **Every failure is an RFC 9457 problem document** carrying the request's
  `traceId`, which is the same id echoed in the `x-request-id` header and
  stamped on every log line.
- **The seat map is keyboard-navigable** — one tab stop, arrow keys across the
  hall — and never carries status by colour alone.
