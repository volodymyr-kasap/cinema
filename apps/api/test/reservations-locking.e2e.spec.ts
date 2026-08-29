import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@cinema/contracts';
import { sql } from 'drizzle-orm';

import { seatKey } from '../src/locking/seat-lock';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('reservations with redis locking', () => {
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness({ lockStrategy: 'redis' });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db, h.redis);
  });

  it('takes a lock keyed on the showtime and seat when a hold succeeds', async () => {
    const reservation = await h.holdOne(h.seatIds[0]!);

    await expect(h.redis!.get(seatKey(h.showtimeId, h.seatIds[0]!))).resolves.toBe(reservation.id);
  });

  it('refuses the second caller and names the seat', async () => {
    await h.holdOne(h.seatIds[1]!);

    const response = await h.hold([h.seatIds[1]!]);

    expect(response.statusCode).toBe(409);
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.type).toMatch(/seats-unavailable$/);
    expect(problem.seatIds).toEqual([h.seatIds[1]!]);
    // The label comes from the in-process geometry cache, not from a query per
    // loser (spec §5). It still has to be the label a user recognises.
    expect(problem.detail).toMatch(/^Seats [A-Z]\d+ were taken/);
  });

  it('leaves no lock behind when the request fails inside the transaction', async () => {
    // A seat from another hall: the lock is taken before the hall is known, so
    // the release in the catch is the only thing that cleans it up.
    const foreign = await h.db.execute<{ id: string }>(sql`
      SELECT se.id FROM seats se
      WHERE se.hall_id <> (SELECT hall_id FROM showtimes WHERE id = ${h.showtimeId})
      LIMIT 1
    `);
    const seat = foreign.rows[0]!.id;

    const response = await h.hold([seat]);

    expect(response.statusCode).toBe(400);
    await expect(h.redis!.exists(seatKey(h.showtimeId, seat))).resolves.toBe(0);
  });

  it('leaves no lock behind when the showtime has already started', async () => {
    const response = await h.hold([h.pastSeatId], randomUUID(), h.pastShowtimeId);

    expect(response.statusCode).toBe(409);
    await expect(h.redis!.exists(seatKey(h.pastShowtimeId, h.pastSeatId))).resolves.toBe(0);
  });

  it('takes none of the seats when one of three is already locked', async () => {
    await h.holdOne(h.seatIds[3]!);

    const response = await h.hold([h.seatIds[2]!, h.seatIds[3]!, h.seatIds[4]!]);

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).seatIds).toEqual([h.seatIds[3]!]);
    await expect(
      h.redis!.exists(seatKey(h.showtimeId, h.seatIds[2]!), seatKey(h.showtimeId, h.seatIds[4]!)),
    ).resolves.toBe(0);
  });

  // Spec §5, the first row of the divergence table: the lock says taken, the
  // database says free. A false rejection, bounded by the TTL, and the price of
  // an advisory lock -- stated here so nobody later calls it a bug.
  it('rejects on a stale key even though the seat is free in the database', async () => {
    await h.redis!.set(seatKey(h.showtimeId, h.seatIds[5]!), randomUUID(), 'EX', 60);

    const response = await h.hold([h.seatIds[5]!]);

    expect(response.statusCode).toBe(409);
    const active = await h.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM reservation_seats WHERE released_at IS NULL`,
    );
    expect(active.rows[0]?.n).toBe('0');
  });

  // The second row, and the important one: the index is still the last word. A
  // flushed Redis costs a wasted transaction, never a double booking.
  it('still refuses a taken seat after the lock is flushed away', async () => {
    await h.holdOne(h.seatIds[6]!);
    await h.redis!.flushall();

    const response = await h.hold([h.seatIds[6]!]);

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/seats-unavailable$/);
  });

  it('lets a lock lapse with its hold, so the seat comes back on its own', async () => {
    const brief = await startReservationHarness({ lockStrategy: 'redis', ttlSeconds: 1 });
    try {
      await truncateReservations(brief.db, brief.redis);
      await brief.holdOne(brief.seatIds[0]!);

      await new Promise((resolve) => setTimeout(resolve, 1_500));

      await expect(brief.redis!.exists(seatKey(brief.showtimeId, brief.seatIds[0]!))).resolves.toBe(
        0,
      );
      const response = await brief.hold([brief.seatIds[0]!]);
      expect(response.statusCode).toBe(201);
    } finally {
      await brief.close();
    }
  });
});

// Correctness never depended on Redis, so losing it costs throughput and
// nothing else (spec §5, ADR 0018).
describe('reservations when redis is unreachable', () => {
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness({
      lockStrategy: 'redis',
      // Port 1 is reserved and never listening.
      redisUrl: 'redis://127.0.0.1:1',
    });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db);
  });

  it('still takes a hold, on the database path', async () => {
    const response = await h.hold([h.seatIds[0]!]);

    expect(response.statusCode).toBe(201);
  });

  it('still refuses a seat that is already held', async () => {
    await h.holdOne(h.seatIds[1]!);

    expect((await h.hold([h.seatIds[1]!])).statusCode).toBe(409);
  });

  it('keeps reporting itself ready: readiness means postgres, not redis', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
  });
});
