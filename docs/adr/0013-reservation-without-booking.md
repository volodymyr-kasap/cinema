# 13. Reservation without Booking until payment exists

**Status:** accepted (2026-08-28)

## Context

`spec.md`'s entity list names `bookings`, `payments` and `tickets` alongside
reservations. Creating them now, even empty, would "get the schema right up
front".

## Decision

Phase 2 ships one aggregate: `Reservation`, with the state machine

```
PENDING → CONFIRMED | CANCELLED | EXPIRED
```

`CONFIRMED` is the end of the line. No `bookings`, `payments` or `tickets` table
is created.

## Alternatives considered

- **Create `bookings` now, as the entity list says.** A table nothing writes and
  nothing reads is not a seam, it is a guess about a design that has not been
  worked out yet. The shape a booking needs is decided by how payment works, and
  payment is sub-project 5. Building it now means either migrating it later
  anyway or bending the payment design to fit a table invented before it.
- **Model confirmation as a `bookings` row created from a reservation.** The same
  guess with more moving parts, and it splits one lifecycle across two tables
  before anything requires the split.

## Consequences

- Confirming a hold means the seats are yours; no money changes hands, and the
  word "confirmed" carries no financial meaning yet.
- Cancelling a `CONFIRMED` reservation answers 409. Refunds arrive with the money
  that would need refunding.
- The `PENDING → CONFIRMED` edge in `state-machine.ts` is the single seam
  sub-project 5 opens to insert `PAYMENT_PENDING`, without touching the seat map
  or adding screens.
- The seat map's `CONFIRMED` status already means "sold" as far as the invariant
  is concerned: a confirmed reservation never releases its seats.
