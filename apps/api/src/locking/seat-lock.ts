export const SEAT_LOCK = Symbol('SEAT_LOCK');

/**
 * An *advisory* lock taken before the transaction opens. Holding it does not
 * make a seat yours -- the partial unique index does that (ADR 0009). Not
 * holding it does not mean the seat is free; it means Redis does not know. That
 * asymmetry is the whole design: a cold, flushed or dead Redis degrades into
 * sub-project 2, never into a double booking.
 */
export interface SeatLock {
  /**
   * Take the seats. Returns the ids that could not be taken -- an empty array
   * means the caller may proceed to the transaction.
   */
  acquire(showtimeId: string, seatIds: string[], reservationId: string): Promise<string[]>;
  /** Drop our own locks. Never touches another reservation's. Idempotent. */
  release(showtimeId: string, seatIds: string[], reservationId: string): Promise<void>;
  /** Extend our locks to the end of the seats' occupancy -- a confirmed booking. */
  retain(showtimeId: string, seatIds: string[], reservationId: string, until: Date): Promise<void>;
  /**
   * Reset our locks to a fixed window measured from now.
   *
   * Separate from `retain` because the two answer different questions. `retain`
   * asks "how long are these seats occupied", and the answer is a moment in the
   * calendar. This asks "how long may this reservation go on owning them
   * unresolved", and the answer is a duration with no moment attached -- the
   * payment deadline, which starts when the charge does.
   */
  retainFor(
    showtimeId: string,
    seatIds: string[],
    reservationId: string,
    seconds: number,
  ): Promise<void>;
}

/**
 * Section 8 of spec.md, verbatim. One definition so the adapter, the tests and
 * the k6 scripts cannot drift apart on what a seat key looks like.
 */
export function seatKey(showtimeId: string, seatId: string): string {
  return `seat:${showtimeId}:${seatId}`;
}
