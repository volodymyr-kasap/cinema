import { Inject, Injectable } from '@nestjs/common';
import type { Cinema, Movie, PaginationQuery, Page } from '@cinema/contracts';
import { asc, eq, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { DRIZZLE, type Database, type Executor } from '../db/drizzle.module';
import { cinemas, movies } from '../db/schema';
import { ResourceNotFoundError } from '../http/errors';
import { decodeTextIdCursor, encodeCursor } from './cursor';

@Injectable()
export class CatalogService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listMovies(query: PaginationQuery, executor: Executor = this.db): Promise<Page<Movie>> {
    // One row more than asked for: its presence is what tells us there is a next page.
    const rows = await executor
      .select({
        id: movies.id,
        title: movies.title,
        description: movies.description,
        durationMinutes: movies.durationMinutes,
        posterUrl: movies.posterUrl,
        releaseDate: movies.releaseDate,
        rating: movies.rating,
      })
      .from(movies)
      .where(query.cursor ? afterTextId(movies.title, movies.id, query.cursor) : undefined)
      .orderBy(asc(movies.title), asc(movies.id))
      .limit(query.limit + 1);

    return toPage(rows, query.limit, (row) => encodeCursor([row.title, row.id]));
  }

  async getMovie(id: string, executor: Executor = this.db): Promise<Movie> {
    const [row] = await executor
      .select({
        id: movies.id,
        title: movies.title,
        description: movies.description,
        durationMinutes: movies.durationMinutes,
        posterUrl: movies.posterUrl,
        releaseDate: movies.releaseDate,
        rating: movies.rating,
      })
      .from(movies)
      .where(eq(movies.id, id))
      .limit(1);

    if (!row) throw new ResourceNotFoundError('Movie', id);
    return row;
  }

  async listCinemas(query: PaginationQuery, executor: Executor = this.db): Promise<Page<Cinema>> {
    const rows = await executor
      .select({
        id: cinemas.id,
        name: cinemas.name,
        city: cinemas.city,
        address: cinemas.address,
        timezone: cinemas.timezone,
      })
      .from(cinemas)
      .where(query.cursor ? afterTextId(cinemas.name, cinemas.id, query.cursor) : undefined)
      .orderBy(asc(cinemas.name), asc(cinemas.id))
      .limit(query.limit + 1);

    return toPage(rows, query.limit, (row) => encodeCursor([row.name, row.id]));
  }

  async getCinema(id: string, executor: Executor = this.db): Promise<Cinema> {
    const [row] = await executor
      .select({
        id: cinemas.id,
        name: cinemas.name,
        city: cinemas.city,
        address: cinemas.address,
        timezone: cinemas.timezone,
      })
      .from(cinemas)
      .where(eq(cinemas.id, id))
      .limit(1);

    if (!row) throw new ResourceNotFoundError('Cinema', id);
    return row;
  }
}

/** Row-value comparison: `(title, id) > ($1, $2)` is exactly the keyset predicate. */
function afterTextId(textColumn: PgColumn, idColumn: PgColumn, cursor: string) {
  const [text, id] = decodeTextIdCursor(cursor);
  return sql`(${textColumn}, ${idColumn}) > (${text}, ${id}::uuid)`;
}

function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);

  return { data, nextCursor: hasMore && last ? cursorOf(last) : null };
}
