# 39. `PAYMENT_FAILED` is terminal; retrying means a new reservation

**Status:** accepted (2026-09-04)

## Context

A card is declined. The seats are held, the customer is on the page, and the
obvious kindness is a Try again button that reuses the reservation.

The state machine so far is acyclic: every reservation moves forward and stops.
`PENDING → CONFIRMED | CANCELLED | EXPIRED`, and now
`PENDING → PAYMENT_PENDING → CONFIRMED | PAYMENT_FAILED`.

## Decision

`PAYMENT_FAILED` is terminal, and reaching it releases the seats. Both the
provider's `DECLINED` and our own `FAILED` land here — kept distinct on the
payment row, because that distinction is the only signal separating a refused
card from a broken downstream, but identical in their effect on the
reservation.

Trying again means holding seats again: a new reservation, from the seat map.

## Alternatives considered

- **A `PAYMENT_FAILED → PENDING` retry edge.** This makes the graph cyclic, and
  everything downstream of that is worse. `payments.reservation_id UNIQUE` — the
  structural guarantee behind ADR 0035 — must either be dropped or worked around
  with a status-aware partial index. `expires_at` has to be rewritten, which
  ADR 0036 rules out because ADR 0024's wait queue depends on a single fixed
  TTL. And the retry itself needs a bound, on top of the ladder's bound, so
  there are two attempt limits meaning different things.
- **Keeping the seats held after a decline while offering a retry.** The seats
  are the scarce resource. Holding them for someone whose card was refused,
  against buyers whose cards work, is the wrong way round — and with no cap it
  is a way to hold a hall for free.
- **A new reservation created automatically for the same seats.** A retry edge
  wearing a disguise, and it races honestly-arriving buyers on the customer's
  behalf.

## Consequences

- **The UX cost is real and worth stating plainly:** a customer whose card is
  declined loses their seats and picks again, and the seats may be gone. That is
  the price of not letting a failed payment hold inventory. The page says so
  directly — the payment was declined, the seats were released — and links back
  to the seat map rather than offering a button that would promise something we
  no longer hold.
- The state machine stays acyclic, so `canTransition` remains a table anyone can
  read, and the unique index needs no exceptions.
- A retried booking is a new row with its own id and its own payment, which
  makes "how many attempts did this customer make?" a question about several
  reservations rather than a counter that has to be reset.
- Refunds, when they arrive, only ever apply to `CONFIRMED` reservations. There
  is no state in which a failed payment and a live hold coexist.
