import { randomUUID } from 'node:crypto';

import { LuaScript, type RedisClient } from '../adapters/redis.js';
import {
  type Booking,
  type BookingStatus,
  type BookingStore,
  type HoldInput,
  SeatAlreadyBookedError,
  SessionForbiddenError,
  SessionNotFoundError,
} from './domain.js';

/** Wire shape of a booking as stored in Redis. */
interface StoredBooking {
  id: string;
  movieId: string;
  seatId: string;
  userId: string;
  status: BookingStatus;
}

const OUTCOME_NOT_FOUND = 0;
const OUTCOME_FORBIDDEN = 1;

/**
 * Claims a seat for a session, if and only if nobody holds it.
 *
 * SET NX is the whole concurrency story: the seat key is the lock, and the
 * TTL is what releases it when a user walks away mid-checkout.
 */
const holdScript = new LuaScript<number>(`
  if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
    redis.call('SET', KEYS[2], KEYS[1], 'PX', ARGV[2])
    return 1
  end
  return 0
`);

/**
 * Turns a held seat into a permanent booking.
 *
 * A plain SET (no TTL argument) clears the existing expiry, so the seat key
 * outlives the hold window.
 */
const confirmScript = new LuaScript<[number] | [number, string]>(`
  local seatKey = redis.call('GET', KEYS[1])
  if not seatKey then return {${OUTCOME_NOT_FOUND}} end

  local raw = redis.call('GET', seatKey)
  if not raw then return {${OUTCOME_NOT_FOUND}} end

  local booking = cjson.decode(raw)
  if booking.userId ~= ARGV[1] then return {${OUTCOME_FORBIDDEN}} end

  booking.status = 'confirmed'
  local updated = cjson.encode(booking)

  redis.call('SET', seatKey, updated)
  redis.call('PERSIST', KEYS[1])

  return {2, updated}
`);

/** Drops the hold (or the confirmed booking) owned by this session. */
const releaseScript = new LuaScript<number>(`
  local seatKey = redis.call('GET', KEYS[1])
  if not seatKey then return ${OUTCOME_NOT_FOUND} end

  local raw = redis.call('GET', seatKey)
  if raw then
    local booking = cjson.decode(raw)
    if booking.userId ~= ARGV[1] then return ${OUTCOME_FORBIDDEN} end
  end

  redis.call('DEL', seatKey, KEYS[1])
  return 2
`);

/**
 * Session-based seat booking backed by Redis.
 *
 * Key design:
 *
 *   seat:{movieId}:{seatId}  -> booking JSON (TTL = held, no TTL = confirmed)
 *   session:{sessionId}      -> seat key     (reverse lookup)
 */
export class RedisBookingStore implements BookingStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly holdTtlMs: number,
  ) {}

  async hold({ movieId, seatId, userId }: HoldInput): Promise<Booking> {
    const id = randomUUID();
    const stored: StoredBooking = { id, movieId, seatId, userId, status: 'held' };

    const claimed = await holdScript.run(
      this.redis,
      [seatKey(movieId, seatId), sessionKey(id)],
      [JSON.stringify(stored), String(this.holdTtlMs)],
    );

    if (!claimed) {
      throw new SeatAlreadyBookedError();
    }

    return { ...stored, expiresAt: new Date(Date.now() + this.holdTtlMs) };
  }

  /**
   * Every seat key under a movie, held or confirmed.
   *
   * SCAN keeps this non-blocking; values are fetched in one MGET per page
   * rather than a round trip per key.
   */
  async listBookings(movieId: string): Promise<Booking[]> {
    const bookings: Booking[] = [];
    let cursor = '0';

    do {
      const page = await this.redis.scan(cursor, {
        MATCH: seatKey(movieId, '*'),
        COUNT: 100,
      });
      cursor = page.cursor;

      if (page.keys.length === 0) continue;

      const values = await this.redis.mGet(page.keys);
      for (const value of values) {
        const booking = parseBooking(value);
        // Keys can expire between the SCAN and the MGET; skip those.
        if (booking) bookings.push(booking);
      }
    } while (cursor !== '0');

    return bookings;
  }

  async confirm(sessionId: string, userId: string): Promise<Booking> {
    const [outcome, updated] = await confirmScript.run(
      this.redis,
      [sessionKey(sessionId)],
      [userId],
    );

    if (outcome === OUTCOME_NOT_FOUND) throw new SessionNotFoundError();
    if (outcome === OUTCOME_FORBIDDEN) throw new SessionForbiddenError();

    const booking = parseBooking(updated ?? null);
    if (!booking) throw new SessionNotFoundError();

    return booking;
  }

  async release(sessionId: string, userId: string): Promise<void> {
    const outcome = await releaseScript.run(this.redis, [sessionKey(sessionId)], [userId]);

    if (outcome === OUTCOME_NOT_FOUND) throw new SessionNotFoundError();
    if (outcome === OUTCOME_FORBIDDEN) throw new SessionForbiddenError();
  }

  async close(): Promise<void> {
    await this.redis.close();
  }
}

function seatKey(movieId: string, seatId: string): string {
  return `seat:${movieId}:${seatId}`;
}

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function parseBooking(value: string | null): Booking | null {
  if (value === null) return null;

  try {
    const stored = JSON.parse(value) as StoredBooking;
    return { ...stored, expiresAt: null };
  } catch {
    return null;
  }
}
