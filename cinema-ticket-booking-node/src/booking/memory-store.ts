import { randomUUID } from 'node:crypto';

import {
  type Booking,
  type BookingStore,
  type HoldInput,
  SeatAlreadyBookedError,
  SessionForbiddenError,
  SessionNotFoundError,
} from './domain.js';

interface Entry {
  booking: Booking;
  /** Epoch ms after which the hold has lapsed; `null` once confirmed. */
  expiresAt: number | null;
}

/**
 * In-process store, for tests and for running without Redis.
 *
 * The Go version needed a mutex here; Node does not. Nothing awaits between
 * the existence check and the write, so the event loop cannot interleave two
 * holds of the same seat. Expiry is lazy: entries are treated as gone once
 * their deadline passes, and swept when next touched.
 */
export class MemoryBookingStore implements BookingStore {
  private readonly seats = new Map<string, Entry>();
  private readonly sessions = new Map<string, string>();

  constructor(private readonly holdTtlMs: number) {}

  async hold({ movieId, seatId, userId }: HoldInput): Promise<Booking> {
    const key = seatKey(movieId, seatId);

    if (this.liveEntry(key)) {
      throw new SeatAlreadyBookedError();
    }

    const expiresAt = Date.now() + this.holdTtlMs;
    const booking: Booking = {
      id: randomUUID(),
      movieId,
      seatId,
      userId,
      status: 'held',
      expiresAt: new Date(expiresAt),
    };

    this.seats.set(key, { booking, expiresAt });
    this.sessions.set(booking.id, key);

    return booking;
  }

  async listBookings(movieId: string): Promise<Booking[]> {
    const prefix = seatKey(movieId, '');

    return [...this.seats.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => this.liveEntry(key)?.booking)
      .filter((booking): booking is Booking => booking !== undefined);
  }

  async confirm(sessionId: string, userId: string): Promise<Booking> {
    const entry = this.ownedEntry(sessionId, userId);

    entry.expiresAt = null;
    entry.booking = { ...entry.booking, status: 'confirmed', expiresAt: null };

    return entry.booking;
  }

  async release(sessionId: string, userId: string): Promise<void> {
    this.ownedEntry(sessionId, userId);

    const key = this.sessions.get(sessionId);
    if (key !== undefined) this.seats.delete(key);
    this.sessions.delete(sessionId);
  }

  async close(): Promise<void> {
    this.seats.clear();
    this.sessions.clear();
  }

  /** Resolves a session to its entry, rejecting unknown, lapsed, or foreign ones. */
  private ownedEntry(sessionId: string, userId: string): Entry {
    const key = this.sessions.get(sessionId);
    if (key === undefined) throw new SessionNotFoundError();

    const entry = this.liveEntry(key);
    if (!entry) {
      this.sessions.delete(sessionId);
      throw new SessionNotFoundError();
    }

    if (entry.booking.userId !== userId) throw new SessionForbiddenError();

    return entry;
  }

  private liveEntry(key: string): Entry | undefined {
    const entry = this.seats.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.seats.delete(key);
      this.sessions.delete(entry.booking.id);
      return undefined;
    }

    return entry;
  }
}

function seatKey(movieId: string, seatId: string): string {
  return `seat:${movieId}:${seatId}`;
}
