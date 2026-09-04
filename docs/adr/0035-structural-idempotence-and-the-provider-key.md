# 35. Structural idempotence at the edge, `payments.id` as the provider key

**Status:** accepted (2026-09-04)

## Context

Two different things can be charged twice, and they need different answers.

The first is a customer double-clicking Confirm, or a client retrying a request
whose response was lost. The second is the worker retrying a charge whose HTTP
response was lost — the request may well have reached the provider and taken the
money.

ADR 0027 established the shape for the first kind in phase 4: the message
carries an id, the handler re-reads state, and the database's own constraints
decide what may happen. This applies the same reasoning where money is involved.

## Decision

**At the API edge: no idempotency key.** `confirm` takes `SELECT ... FOR UPDATE`
on the reservation, checks the status transition, and inserts into `payments`,
where `reservation_id UNIQUE` is the actual guarantee. Five concurrent confirms
serialise on the row lock; the first moves `PENDING → PAYMENT_PENDING` and
inserts; the other four find a reservation that is no longer `PENDING` and are
answered from the row that exists. One payment, one message, five `202`s.

**At the provider: `Idempotency-Key: payments.id`.** The id is minted with
`uuidv7()` (ADR 0004) before the row is written, is stable across every rung of
the retry ladder, and is the same value the message carries. A retried charge
after a timeout returns the original outcome and the original `providerRef`
rather than taking the money twice.

## Alternatives considered

- **An `Idempotency-Key` header on `confirm`.** This is the conventional answer,
  and it is the wrong shape here. `POST /reservations/:id/confirm` already names
  its target uniquely: the operation is addressable, so a client-supplied second
  identifier adds no information the URL lacks. What it does add is a key store
  to write, expire and race on, and a new failure mode — the same key presented
  against a different reservation — that has to be detected and answered. It
  buys a guarantee the row lock and the unique index already provide.
- **Application-level "have I charged this?" checks in the worker.** A read
  before a write with no lock between them. Two workers holding the same message
  both read "no" and both charge.
- **A provider-side key derived from the reservation id.** Works, and quietly
  states that a reservation may only ever be charged once — a policy this system
  happens to hold but should not encode in a header. `payments.id` says
  precisely what it means: this attempt at this charge.

## Consequences

- `payments.attempts` counts claims, not charges. A payment with `attempts: 3`
  and one `providerRef` is a lost response, not three cards charged.
- The provider must honour the key. The fake one stores charges by key and
  returns the stored result, which is the behaviour under test in the timeout
  scenario — retrying a hung request yields one charge and the same reference.
- No key store, no expiry policy for one, and no new table. The two mechanisms
  are a unique index and a header.
- A client that genuinely lost the `202` re-issues the confirm and gets the same
  reservation back with the same payment attached. Nothing to reconcile.
