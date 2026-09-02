import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { parseEnv } from '../config/env';
import type { Database } from './drizzle.module';
import { cinemas, halls, movies, schema, seatCategories, seats, showtimes, users } from './schema';
import {
  BASE_PRICE_CENTS,
  CINEMAS,
  CLEANING_MINUTES,
  FORMATS,
  LANGUAGES,
  MOVIES,
  SEAT_CATEGORIES,
  SEED_DAYS,
  seedStartDate,
  SLOTS,
  USERS,
  categoryForRow,
  rowLabel,
} from './seed-data';
import { zonedToUtc } from './timezone';

const INSERT_CHUNK = 1_000;

async function insertInChunks<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await insert(rows.slice(i, i + INSERT_CHUNK));
  }
}

/** Wipes and rebuilds the catalogue. Deterministic: same input, same rows, every time. */
export async function seedDatabase(db: Database): Promise<void> {
  await db.execute(
    // reservations and reservation_seats would be swept by CASCADE anyway,
    // through their foreign key to showtimes. Naming them is the difference
    // between a rule you can read and one you have to derive.
    sql`TRUNCATE TABLE reservation_seats, reservations, showtimes, seats, halls, cinemas, movies, seat_categories, users RESTART IDENTITY CASCADE`,
  );

  await db.insert(seatCategories).values([...SEAT_CATEGORIES]);
  await db.insert(users).values(USERS.map((u) => ({ email: u.email, displayName: u.displayName })));

  const movieRows = await db
    .insert(movies)
    .values(
      MOVIES.map((m) => ({
        title: m.title,
        description: `${m.title} — seeded catalogue entry.`,
        durationMinutes: m.durationMinutes,
        posterUrl: `https://images.example/posters/${m.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`,
        releaseDate: m.releaseDate,
        rating: m.rating,
      })),
    )
    .returning({ id: movies.id, durationMinutes: movies.durationMinutes });

  let showtimeCounter = 0;

  for (const cinemaSpec of CINEMAS) {
    const [cinema] = await db
      .insert(cinemas)
      .values({
        name: cinemaSpec.name,
        city: cinemaSpec.city,
        address: cinemaSpec.address,
        timezone: cinemaSpec.timezone,
      })
      .returning({ id: cinemas.id });
    if (!cinema) throw new Error('cinema insert returned nothing');

    for (const hallSpec of cinemaSpec.halls) {
      const [hall] = await db
        .insert(halls)
        .values({ cinemaId: cinema.id, name: hallSpec.name })
        .returning({ id: halls.id });
      if (!hall) throw new Error('hall insert returned nothing');

      const seatRows = [];
      for (let row = 0; row < hallSpec.rows; row += 1) {
        for (let seat = 1; seat <= hallSpec.seatsPerRow; seat += 1) {
          seatRows.push({
            hallId: hall.id,
            rowLabel: rowLabel(row),
            seatNumber: seat,
            categoryCode: categoryForRow(row, hallSpec.rows),
          });
        }
      }
      await insertInChunks(seatRows, (chunk) => db.insert(seats).values(chunk));

      const showtimeRows = [];
      // Read once, so a seed run that straddles midnight cannot anchor its
      // first days on one date and its last on another.
      const seedStart = seedStartDate();
      for (let day = 0; day < SEED_DAYS; day += 1) {
        for (const slot of SLOTS) {
          const movie = movieRows[showtimeCounter % movieRows.length];
          if (!movie) throw new Error('no movies seeded');

          const startsAt = zonedToUtc(
            seedStart.year,
            seedStart.month,
            seedStart.day + day,
            slot.hour,
            slot.minute,
            cinemaSpec.timezone,
          );
          const endsAt = new Date(
            startsAt.getTime() + (movie.durationMinutes + CLEANING_MINUTES) * 60_000,
          );

          showtimeRows.push({
            movieId: movie.id,
            hallId: hall.id,
            startsAt,
            endsAt,
            basePriceCents: BASE_PRICE_CENTS + (showtimeCounter % 3) * 2_000,
            language: LANGUAGES[showtimeCounter % LANGUAGES.length] ?? 'uk',
            format: FORMATS[showtimeCounter % FORMATS.length] ?? 'TWO_D',
          });
          showtimeCounter += 1;
        }
      }
      await insertInChunks(showtimeRows, (chunk) => db.insert(showtimes).values(chunk));
    }
  }
}

async function main(): Promise<void> {
  const { databaseUrl } = parseEnv(process.env);
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // One definition of the schema map (R4): the inline literal this replaced
    // was a copy that could drift from ./schema.
    await seedDatabase(drizzle(pool, { schema }) as Database);
    console.log('seed complete');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
