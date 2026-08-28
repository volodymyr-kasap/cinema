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
});
