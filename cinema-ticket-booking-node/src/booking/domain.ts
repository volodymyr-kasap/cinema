/** A seat reservation, either temporarily held or permanently confirmed. */
export interface Booking {
  id: string;
  movieId: string;
  seatId: string;
  userId: string;
  status: BookingStatus;
  /** When the hold lapses. `null` once confirmed — confirmed bookings never expire. */
  expiresAt: Date | null;
}

export type BookingStatus = 'held' | 'confirmed';

export interface HoldInput {
  movieId: string;
  seatId: string;
  userId: string;
}

/**
 * Storage contract for seat bookings.
 *
 * Implementations must make `hold` atomic: when N callers race for the same
 * seat, exactly one of them may win.
 */
export interface BookingStore {
  hold(input: HoldInput): Promise<Booking>;
  listBookings(movieId: string): Promise<Booking[]>;
  confirm(sessionId: string, userId: string): Promise<Booking>;
  release(sessionId: string, userId: string): Promise<void>;
  close(): Promise<void>;
}

/** Domain error carrying the HTTP status the API should answer with. */
export class BookingError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class SeatAlreadyBookedError extends BookingError {
  constructor() {
    super('seat is already taken', 409);
  }
}

/** The session id is unknown, or its hold already expired. */
export class SessionNotFoundError extends BookingError {
  constructor() {
    super('session not found or expired', 404);
  }
}

/** The session exists but belongs to a different user. */
export class SessionForbiddenError extends BookingError {
  constructor() {
    super('session belongs to another user', 403);
  }
}
