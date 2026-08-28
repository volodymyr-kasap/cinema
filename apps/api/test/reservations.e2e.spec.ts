import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, reservationSchema } from '@cinema/contracts';
import { sql } from 'drizzle-orm';

import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('reservations: taking a hold', () => {
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  // Phase 1's suites only read, so seeding once per file was enough. These
  // write, and a hold left behind changes the next test's answer.
  beforeEach(async () => {
    await truncateReservations(h.db);
  });

  it('creates a pending hold priced from the showtime and the seat category', async () => {
    const response = await h.hold(h.seatIds.slice(0, 2));

    expect(response.statusCode).toBe(201);
    const reservation = reservationSchema.parse(response.json());
    expect(reservation.status).toBe('PENDING');
    expect(reservation.seats).toHaveLength(2);
    expect(reservation.totalPriceCents).toBe(
      reservation.seats.reduce((sum, seat) => sum + seat.priceCents, 0),
    );
    expect(reservation.seats[0]?.rowLabel).toEqual(expect.any(String));
    expect(new Date(reservation.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a seat already held, naming it in the problem document', async () => {
    await h.hold(h.seatIds.slice(0, 1));

    const response = await h.hold(h.seatIds.slice(0, 1));

    expect(response.statusCode).toBe(409);
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.type).toMatch(/seats-unavailable$/);
    expect(problem.seatIds).toEqual([h.seatIds[0]]);
  });

  // All-or-nothing: a partial hold would leave the user with seats they never
  // chose and no screen able to explain it.
  it('holds nothing when one seat of several is taken', async () => {
    await h.hold([h.seatIds[2]!]);

    const response = await h.hold([h.seatIds[3]!, h.seatIds[2]!, h.seatIds[4]!]);

    expect(response.statusCode).toBe(409);
    const remaining = await h.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM reservation_seats WHERE released_at IS NULL`,
    );
    expect(remaining.rows[0]?.n).toBe('1');
  });

  it('releases an expired hold to the next caller without any sweeper running', async () => {
    const first = await h.holdOne(h.seatIds[5]!);
    await h.db.execute(
      sql`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${first.id}`,
    );

    const response = await h.hold([h.seatIds[5]!]);

    expect(response.statusCode).toBe(201);
    const superseded = await h.db.execute<{ status: string }>(
      sql`SELECT status FROM reservations WHERE id = ${first.id}`,
    );
    expect(superseded.rows[0]?.status).toBe('EXPIRED');
  });

  it('rejects a seat from another hall', async () => {
    const foreign = await h.db.execute<{ id: string }>(sql`
      SELECT se.id FROM seats se
      WHERE se.hall_id <> (SELECT hall_id FROM showtimes WHERE id = ${h.showtimeId})
      LIMIT 1
    `);

    const response = await h.hold([foreign.rows[0]!.id]);

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/seats-not-in-hall$/);
  });

  it('rejects a showtime that has already started', async () => {
    const response = await h.hold([h.pastSeatId], randomUUID(), h.pastShowtimeId);

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/showtime-already-started$/);
  });

  it('requires a session header', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reservations',
      payload: { showtimeId: h.showtimeId, seatIds: h.seatIds.slice(0, 1) },
    });

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/missing-session$/);
  });

  it('rejects a repeated seat id before it reaches the database', async () => {
    const response = await h.hold([h.seatIds[6]!, h.seatIds[6]!]);

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/validation-failed$/);
  });

  it('rejects more than ten seats', async () => {
    const response = await h.hold(h.seatIds.slice(0, 11));

    expect(response.statusCode).toBe(400);
  });

  it('answers 404 for a showtime that does not exist', async () => {
    const response = await h.hold(
      h.seatIds.slice(0, 1),
      randomUUID(),
      '019298a1-7c4e-7c3a-8f21-0000000000ff',
    );

    expect(response.statusCode).toBe(404);
  });
});
