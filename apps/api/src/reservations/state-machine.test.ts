import type { ReservationStatus } from '@cinema/contracts';

import { TERMINAL_STATUSES, canTransition } from './state-machine';

describe('canTransition', () => {
  it('allows every exit from PENDING', () => {
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
    expect(canTransition('PENDING', 'EXPIRED')).toBe(true);
  });

  it('treats CONFIRMED, CANCELLED and EXPIRED as terminal', () => {
    // PAYMENT_FAILED is also terminal (Task 4 covers its transitions in
    // detail); listed here only so this test's own TERMINAL_STATUSES
    // assertion below stays accurate now that the enum carries six states.
    const terminal: ReservationStatus[] = ['CONFIRMED', 'CANCELLED', 'EXPIRED', 'PAYMENT_FAILED'];
    const every: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'];

    for (const from of terminal) {
      for (const to of every) {
        expect(canTransition(from, to)).toBe(false);
      }
    }

    expect(TERMINAL_STATUSES).toEqual(new Set(terminal));
  });

  // A confirmed hold must never be resurrected as pending, and a cancelled one
  // must never be confirmed: both would take a seat that is already free or
  // already sold.
  it('never returns to PENDING', () => {
    expect(canTransition('CONFIRMED', 'PENDING')).toBe(false);
    expect(canTransition('CANCELLED', 'PENDING')).toBe(false);
    expect(canTransition('EXPIRED', 'PENDING')).toBe(false);
  });

  it('rejects a transition to itself', () => {
    expect(canTransition('PENDING', 'PENDING')).toBe(false);
  });
});
