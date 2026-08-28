import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, reservationPageSchema, reservationSchema } from '@cinema/contracts';
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

describe('reservations: lifecycle and ownership', () => {
  const session = randomUUID();
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db);
  });

  const holdOne = (seat: string, owner = session) => h.holdOne(seat, owner);
  const act = (method: 'GET' | 'DELETE' | 'POST', path: string, owner = session) =>
    h.act(method, path, owner);

  it('reads back a hold with its seats', async () => {
    const created = await holdOne(h.seatIds[0]!);

    const response = await act('GET', `/${created.id}`);

    expect(response.statusCode).toBe(200);
    expect(reservationSchema.parse(response.json()).id).toBe(created.id);
  });

  it('lists only this session, newest first', async () => {
    await holdOne(h.seatIds[0]!);
    await holdOne(h.seatIds[1]!);
    await holdOne(h.seatIds[2]!, randomUUID());

    const page = reservationPageSchema.parse((await act('GET', '')).json());

    expect(page.data).toHaveLength(2);
    expect(new Date(page.data[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(page.data[1]!.createdAt).getTime(),
    );
  });

  it('confirms a pending hold', async () => {
    const created = await holdOne(h.seatIds[3]!);

    const response = await act('POST', `/${created.id}/confirm`);

    expect(response.statusCode).toBe(200);
    expect(reservationSchema.parse(response.json()).status).toBe('CONFIRMED');
  });

  it('cancels a pending hold and frees the seat', async () => {
    const created = await holdOne(h.seatIds[4]!);

    expect((await act('DELETE', `/${created.id}`)).statusCode).toBe(204);

    const retaken = await h.hold([h.seatIds[4]!], randomUUID());
    expect(retaken.statusCode).toBe(201);
  });

  // The user asked for the seats to be released and they are released. An error
  // here would report a problem that does not exist.
  it('treats cancelling twice as success', async () => {
    const created = await holdOne(h.seatIds[5]!);
    await act('DELETE', `/${created.id}`);

    expect((await act('DELETE', `/${created.id}`)).statusCode).toBe(204);
  });

  it('refuses to cancel a confirmed reservation', async () => {
    const created = await holdOne(h.seatIds[6]!);
    await act('POST', `/${created.id}/confirm`);

    const response = await act('DELETE', `/${created.id}`);

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/invalid-state-transition$/);
  });

  it('refuses to confirm a hold that expired while the page was open', async () => {
    const created = await holdOne(h.seatIds[7]!);
    await h.db.execute(
      sql`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${created.id}`,
    );

    const response = await act('POST', `/${created.id}/confirm`);

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/reservation-expired$/);

    // Whoever discovers the expiry records it, and the seat is free again.
    const after = await h.db.execute<{ status: string }>(
      sql`SELECT status FROM reservations WHERE id = ${created.id}`,
    );
    expect(after.rows[0]?.status).toBe('EXPIRED');
  });

  it('resolves a confirm racing a cancel to exactly one winner', async () => {
    const created = await holdOne(h.seatIds[8]!);

    const [confirmed, cancelled] = await Promise.all([
      act('POST', `/${created.id}/confirm`),
      act('DELETE', `/${created.id}`),
    ]);

    const codes = [confirmed.statusCode, cancelled.statusCode].sort();
    // Either the confirm lands first (200) and the cancel is refused (409), or
    // the cancel lands first (204) and the confirm is refused (409).
    expect(codes).toEqual(expect.arrayContaining([409]));
    expect(codes.filter((code) => code < 300)).toHaveLength(1);
  });

  // 403 would confirm the id exists. 404 is also simply true from where the
  // caller stands: it is not among their reservations.
  it('hides another session\u2019s reservation behind 404', async () => {
    const created = await holdOne(h.seatIds[9]!, randomUUID());

    expect((await act('GET', `/${created.id}`)).statusCode).toBe(404);
    expect((await act('DELETE', `/${created.id}`)).statusCode).toBe(404);
    expect((await act('POST', `/${created.id}/confirm`)).statusCode).toBe(404);
  });
});
