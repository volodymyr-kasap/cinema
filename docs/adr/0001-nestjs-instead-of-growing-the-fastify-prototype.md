# 1. NestJS from scratch instead of growing the Fastify prototype

**Status:** accepted (2026-08-27)

## Context

The repository started as a ~600-line Fastify service with Redis-backed seat
holds. The platform specification calls for NestJS and a different domain model
(Cinema → Hall → Showtime → Seat, plus Reservation, Booking, Payment, Ticket).
Later phases add RabbitMQ workers, Kafka consumers and a swappable payment
provider.

## Decision

Start a new NestJS application on the Fastify adapter. Keep the prototype in git
history (commit 569dfd5) rather than in the working tree.

## Alternatives considered

- **Grow the Fastify app.** Less ceremony and a faster start, but the modular
  wiring that Nest provides — DI for swapping a payment provider in tests,
  module boundaries for workers and consumers — would have to be hand-rolled.
- **Migrate route by route.** Keeps the app running at every step, but migrates
  a domain model that phase 1 discards anyway.

## Consequences

- The Redis locking semantics (`SET NX PX`, Lua check-then-act) are re-derived
  in sub-project 3 against the new schema; the prototype remains the reference.
- The Fastify adapter keeps the request throughput characteristics of the
  prototype and lets the plugin ecosystem (`@fastify/swagger-ui`) be used.
