import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

/**
 * Section 7 of spec.md, stated as a test:
 *
 *   N users, one seat  ->  successful reservations = 1
 *
 * Run once per locking strategy. The Redis path does not inherit sub-project
 * 2's guarantees, it re-earns them: an advisory lock that changed any of these
 * answers would be a lock that had quietly become authoritative.
 *
 * The pool is raised above the client count on purpose. At the default of ten
 * connections, forty of fifty clients would be queuing for a connection rather
 * than racing for a seat, and the test would pass for the wrong reason
 * (ADR 0015).
 */
describe.each(['db', 'redis'] as const)('reservations under contention (%s)', (lockStrategy) => {
  const CLIENTS = 50;
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness({ lockStrategy, poolMax: CLIENTS + 10 });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db, h.redis);
  });

  const race = (seats: string[], clients: number) =>
    Promise.all(Array.from({ length: clients }, () => h.hold(seats, randomUUID())));

  it('lets exactly one of fifty clients hold the same seat', async () => {
    const responses = await race([h.seatIds[0]!], CLIENTS);

    const created = responses.filter((response) => response.statusCode === 201);
    const conflicted = responses.filter((response) => response.statusCode === 409);

    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(CLIENTS - 1);
    // Nothing else: a 500 here would mean a deadlock or an unmapped constraint
    // violation escaped as an internal error.
    expect(created.length + conflicted.length).toBe(CLIENTS);
  });

  it('leaves exactly one active row in the database', async () => {
    await race([h.seatIds[0]!], CLIENTS);

    const active = await h.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM reservation_seats
      WHERE seat_id = ${h.seatIds[0]!} AND showtime_id = ${h.showtimeId} AND released_at IS NULL
    `);

    expect(active.rows[0]?.n).toBe('1');
  });

  it('leaves no partial holds behind when clients ask for overlapping pairs', async () => {
    // Every client wants the same two seats. A loser must hold neither.
    const responses = await race([h.seatIds[1]!, h.seatIds[2]!], CLIENTS);

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const active = await h.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM reservation_seats WHERE released_at IS NULL`,
    );
    expect(active.rows[0]?.n).toBe('2');
  });

  // Different seats must not serialise against each other. If this is slow or
  // fails, the invariant is locking more than the row it needs to.
  it('lets a thousand clients hold a thousand distinct seats', async () => {
    const premiere = await h.db.execute<{ showtime_id: string }>(sql`
      SELECT sh.id AS showtime_id FROM showtimes sh
      JOIN halls h ON h.id = sh.hall_id
      WHERE (SELECT count(*) FROM seats WHERE hall_id = h.id) = 1000
        AND sh.starts_at > now() + interval '1 day'
      ORDER BY sh.starts_at LIMIT 1
    `);
    const target = premiere.rows[0]!.showtime_id;

    const all = await h.db.execute<{ id: string }>(sql`
      SELECT se.id FROM seats se
      JOIN showtimes sh ON sh.hall_id = se.hall_id
      WHERE sh.id = ${target}
    `);
    expect(all.rows).toHaveLength(1000);

    const responses = await Promise.all(
      all.rows.map((seat) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/reservations',
          headers: { 'x-session-id': randomUUID() },
          payload: { showtimeId: target, seatIds: [seat.id] },
        }),
      ),
    );

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1000);
    expect(responses.filter((r) => r.statusCode !== 201)).toHaveLength(0);
  }, 120_000);

  // Ten clients per seat over a thousand seats: the shape of the section 25
  // experiment, in miniature and in-process, so a regression is caught here
  // rather than three tasks later in a two-minute k6 run.
  it('sells a thousand seats exactly once each when ten clients want each of them', async () => {
    const premiere = await h.db.execute<{ showtime_id: string }>(sql`
      SELECT sh.id AS showtime_id FROM showtimes sh
      JOIN halls h ON h.id = sh.hall_id
      WHERE (SELECT count(*) FROM seats WHERE hall_id = h.id) = 1000
        AND sh.starts_at > now() + interval '1 day'
      ORDER BY sh.starts_at LIMIT 1
    `);
    const target = premiere.rows[0]!.showtime_id;
    const all = await h.db.execute<{ id: string }>(
      sql`SELECT se.id FROM seats se JOIN showtimes sh ON sh.hall_id = se.hall_id WHERE sh.id = ${target}`,
    );

    const attempts = all.rows.flatMap((seat) =>
      Array.from({ length: 10 }, () =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/reservations',
          headers: { 'x-session-id': randomUUID() },
          payload: { showtimeId: target, seatIds: [seat.id] },
        }),
      ),
    );
    const responses = await Promise.all(attempts);

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1000);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(9000);
    expect(responses.filter((r) => r.statusCode >= 500)).toHaveLength(0);

    const duplicates = await h.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM (
        SELECT showtime_id, seat_id FROM reservation_seats WHERE released_at IS NULL
        GROUP BY showtime_id, seat_id HAVING count(*) > 1
      ) d
    `);
    expect(duplicates.rows[0]?.n).toBe('0');
  }, 300_000);
});
