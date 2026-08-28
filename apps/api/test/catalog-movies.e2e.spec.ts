import {
  cinemaPageSchema,
  moviePageSchema,
  movieSchema,
  problemDetailsSchema,
} from '@cinema/contracts';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { AppModule } from '../src/app.module';
import type { Database } from '../src/db/drizzle.module';
import { schema } from '../src/db/schema';
import { seedDatabase } from '../src/db/seed';
import { generateRequestId, registerCorrelation } from '../src/observability/logger';
import { getTestDatabaseUrl } from './harness';

describe('catalogue: movies and cinemas', () => {
  let app: NestFastifyApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await seedDatabase(drizzle(pool, { schema }) as Database);

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

  it('returns the first page in a data/nextCursor envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/movies?limit=4' });

    expect(response.statusCode).toBe(200);
    const page = moviePageSchema.parse(response.json());
    expect(page.data).toHaveLength(4);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('walks the whole catalogue by cursor without repeating or losing a movie', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const url: string = `/api/v1/movies?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = moviePageSchema.parse((await app.inject({ method: 'GET', url })).json());
      seen.push(...page.data.map((movie) => movie.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  it('orders movies by title', async () => {
    const page = moviePageSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/movies?limit=100' })).json(),
    );
    const titles = page.data.map((movie) => movie.title);

    expect(titles).toEqual([...titles].sort());
    expect(page.nextCursor).toBeNull();
  });

  it('returns a single movie', async () => {
    const page = moviePageSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/movies?limit=1' })).json(),
    );
    const id = page.data[0]?.id;

    const response = await app.inject({ method: 'GET', url: `/api/v1/movies/${id}` });

    expect(response.statusCode).toBe(200);
    expect(movieSchema.parse(response.json()).id).toBe(id);
  });

  it('answers 404 as a problem document for an unknown movie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/movies/019298a1-7c4e-7c3a-8f21-000000000000',
    });

    expect(response.statusCode).toBe(404);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/not-found$/);
  });

  it('answers 400 for a malformed id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/movies/not-a-uuid' });

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/validation-failed$/);
  });

  it('answers 400 for a cursor it did not issue', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/movies?cursor=zzzz' });

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/invalid-cursor$/);
  });

  it('answers 400 for a limit above the maximum', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/movies?limit=1000' });

    expect(response.statusCode).toBe(400);
  });

  it('lists the three cinemas with their time zones', async () => {
    const page = cinemaPageSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/cinemas' })).json(),
    );

    expect(page.data).toHaveLength(3);
    expect(page.data.map((cinema) => cinema.city).sort()).toEqual(['Kyiv', 'Lviv', 'Warsaw']);
    expect(page.data.find((cinema) => cinema.city === 'Warsaw')?.timezone).toBe('Europe/Warsaw');
  });
});
