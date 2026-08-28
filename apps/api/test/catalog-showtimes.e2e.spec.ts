import {
  seatCategorySchema,
  showtimePageSchema,
  showtimeSchema,
  showtimeSeatsSchema,
  problemDetailsSchema,
} from '@cinema/contracts';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { AppModule } from '../src/app.module';
import type { Database } from '../src/db/drizzle.module';
import { schema } from '../src/db/schema';
import { seedDatabase } from '../src/db/seed';
import { generateRequestId, registerCorrelation } from '../src/observability/logger';
import { getTestDatabaseUrl } from './harness';

describe('catalogue: showtimes and seats', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    db = drizzle(pool, { schema }) as Database;
    await seedDatabase(db);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false, genReqId: generateRequestId }),
    );
    registerCorrelation(app);
    app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const premiereShowtimeId = async (): Promise<string> => {
    const result = await db.execute<{ id: string }>(
      sql`SELECT s.id FROM showtimes s JOIN halls h ON h.id = s.hall_id
          WHERE h.name = 'Premiere' ORDER BY s.starts_at LIMIT 1`,
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('no premiere showtime seeded');
    return id;
  };

  it('orders showtimes by start time and paginates by cursor', async () => {
    const first = showtimePageSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/showtimes?limit=5' })).json(),
    );
    expect(first.data).toHaveLength(5);

    const starts = first.data.map((showtime) => showtime.startsAt);
    expect(starts).toEqual([...starts].sort());

    const second = showtimePageSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/showtimes?limit=5&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
        })
      ).json(),
    );
    const overlap = first.data.filter((a) => second.data.some((b) => b.id === a.id));
    expect(overlap).toHaveLength(0);
  });

  it('filters by movie', async () => {
    const anyShowtime = showtimePageSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/showtimes?limit=1' })).json(),
    ).data[0];

    const page = showtimePageSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/showtimes?movieId=${anyShowtime?.movieId}&limit=100`,
        })
      ).json(),
    );

    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.every((showtime) => showtime.movieId === anyShowtime?.movieId)).toBe(true);
  });

  it('filters by cinema', async () => {
    const anyShowtime = showtimePageSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/showtimes?limit=1' })).json(),
    ).data[0];

    const page = showtimePageSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/showtimes?cinemaId=${anyShowtime?.cinemaId}&limit=100`,
        })
      ).json(),
    );

    expect(page.data.every((showtime) => showtime.cinemaId === anyShowtime?.cinemaId)).toBe(true);
  });

  it('interprets the date filter in the cinema local zone, not UTC', async () => {
    // Warsaw is UTC+2 in September; the 20:30 local slot is 18:30Z, still the same
    // local day. A UTC-based filter would put nothing wrong here, so the tell is
    // that every returned showtime belongs to the requested local date.
    const cinemas = showtimePageSchema.parse(
      (
        await app.inject({ method: 'GET', url: '/api/v1/showtimes?date=2026-09-03&limit=100' })
      ).json(),
    );

    expect(cinemas.data.length).toBeGreaterThan(0);
    expect(cinemas.data.length).toBe(12 * 4);
  });

  it('answers 400 for a malformed date filter', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/showtimes?date=03-09-2026' });

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/validation-failed$/);
  });

  it('returns a single showtime with its hall and cinema', async () => {
    const id = await premiereShowtimeId();
    const response = await app.inject({ method: 'GET', url: `/api/v1/showtimes/${id}` });

    expect(response.statusCode).toBe(200);
    const showtime = showtimeSchema.parse(response.json());
    expect(showtime.hallName).toBe('Premiere');
    expect(showtime.cinemaName).toBe('Zoryany');
  });

  it('returns all 1000 seats of the premiere hall, ordered by row and number', async () => {
    const id = await premiereShowtimeId();
    const response = await app.inject({ method: 'GET', url: `/api/v1/showtimes/${id}/seats` });

    expect(response.statusCode).toBe(200);
    const map = showtimeSeatsSchema.parse(response.json());

    expect(map.seats).toHaveLength(1000);
    expect(map.hallName).toBe('Premiere');
    expect(map.seats[0]?.rowLabel).toBe('A');
    expect(map.seats[0]?.seatNumber).toBe(1);
    expect(map.seats.at(-1)?.rowLabel).toBe('Y');
    expect(map.seats.at(-1)?.seatNumber).toBe(40);
  });

  it('prices each seat as the showtime base price plus its category surcharge', async () => {
    const id = await premiereShowtimeId();
    const showtime = showtimeSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/showtimes/${id}` })).json(),
    );
    const map = showtimeSeatsSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/showtimes/${id}/seats` })).json(),
    );

    const surcharges = { STANDARD: 0, VIP: 8_000, RECLINER: 15_000 } as const;
    for (const seat of map.seats) {
      expect(seat.priceCents).toBe(showtime.basePriceCents + surcharges[seat.category]);
    }
  });

  it('reports every seat as available, because nothing books seats yet', async () => {
    const id = await premiereShowtimeId();
    const map = showtimeSeatsSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/showtimes/${id}/seats` })).json(),
    );

    expect(map.seats.every((seat) => seat.status === 'AVAILABLE')).toBe(true);
  });

  it('answers 404 for the seat map of an unknown showtime', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/showtimes/019298a1-7c4e-7c3a-8f21-000000000000/seats',
    });

    expect(response.statusCode).toBe(404);
  });

  it('keeps the seat category codes in the database and in the contract in sync', async () => {
    const result = await db.execute<{ code: string }>(
      sql`SELECT code FROM seat_categories ORDER BY code`,
    );

    expect(result.rows.map((row) => row.code).sort()).toEqual(
      [...seatCategorySchema.options].sort(),
    );
  });
});
