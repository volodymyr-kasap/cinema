import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';

import { getTestDatabaseUrl } from './harness';

/**
 * Every fixture row is inserted with RETURNING id and referenced explicitly.
 * Selecting `FROM movies m, halls h LIMIT 1` instead would silently pick up
 * whatever the seed suite left behind, making these results depend on file order.
 */
async function insertReturningId(client: PoolClient, text: string, values: unknown[] = []) {
  const result = await client.query<{ id: string }>(text, values);
  const row = result.rows[0];
  if (!row) throw new Error(`insert returned no id: ${text}`);
  return row.id;
}

async function seedHallAndMovie(client: PoolClient) {
  const movieId = await insertReturningId(
    client,
    `INSERT INTO movies (id, title, description, duration_minutes, poster_url, release_date, rating)
     VALUES (uuidv7(), 'Test', 'd', 120, 'https://x/y.jpg', '2026-01-01', 7.5) RETURNING id`,
  );
  const cinemaId = await insertReturningId(
    client,
    `INSERT INTO cinemas (id, name, city, address, timezone)
     VALUES (uuidv7(), 'C', 'Kyiv', 'a', 'Europe/Kyiv') RETURNING id`,
  );
  const hallId = await insertReturningId(
    client,
    `INSERT INTO halls (id, cinema_id, name) VALUES (uuidv7(), $1, 'H1') RETURNING id`,
    [cinemaId],
  );

  const insertShowtime = (start: string, end: string) =>
    client.query(
      `INSERT INTO showtimes (id, movie_id, hall_id, starts_at, ends_at, base_price_cents, language, format)
       VALUES (uuidv7(), $1, $2, $3::timestamptz, $4::timestamptz, 15000, 'uk', 'TWO_D')`,
      [movieId, hallId, start, end],
    );

  return { insertShowtime };
}

describe('database schema', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    db = drizzle(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates every catalogue table', async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = result.rows.map((row) => row.table_name);

    for (const table of [
      'users',
      'movies',
      'cinemas',
      'halls',
      'seat_categories',
      'seats',
      'showtimes',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('refuses two showtimes that overlap in the same hall', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { insertShowtime } = await seedHallAndMovie(client);

      await insertShowtime('2026-09-01T10:00:00Z', '2026-09-01T12:30:00Z');

      await expect(insertShowtime('2026-09-01T12:00:00Z', '2026-09-01T14:00:00Z')).rejects.toThrow(
        /showtimes_no_overlap/,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('allows back-to-back showtimes in the same hall', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { insertShowtime } = await seedHallAndMovie(client);

      await insertShowtime('2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z');
      await expect(
        insertShowtime('2026-09-01T12:00:00Z', '2026-09-01T14:00:00Z'),
      ).resolves.toBeDefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  describe('the no-double-booking invariant', () => {
    // Committed fixture rows, not a `LIMIT 1` over whatever the seed suite left
    // behind: these tests span several statements on the pool, so they cannot
    // live inside a rolled-back transaction, and this file must still pass when
    // it is the only suite jest runs.
    let showtimeId: string;
    let seatId: string;

    beforeAll(async () => {
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO seat_categories (code, label, surcharge_cents)
           VALUES ('STANDARD', 'Standard', 0) ON CONFLICT (code) DO NOTHING`,
        );
        const movieId = await insertReturningId(
          client,
          `INSERT INTO movies (id, title, description, duration_minutes, poster_url, release_date, rating)
           VALUES (uuidv7(), 'Invariant', 'd', 120, 'https://x/y.jpg', '2026-01-01', 7.5) RETURNING id`,
        );
        const cinemaId = await insertReturningId(
          client,
          `INSERT INTO cinemas (id, name, city, address, timezone)
           VALUES (uuidv7(), 'Invariant', 'Kyiv', 'a', 'Europe/Kyiv') RETURNING id`,
        );
        const hallId = await insertReturningId(
          client,
          `INSERT INTO halls (id, cinema_id, name) VALUES (uuidv7(), $1, 'Invariant') RETURNING id`,
          [cinemaId],
        );
        seatId = await insertReturningId(
          client,
          `INSERT INTO seats (id, hall_id, row_label, seat_number, category_code)
           VALUES (uuidv7(), $1, 'A', 1, 'STANDARD') RETURNING id`,
          [hallId],
        );
        showtimeId = await insertReturningId(
          client,
          `INSERT INTO showtimes (id, movie_id, hall_id, starts_at, ends_at, base_price_cents, language, format)
           VALUES (uuidv7(), $1, $2, '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z', 15000, 'uk', 'TWO_D')
           RETURNING id`,
          [movieId, hallId],
        );
      } finally {
        client.release();
      }
    });

    it('has a unique index over active seat rows only', async () => {
      const result = await db.execute<{ indexdef: string }>(
        sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'reservation_seats_active_uq'`,
      );

      expect(result.rows[0]?.indexdef).toMatch(/UNIQUE/);
      expect(result.rows[0]?.indexdef).toMatch(/released_at IS NULL/);
    });

    it('refuses a second active row for the same seat and showtime', async () => {
      const first = await insertReservation('PENDING');
      const second = await insertReservation('PENDING');

      await takeSeat(first);

      await expect(takeSeat(second)).rejects.toThrow(/reservation_seats_active_uq/);
    });

    it('lets a released seat be taken again', async () => {
      const first = await insertReservation('PENDING');
      const second = await insertReservation('PENDING');

      await pool.query(
        `INSERT INTO reservation_seats (reservation_id, seat_id, showtime_id, price_cents, released_at)
         VALUES ($1, $2, $3, 1000, now())`,
        [first, seatId, showtimeId],
      );

      await expect(takeSeat(second)).resolves.toBeDefined();
    });

    it('rejects a status the state machine does not define', async () => {
      await expect(insertReservation('PAID')).rejects.toThrow(/reservations_status_check/);
    });

    it('refuses a second payment for the same reservation', async () => {
      const reservationId = await insertReservation('PENDING');

      await pool.query(
        `INSERT INTO payments (reservation_id, status, amount_cents) VALUES ($1, 'PENDING', 4500)`,
        [reservationId],
      );

      // The application never tries this -- the row lock stops it long before.
      // The index exists so that a bug in that lock is a constraint violation
      // rather than a second charge.
      await expect(
        pool.query(
          `INSERT INTO payments (reservation_id, status, amount_cents) VALUES ($1, 'PENDING', 4500)`,
          [reservationId],
        ),
      ).rejects.toThrow(/unique|duplicate key/i);
    });

    it('refuses a payment status outside the four', async () => {
      const reservationId = await insertReservation('PENDING');
      await expect(
        pool.query(
          `INSERT INTO payments (reservation_id, status, amount_cents) VALUES ($1, 'REFUNDED', 4500)`,
          [reservationId],
        ),
      ).rejects.toThrow(/payments_status_check/);
    });

    it('accepts the two new reservation statuses', async () => {
      const reservationId = await insertReservation('PENDING');
      await expect(
        pool.query(`UPDATE reservations SET status = 'PAYMENT_PENDING' WHERE id = $1`, [
          reservationId,
        ]),
      ).resolves.toBeDefined();
      await expect(
        pool.query(`UPDATE reservations SET status = 'PAYMENT_FAILED' WHERE id = $1`, [
          reservationId,
        ]),
      ).resolves.toBeDefined();
    });

    /**
     * Raw pg, not `db.execute`: drizzle wraps a failed query in an error whose
     * message is only "Failed query", losing the constraint name that is the
     * whole point of these assertions. The overlap tests above use the raw
     * client for the same reason.
     */
    function takeSeat(reservationId: string) {
      return pool.query(
        `INSERT INTO reservation_seats (reservation_id, seat_id, showtime_id, price_cents)
         VALUES ($1, $2, $3, 1000)`,
        [reservationId, seatId, showtimeId],
      );
    }

    async function insertReservation(status: string): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO reservations (showtime_id, session_id, status, total_price_cents, expires_at)
         VALUES ($1, gen_random_uuid(), $2, 1000, now() + interval '10 minutes')
         RETURNING id`,
        [showtimeId, status],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('reservation insert returned no id');
      return id;
    }

    afterEach(async () => {
      await db.execute(sql`TRUNCATE payments, reservations, reservation_seats CASCADE`);
    });
  });
});
