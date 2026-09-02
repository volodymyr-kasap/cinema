import { randomUUID } from 'node:crypto';

import { reservationSchema, type Reservation } from '@cinema/contracts';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import type { InjectOptions, Response as LightMyRequestResponse } from 'light-my-request';
import { Pool } from 'pg';

import { AppModule } from '../src/app.module';
import { ConfigService } from '../src/config/config.service';
import type { Database } from '../src/db/drizzle.module';
import { schema } from '../src/db/schema';
import { seedDatabase } from '../src/db/seed';
import { ProblemDetailsFilter } from '../src/http/problem-details.filter';
import { createRedisClient } from '../src/locking/redis.module';
import { SEAT_LOCK, type SeatLock } from '../src/locking/seat-lock';
import { ExpirePublisher } from '../src/messaging/expire.publisher';
import { generateRequestId, registerCorrelation } from '../src/observability/logger';
import { getTestDatabaseUrl, getTestRedisUrl } from './harness';

export interface HarnessOptions {
  /** Which adapter the application under test binds to SEAT_LOCK. */
  lockStrategy?: 'db' | 'redis';
  /** Overrides REDIS_URL. Pointing it at a closed port is how fail open is proved. */
  redisUrl?: string;
  /** Shortens the hold, and with it the key's TTL. */
  ttlSeconds?: number;
  /**
   * Raised above the client count by the contention suite. At the default of
   * ten, forty of fifty clients queue for a connection instead of racing for a
   * seat and the suite passes for the wrong reason (ADR 0015).
   */
  poolMax?: number;
  /** Which expiry path the application under test uses. */
  expiryMode?: 'lazy' | 'queue';
  /** Overrides RABBITMQ_URL. Pointing it at a closed port is how fail open is proved. */
  rabbitmqUrl?: string;
  /**
   * Overrides the retry ladder. Queue arguments are part of a queue's identity,
   * so a suite that runs this harness beside a worker harness MUST give both the
   * same ladder -- otherwise the second one to declare the retry queues gets
   * PRECONDITION_FAILED (406) and loses its channel.
   */
  retryDelaysMs?: number[];
}

export interface ReservationHarness {
  app: NestFastifyApplication;
  db: Database;
  /** A showtime far enough ahead that it cannot start mid-suite. */
  showtimeId: string;
  /** Twenty seats of that showtime's hall, ordered by row then number. */
  seatIds: string[];
  /**
   * A showtime that has already started, and one of its seats. The seeded
   * catalogue does not contain one, so it is made here.
   *
   * It is placed five hours before `least(now(), min(starts_at))` — earlier than
   * every seeded showtime AND in the past — because the hall is shared with the
   * catalogue and `showtimes_no_overlap` is a GiST exclusion constraint, not a
   * suggestion. Anchoring on `now()` alone was the original bug: the seed window
   * was a literal 2026-09-01, so the day the calendar reached it the fixture
   * began landing inside a seeded showtime and every suite that builds this
   * harness failed on the insert. `seedStartDate()` now rolls, but this stays
   * anchored on the earlier of the two so it cannot depend on that.
   */
  pastShowtimeId: string;
  pastSeatId: string;
  hold(seats: string[], session?: string, showtime?: string): Promise<LightMyRequestResponse>;
  holdOne(seat: string, session?: string): Promise<Reservation>;
  act(
    method: InjectOptions['method'],
    path: string,
    session: string,
  ): Promise<LightMyRequestResponse>;
  /**
   * A second connection, always to the real container even when the application
   * is pointed at a dead one, for asserting on keys the application wrote.
   * `null` unless the harness was started with `lockStrategy: 'redis'`.
   */
  redis: Redis | null;
  /** The adapter the application actually bound, for calling the port directly. */
  lock: SeatLock;
  /** The publisher the application bound, for reading its fail-open counter. */
  publisher: ExpirePublisher;
  close(): Promise<void>;
}

/**
 * Boots the application against the shared containers.
 *
 * Starting a SECOND harness while a first one is still in use re-seeds: this
 * calls seedDatabase, which truncates showtimes and seats with RESTART IDENTITY
 * CASCADE, so every id the first harness handed out (`seatIds`, `showtimeId`,
 * `pastSeatId`) goes stale the moment the second one starts. A suite that needs
 * two configurations should either finish with the nested one or vary the row
 * it already holds instead.
 */
export async function startReservationHarness(
  options: HarnessOptions = {},
): Promise<ReservationHarness> {
  // Read before the overrides below touch REDIS_URL: the inspection client must
  // reach the real container even in the suite that points the application at a
  // closed port to prove fail open.
  const containerRedisUrl = getTestRedisUrl();

  // Patched before the module is compiled: ConfigService parses the environment
  // once, in its field initialiser, so an override applied later is invisible.
  const overrides: Record<string, string | undefined> = {
    LOCK_STRATEGY: options.lockStrategy,
    REDIS_URL: options.redisUrl,
    RESERVATION_TTL_SECONDS:
      options.ttlSeconds === undefined ? undefined : String(options.ttlSeconds),
    DATABASE_POOL_MAX: options.poolMax === undefined ? undefined : String(options.poolMax),
    RESERVATION_EXPIRY_MODE: options.expiryMode,
    RABBITMQ_URL: options.rabbitmqUrl,
    RABBITMQ_RETRY_DELAYS_MS: options.retryDelaysMs?.join(','),
  };
  const restore = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }

  const pool = new Pool({ connectionString: getTestDatabaseUrl() });
  // Testcontainers stops the database while connections may still be open, and
  // pg turns an unhandled idle-client error into a process abort. The suite is
  // over by then, so the only useful response is to ignore it.
  pool.on('error', () => {});
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

  const redis =
    options.lockStrategy === 'redis' ? createRedisClient(containerRedisUrl, 200, () => {}) : null;
  if (redis) await redis.connect();

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

  const started = await db.execute<{ id: string }>(sql`
    INSERT INTO showtimes (movie_id, hall_id, starts_at, ends_at, base_price_cents, language, format)
    SELECT sh.movie_id, sh.hall_id, anchor.t - interval '5 hours', anchor.t - interval '3 hours',
           sh.base_price_cents, sh.language, sh.format
    FROM showtimes sh
    CROSS JOIN (SELECT least(now(), min(starts_at)) AS t FROM showtimes) anchor
    WHERE sh.id = ${showtimeId}
    RETURNING id
  `);
  const pastShowtimeId = started.rows[0]?.id;
  if (!pastShowtimeId) throw new Error('could not create a started showtime');

  const pastSeat = await db.execute<{ id: string }>(sql`
    SELECT se.id FROM seats se
    JOIN showtimes sh ON sh.hall_id = se.hall_id
    WHERE sh.id = ${pastShowtimeId}
    ORDER BY se.row_label, se.seat_number LIMIT 1
  `);
  const pastSeatId = pastSeat.rows[0]?.id;
  if (!pastSeatId) throw new Error('the started showtime has no seats');

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
    pastShowtimeId,
    pastSeatId,
    hold,
    holdOne: async (seat, session = randomUUID()) =>
      reservationSchema.parse((await hold([seat], session)).json()),
    act: (method, path, session) =>
      app.inject({
        method,
        url: `/api/v1/reservations${path}`,
        headers: { 'x-session-id': session },
      }),
    redis,
    lock: app.get<SeatLock>(SEAT_LOCK),
    publisher: app.get(ExpirePublisher),
    close: async () => {
      await app.close();
      await pool.end();
      if (redis) await redis.quit();
      // Restoring rather than deleting: a suite that ran before this one may
      // have set the same variable, and leaking a strategy into the next file
      // is the kind of failure that only reproduces in full runs.
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
