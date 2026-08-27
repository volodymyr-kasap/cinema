import type { Booking, BookingStore, HoldInput } from './domain.js';

/**
 * Booking use cases. Thin by design: the atomicity that makes seat booking
 * correct lives in the store, so the service only orchestrates.
 */
export class BookingService {
  constructor(private readonly store: BookingStore) {}

  hold(input: HoldInput): Promise<Booking> {
    return this.store.hold(input);
  }

  listBookings(movieId: string): Promise<Booking[]> {
    return this.store.listBookings(movieId);
  }

  confirmSeat(sessionId: string, userId: string): Promise<Booking> {
    return this.store.confirm(sessionId, userId);
  }

  releaseSeat(sessionId: string, userId: string): Promise<void> {
    return this.store.release(sessionId, userId);
  }
}
