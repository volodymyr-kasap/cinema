import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../src/db/drizzle.module';
import { schema } from '../src/db/schema';
import { seedDatabase } from '../src/db/seed';
import { getTestDatabaseUrl } from './harness';

describe('seedDatabase', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    db = drizzle(pool, { schema }) as Database;
    await seedDatabase(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  const count = async (table: string): Promise<number> => {
    const result = await db.execute<{ n: string }>(
      sql.raw(`SELECT count(*)::text AS n FROM ${table}`),
    );
    return Number(result.rows[0]?.n ?? '0');
  };

  it('creates the fixed catalogue', async () => {
    expect(await count('users')).toBe(3);
    expect(await count('movies')).toBe(10);
    expect(await count('cinemas')).toBe(3);
    expect(await count('halls')).toBe(12);
    expect(await count('seat_categories')).toBe(3);
  });

  it('creates a 1000-seat hall for the load experiment', async () => {
    const result = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM seats s JOIN halls h ON h.id = s.hall_id WHERE h.name = 'Premiere'`,
    );
    expect(Number(result.rows[0]?.n)).toBe(1000);
  });

  it('creates 4 showtimes per hall per day for 14 days', async () => {
    expect(await count('showtimes')).toBe(12 * 14 * 4);
  });

  it('never produces overlapping showtimes in a hall', async () => {
    // The EXCLUDE constraint would have rejected the insert; this asserts the
    // slot layout, not the constraint.
    const result = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM showtimes a JOIN showtimes b
          ON a.hall_id = b.hall_id AND a.id <> b.id
          AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')`,
    );
    expect(Number(result.rows[0]?.n)).toBe(0);
  });

  it('is repeatable — running it twice leaves the same row counts', async () => {
    await seedDatabase(db);
    expect(await count('movies')).toBe(10);
    expect(await count('showtimes')).toBe(12 * 14 * 4);
  });

  it('stores the three pricing categories', async () => {
    const result = await db.execute<{ code: string; surcharge_cents: number }>(
      sql`SELECT code, surcharge_cents FROM seat_categories ORDER BY code`,
    );
    expect(result.rows).toEqual([
      { code: 'RECLINER', surcharge_cents: 15000 },
      { code: 'STANDARD', surcharge_cents: 0 },
      { code: 'VIP', surcharge_cents: 8000 },
    ]);
  });
});
