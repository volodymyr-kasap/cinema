import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '../src/db/drizzle.module';

/**
 * Phase 1's suites only read, so re-seeding once per file was enough isolation.
 * Phase 2's suites write, and a hold left behind by one test silently changes
 * the answer of the next. The catalogue is deliberately untouched: it is seeded
 * once and only ever read.
 *
 * A leftover key is worse than a leftover row, because nothing in the database
 * shows it: the next test sees a seat that is free everywhere except in Redis.
 */
export async function truncateReservations(db: Database, redis?: Redis | null): Promise<void> {
  await db.execute(sql`TRUNCATE payments, reservation_seats, reservations CASCADE`);
  if (redis) await redis.flushall();
}
