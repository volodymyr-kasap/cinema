import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { SeatGeometryCache } from '../src/catalog/seat-geometry.cache';
import type { Database } from '../src/db/drizzle.module';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';

/** Counts how many statements the cache actually issues. */
function countingDb(db: Database, counter: { selects: number }): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'select') counter.selects += 1;
      const value = Reflect.get(target, property, receiver) as unknown;
      // Bound, because drizzle's builders are methods that need their receiver.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('SeatGeometryCache', () => {
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('labels seats the way the seat map does', async () => {
    const cache = new SeatGeometryCache(h.db);

    const [first] = await cache.labels(h.showtimeId, [h.seatIds[0]!]);

    const expected = await h.db.execute<{ label: string }>(
      sql`SELECT row_label || seat_number AS label FROM seats WHERE id = ${h.seatIds[0]!}`,
    );
    expect(first).toEqual({ seatId: h.seatIds[0]!, label: expected.rows[0]!.label });
  });

  // The point of the class. Nine thousand losers must not cost nine thousand
  // SELECTs -- that is the load Redis was added to remove, moved rather than
  // removed (spec §5).
  it('queries twice for a cold showtime and never again', async () => {
    const counter = { selects: 0 };
    const cache = new SeatGeometryCache(countingDb(h.db, counter));

    await cache.labels(h.showtimeId, [h.seatIds[0]!]);
    const afterFirst = counter.selects;
    await cache.labels(h.showtimeId, h.seatIds);

    expect(afterFirst).toBe(2);
    expect(counter.selects).toBe(2);
  });

  it('collapses a thousand concurrent cold lookups into the same two queries', async () => {
    const counter = { selects: 0 };
    const cache = new SeatGeometryCache(countingDb(h.db, counter));

    await Promise.all(
      Array.from({ length: 1_000 }, () => cache.labels(h.showtimeId, [h.seatIds[1]!])),
    );

    expect(counter.selects).toBe(2);
  });

  it('reports an unknown showtime rather than caching the absence', async () => {
    const cache = new SeatGeometryCache(h.db);

    await expect(cache.labels(randomUUID(), [h.seatIds[0]!])).rejects.toThrow(/does not exist/);
  });

  // Falling back to the id keeps a 409 honest instead of throwing while building
  // the error that explains the 409.
  it('falls back to the seat id for a seat outside the hall', async () => {
    const cache = new SeatGeometryCache(h.db);
    const stranger = randomUUID();

    await expect(cache.labels(h.showtimeId, [stranger])).resolves.toEqual([
      { seatId: stranger, label: stranger },
    ]);
  });
});
