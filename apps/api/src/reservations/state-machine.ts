import type { ReservationStatus } from '@cinema/contracts';

/**
 * The graph of legal transitions, in one place. The database's CHECK constraint
 * guards the set of values; this guards the edges between them. Splitting the
 * two is deliberate — SQL expresses the first well and the second badly.
 */
const TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED: [],
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
