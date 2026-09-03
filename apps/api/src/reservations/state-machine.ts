import type { ReservationStatus } from '@cinema/contracts';

/**
 * The graph of legal transitions, in one place. The database's CHECK constraint
 * guards the set of values; this guards the edges between them. Splitting the
 * two is deliberate — SQL expresses the first well and the second badly.
 *
 * `PENDING` lists both `PAYMENT_PENDING` and `CONFIRMED`: which edge a confirm
 * uses is decided by `PAYMENT_MODE`, in the service. This module takes no
 * configuration, because a transition table with two shapes depending on the
 * environment is no longer a statement about the domain.
 *
 * `PAYMENT_PENDING` has no edge to `EXPIRED` or `CANCELLED`, and that absence is
 * the design: once a charge may have been made, the row belongs to the payment
 * (ADR 0036). A hold that is paying ends by succeeding or failing, never by
 * running out of time.
 */
const TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  PENDING: ['PAYMENT_PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'],
  PAYMENT_PENDING: ['CONFIRMED', 'PAYMENT_FAILED'],
  CONFIRMED: [],
  PAYMENT_FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const TERMINAL_STATUSES: ReadonlySet<ReservationStatus> = new Set(
  (Object.keys(TRANSITIONS) as ReservationStatus[]).filter(
    (status) => TRANSITIONS[status].length === 0,
  ),
);

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
