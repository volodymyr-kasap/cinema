# 34. The reservation is the booking; only `payments` is added

**Status:** accepted (2026-09-04)

## Context

ADR 0013 declined to create `bookings`, `payments` and `tickets` in phase 2 and
said the shape a booking needs is decided by how payment works — a question it
deferred to this sub-project. That question is now answerable, so this ADR
answers it rather than deferring it again.

`spec.md`'s entity list still names `bookings`.

## Decision

One new table: `payments`, one row per reservation, `reservation_id UNIQUE`.
The reservation itself gains two statuses — `PAYMENT_PENDING` and
`PAYMENT_FAILED` — and remains the single aggregate that owns seats, prices,
the session and the lifecycle.

There is no `bookings` table.

## Alternatives considered

- **`bookings`, as the entity list names it.** Written out, it holds the
  session, the showtime, the seats, the per-seat prices and the total — every
  one of which the reservation already holds and none of which may disagree
  with it. To stop it disagreeing it would need its own anti-double-booking
  rule alongside the partial unique index (ADR 0009), which means either a
  second invariant to keep in step or a foreign key that admits the reservation
  was the booking all along.
- **`bookings` as a thin row created on `CONFIRMED`.** Cheaper, and still a
  second identity for one thing. Every subsequent question — which id does a
  ticket quote, which does a refund quote, which does the customer see —
  acquires two answers.
- **Renaming `reservations` to `bookings` once paid.** A table rename that
  encodes a status. The status column already encodes the status.

A new table earns its place by carrying an invariant nothing else can. Only
`payments` does: `reservation_id UNIQUE` is what makes five concurrent confirms
one charge (ADR 0035), and money moving is genuinely a different fact from
seats being held.

## Consequences

- `CONFIRMED` finally means what ADR 0013 said it did not yet mean: money moved.
- Tickets, refunds and payouts in a later sub-project hang off `payments.id` and
  quote `provider_ref`. They do not need a booking id, because the reservation
  id is one.
- The seat map, the reservation list and the SPA's routes are untouched by
  payment existing. Two new statuses, no new resource.
- `spec.md`'s entity list is knowingly not followed here. It was written before
  the payment design existed; this ADR is the record of choosing the design over
  the list.
