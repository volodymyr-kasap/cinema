# 20. Several API replicas behind nginx, with DNS resolved at runtime

**Status:** accepted (2026-08-28)

## Context

A distributed lock in a stack with one process is a lock against nothing. The
experiment has to measure a cluster, so the stack has to be one.

## Decision

`deploy: replicas: ${API_REPLICAS:-3}`, the API loses its published port, and
`apps/web/nginx.conf` — the same nginx that serves the SPA — becomes the balancer
with `resolver 127.0.0.11 valid=10s` and a `proxy_pass` through a variable.

## Alternatives considered

- **Leave the literal `proxy_pass http://api:3000`.** nginx resolves the name
  **once, at startup**, and pins every request to whichever replica answered
  first, for the life of the container. The stack looks balanced, `docker compose
ps` shows three healthy replicas, and the experiment measures one of them. This
  is the most likely way to get a fake result out of this sub-project, so it is
  not merely rejected: the API stamps `X-Instance-Id`, and the k6 run fails when
  any replica served less than half its equal share.
- **An explicit `upstream` block naming three hostnames.** Hardcodes the replica
  count into the image, so `API_REPLICAS` would lie.
- **A separate balancer container.** One more moving part to explain, for a stack
  that already has an nginx in front of the SPA.

## Consequences

- The API is reached at `http://localhost:8080/api/`; Swagger UI moves with it.
- `docker-compose.single-api.yml` restores one instance on port 3000 for
  development, so nobody is tempted to edit the scaled file back.
- Multiple instances are the precondition for everything after this: workers,
  consumers and idempotency only mean anything where there is more than one.
