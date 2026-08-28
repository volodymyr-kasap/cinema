import { sql } from 'drizzle-orm';

import type { Database } from '../src/db/drizzle.module';

/**
 * Phase 1's suites only read, so re-seeding once per file was enough isolation.
 * Phase 2's suites write, and a hold left behind by one test silently changes
 * the answer of the next. The catalogue is deliberately untouched: it is seeded
 * once and only ever read.
 */
export async function truncateReservations(db: Database): Promise<void> {
  await db.execute(sql`TRUNCATE reservation_seats, reservations CASCADE`);
}
