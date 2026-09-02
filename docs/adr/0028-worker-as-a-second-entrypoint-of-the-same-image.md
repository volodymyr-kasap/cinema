# 28. The worker is a second entry point of the same image

**Status:** accepted (2026-09-01)

## Context

The consumer must not share a crash domain or an event loop with request
serving: a retry storm should not become API latency, and a worker that falls
over should not take a replica of the API with it. The project has one
deployable image and one API package.

## Decision

`apps/api/src/worker/main.ts` boots a Nest **application context** — no HTTP
adapter, no controllers, no port — and Compose runs it from the same image with
a different `command`. `ReservationService` is reused by plain import.

## Alternatives considered

- **A separate `apps/worker` package.** The shape spec §10's diagram draws, and
  the right answer eventually. But the shared code — schema, Drizzle module, seat
  lock, config, logger — would have to move into `packages/` to be importable
  from a second app: a monorepo refactor paid for in full before a second worker
  exists to justify it.
- **Consuming inside the API replicas.** No new container, and competing
  consumers for free. It also puts the retry ladder on the same event loop as the
  request path, so a failing handler becomes measurable API latency and phase 3's
  numbers stop being comparable to phase 4's.

## Consequences

- No new build, no second Dockerfile, no package extraction.
- The worker has its own connection pool and its own crash domain.
- In `lazy` mode the process logs one line and exits `0`. That is success, so its
  Compose restart policy must be `on-failure` rather than `always` — `always`
  would restart a process that had just succeeded, in a loop.
