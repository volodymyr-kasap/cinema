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
    const every: ReservationStatus[] = [
      'PENDING',
      'PAYMENT_PENDING',
      'CONFIRMED',
      'PAYMENT_FAILED',
      'CANCELLED',
      'EXPIRED',
    ];

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

describe('payment states', () => {
  it('lets a hold start a payment or confirm directly', () => {
    // Both edges are legal in the graph and PAYMENT_MODE picks which one
    // confirm() uses. The graph describes the domain; it does not read the
    // environment.
    expect(canTransition('PENDING', 'PAYMENT_PENDING')).toBe(true);
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(true);
  });

  it('lets a payment succeed or fail', () => {
    expect(canTransition('PAYMENT_PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransition('PAYMENT_PENDING', 'PAYMENT_FAILED')).toBe(true);
  });

  it('will not expire or cancel a reservation that is paying', () => {
    // "The payment owns the row", expressed where it is enforced rather than
    // in a comment. A hold whose money may already have moved is not the
    // user's to take back and not the sweeper's to reclaim.
    expect(canTransition('PAYMENT_PENDING', 'EXPIRED')).toBe(false);
    expect(canTransition('PAYMENT_PENDING', 'CANCELLED')).toBe(false);
  });

  it('treats PAYMENT_FAILED as terminal', () => {
    expect(TERMINAL_STATUSES.has('PAYMENT_FAILED')).toBe(true);
    expect(canTransition('PAYMENT_FAILED', 'PENDING')).toBe(false);
    expect(canTransition('PAYMENT_FAILED', 'PAYMENT_PENDING')).toBe(false);
  });

  it('leaves PAYMENT_PENDING out of the terminal set', () => {
    expect(TERMINAL_STATUSES.has('PAYMENT_PENDING')).toBe(false);
  });
});
