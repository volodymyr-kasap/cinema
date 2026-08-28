import { randomUUID } from 'node:crypto';

import { reservationSchema, type Reservation } from '@cinema/contracts';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { InjectOptions, Response as LightMyRequestResponse } from 'light-my-request';
import { Pool } from 'pg';

import { AppModule } from '../src/app.module';
import { ConfigService } from '../src/config/config.service';
import type { Database } from '../src/db/drizzle.module';
import { schema } from '../src/db/schema';
import { seedDatabase } from '../src/db/seed';
import { ProblemDetailsFilter } from '../src/http/problem-details.filter';
import { generateRequestId, registerCorrelation } from '../src/observability/logger';
import { getTestDatabaseUrl } from './harness';

export interface ReservationHarness {
  app: NestFastifyApplication;
  db: Database;
  /** A showtime far enough ahead that it cannot start mid-suite. */
  showtimeId: string;
  /** Twenty seats of that showtime's hall, ordered by row then number. */
  seatIds: string[];
  hold(seats: string[], session?: string, showtime?: string): Promise<LightMyRequestResponse>;
  holdOne(seat: string, session?: string): Promise<Reservation>;
  act(
    method: InjectOptions['method'],
    path: string,
    session: string,
  ): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function startReservationHarness(): Promise<ReservationHarness> {
  const pool = new Pool({ connectionString: getTestDatabaseUrl() });
  const db = drizzle(pool, { schema }) as Database;
  await seedDatabase(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false, genReqId: generateRequestId }),
  );
  registerCorrelation(app);
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  // Without this filter every domain error arrives as a 500 and every
  // assertion about 409s fails for the wrong reason.
  app.useGlobalFilters(new ProblemDetailsFilter(app.get(ConfigService)));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const found = await db.execute<{ id: string }>(sql`
    SELECT id FROM showtimes WHERE starts_at > now() + interval '1 day'
    ORDER BY starts_at LIMIT 1
  `);
  const showtimeId = found.rows[0]?.id;
  if (!showtimeId) throw new Error('the seed produced no future showtime');

  const seats = await db.execute<{ id: string }>(sql`
    SELECT se.id FROM seats se
    JOIN showtimes sh ON sh.hall_id = se.hall_id
    WHERE sh.id = ${showtimeId}
    ORDER BY se.row_label, se.seat_number LIMIT 20
  `);

  const hold: ReservationHarness['hold'] = (
    seatsToHold,
    session = randomUUID(),
    showtime = showtimeId,
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/reservations',
      headers: { 'x-session-id': session },
      payload: { showtimeId: showtime, seatIds: seatsToHold },
    });

  return {
    app,
    db,
    showtimeId,
    seatIds: seats.rows.map((row) => row.id),
    hold,
    holdOne: async (seat, session = randomUUID()) =>
      reservationSchema.parse((await hold([seat], session)).json()),
    act: (method, path, session) =>
      app.inject({
        method,
        url: `/api/v1/reservations${path}`,
        headers: { 'x-session-id': session },
      }),
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}
