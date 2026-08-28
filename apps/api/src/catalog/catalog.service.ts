import { Inject, Injectable } from '@nestjs/common';
import type {
  Cinema,
  Movie,
  PaginationQuery,
  Page,
  Showtime,
  ShowtimeQuery,
  ShowtimeSeats,
} from '@cinema/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { DRIZZLE, type Database, type Executor } from '../db/drizzle.module';
import {
  cinemas,
  halls,
  movies,
  reservationSeats,
  reservations,
  seatCategories,
  seats,
  showtimes,
} from '../db/schema';
import { ResourceNotFoundError } from '../http/errors';
import { decodeTextIdCursor, decodeTimestampIdCursor, encodeCursor } from './cursor';

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

  async listShowtimes(query: ShowtimeQuery, executor: Executor = this.db): Promise<Page<Showtime>> {
    const filters = [];
    if (query.movieId) filters.push(eq(showtimes.movieId, query.movieId));
    if (query.cinemaId) filters.push(eq(cinemas.id, query.cinemaId));
    if (query.date) {
      // The calendar day is the cinema's, not UTC's. Doing this in SQL keeps one
      // rule for every zone instead of a per-request conversion in the service.
      filters.push(
        sql`(${showtimes.startsAt} AT TIME ZONE ${cinemas.timezone})::date = ${query.date}::date`,
      );
    }
    if (query.cursor) {
      const [startsAt, id] = decodeTimestampIdCursor(query.cursor);
      filters.push(
        sql`(${showtimes.startsAt}, ${showtimes.id}) > (${startsAt}::timestamptz, ${id}::uuid)`,
      );
    }

    const rows = await executor
      .select(showtimeColumns)
      .from(showtimes)
      .innerJoin(halls, eq(halls.id, showtimes.hallId))
      .innerJoin(cinemas, eq(cinemas.id, halls.cinemaId))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(asc(showtimes.startsAt), asc(showtimes.id))
      .limit(query.limit + 1);

    return toPage(rows.map(toShowtime), query.limit, (row) => encodeCursor([row.startsAt, row.id]));
  }

  async getShowtime(id: string, executor: Executor = this.db): Promise<Showtime> {
    const [row] = await executor
      .select(showtimeColumns)
      .from(showtimes)
      .innerJoin(halls, eq(halls.id, showtimes.hallId))
      .innerJoin(cinemas, eq(cinemas.id, halls.cinemaId))
      .where(eq(showtimes.id, id))
      .limit(1);

    if (!row) throw new ResourceNotFoundError('Showtime', id);
    return toShowtime(row);
  }

  async getShowtimeSeats(
    id: string,
    sessionId: string | null = null,
    executor: Executor = this.db,
  ): Promise<ShowtimeSeats> {
    const showtime = await this.getShowtime(id, executor);

    const rows = await executor
      .select({
        seatId: seats.id,
        rowLabel: seats.rowLabel,
        seatNumber: seats.seatNumber,
        category: seats.categoryCode,
        surchargeCents: seatCategories.surchargeCents,
        holderStatus: reservations.status,
        holderSession: reservations.sessionId,
      })
      .from(seats)
      .innerJoin(seatCategories, eq(seatCategories.code, seats.categoryCode))
      // At most one active row per (showtime, seat) -- guaranteed by the same
      // unique index that prevents the double booking.
      .leftJoin(
        reservationSeats,
        and(
          eq(reservationSeats.seatId, seats.id),
          eq(reservationSeats.showtimeId, showtime.id),
          isNull(reservationSeats.releasedAt),
        ),
      )
      // An unreleased row belonging to a lapsed hold joins to nothing, so the
      // seat reads AVAILABLE without anyone having swept it.
      .leftJoin(
        reservations,
        and(
          eq(reservations.id, reservationSeats.reservationId),
          sql`(${reservations.status} = 'CONFIRMED'
               OR (${reservations.status} = 'PENDING' AND ${reservations.expiresAt} > now()))`,
        ),
      )
      .where(eq(seats.hallId, showtime.hallId))
      .orderBy(asc(seats.rowLabel), asc(seats.seatNumber));

    return {
      showtimeId: showtime.id,
      hallId: showtime.hallId,
      hallName: showtime.hallName,
      seats: rows.map((row) => ({
        seatId: row.seatId,
        rowLabel: row.rowLabel,
        seatNumber: row.seatNumber,
        category: row.category as ShowtimeSeats['seats'][number]['category'],
        priceCents: showtime.basePriceCents + row.surchargeCents,
        status:
          row.holderStatus === 'CONFIRMED'
            ? ('CONFIRMED' as const)
            : row.holderStatus === 'PENDING'
              ? ('HELD' as const)
              : ('AVAILABLE' as const),
        heldByYou: sessionId !== null && row.holderSession === sessionId,
      })),
    };
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

const showtimeColumns = {
  id: showtimes.id,
  movieId: showtimes.movieId,
  hallId: showtimes.hallId,
  hallName: halls.name,
  cinemaId: cinemas.id,
  cinemaName: cinemas.name,
  startsAt: showtimes.startsAt,
  endsAt: showtimes.endsAt,
  basePriceCents: showtimes.basePriceCents,
  language: showtimes.language,
  format: showtimes.format,
};

type ShowtimeRow = {
  [K in keyof typeof showtimeColumns]: K extends 'startsAt' | 'endsAt'
    ? Date
    : K extends 'basePriceCents'
      ? number
      : string;
};

function toShowtime(row: ShowtimeRow): Showtime {
  return {
    ...row,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    format: row.format as Showtime['format'],
  };
}
