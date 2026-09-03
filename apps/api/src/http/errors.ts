/**
 * Base class for failures the client is allowed to see. The HTTP status and the
 * Problem Details `type` live on the error, not in the controller, so a new
 * failure mode cannot be introduced without deciding how it is reported.
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  /** Slug appended to PUBLIC_ERROR_BASE_URL to form the Problem Details `type`. */
  abstract readonly typeSlug: string;
  abstract readonly title: string;

  constructor(detail: string) {
    super(detail);
    this.name = new.target.name;
  }

  /**
   * RFC 9457 extension members merged into the problem document. Machine-
   * readable detail belongs here rather than parsed out of `detail`, which is
   * prose meant for a human.
   */
  get extensions(): Record<string, unknown> | undefined {
    return undefined;
  }
}

export class ResourceNotFoundError extends DomainError {
  readonly status = 404;
  readonly typeSlug = 'not-found';
  readonly title = 'Resource not found';

  constructor(resource: string, id: string) {
    super(`${resource} ${id} does not exist`);
  }
}

export class ValidationFailedError extends DomainError {
  readonly status = 400;
  readonly typeSlug = 'validation-failed';
  readonly title = 'Request validation failed';
}

export class InvalidCursorError extends DomainError {
  readonly status = 400;
  readonly typeSlug = 'invalid-cursor';
  readonly title = 'Invalid pagination cursor';

  constructor() {
    super('The supplied cursor is not a cursor this endpoint issued');
  }
}

export class MissingSessionError extends DomainError {
  readonly status = 400;
  readonly typeSlug = 'missing-session';
  readonly title = 'Session required';

  constructor() {
    super('This endpoint requires an X-Session-Id header carrying a UUID');
  }
}

export class SeatsNotInHallError extends DomainError {
  readonly status = 400;
  readonly typeSlug = 'seats-not-in-hall';
  readonly title = 'Seats do not belong to this showtime';

  constructor(seatIds: string[]) {
    super(`Seats ${seatIds.join(', ')} are not in the hall this showtime plays in`);
  }
}

export class ShowtimeAlreadyStartedError extends DomainError {
  readonly status = 409;
  readonly typeSlug = 'showtime-already-started';
  readonly title = 'Showtime already started';

  constructor(showtimeId: string) {
    super(`Showtime ${showtimeId} has already started and can no longer be booked`);
  }
}

export class ReservationExpiredError extends DomainError {
  readonly status = 409;
  readonly typeSlug = 'reservation-expired';
  readonly title = 'Reservation expired';

  constructor(reservationId: string) {
    super(`Reservation ${reservationId} expired before it was confirmed`);
  }
}

export class InvalidStateTransitionError extends DomainError {
  readonly status = 409;
  readonly typeSlug = 'invalid-state-transition';
  readonly title = 'Invalid reservation state transition';

  constructor(from: string, to: string) {
    super(`A reservation in state ${from} cannot become ${to}`);
  }
}

/**
 * The lost race. Carries the seat ids as an extension member so the seat map can
 * highlight exactly the seats that were taken rather than re-fetching and
 * guessing at the difference.
 */
export class SeatsUnavailableError extends DomainError {
  readonly status = 409;
  readonly typeSlug = 'seats-unavailable';
  readonly title = 'Seats unavailable';

  constructor(private readonly lost: { seatId: string; label: string }[]) {
    super(`Seats ${lost.map((seat) => seat.label).join(', ')} were taken by another reservation`);
  }

  override get extensions(): Record<string, unknown> {
    return { seatIds: this.lost.map((seat) => seat.seatId) };
  }
}

/**
 * The broker would not take the payment message, so the transaction that would
 * have started the payment was rolled back. The hold is untouched and still
 * PENDING, which is why this is a 503 the caller may retry rather than a 500.
 */
export class PaymentUnavailableError extends DomainError {
  readonly status = 503;
  readonly typeSlug = 'payment-unavailable';
  readonly title = 'Payment cannot be started right now';

  constructor(reservationId: string) {
    super(`Payment for reservation ${reservationId} could not be started; the hold is unchanged`);
  }
}

/**
 * Cancelling a reservation whose money may already be moving. Distinct from
 * InvalidStateTransitionError, which would also be a 409 here: this one names
 * the actual reason, and a client can act on it (wait, then re-read).
 */
export class PaymentInFlightError extends DomainError {
  readonly status = 409;
  readonly typeSlug = 'payment-in-flight';
  readonly title = 'Payment in flight';

  constructor(reservationId: string) {
    super(`Reservation ${reservationId} is being paid for and cannot be changed until it settles`);
  }
}
