import { desc, sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** PostgreSQL 18 generates UUID v7 natively: time-ordered, so B-tree locality survives. */
const primaryId = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

export const users = pgTable('users', {
  id: primaryId(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const movies = pgTable('movies', {
  id: primaryId(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  posterUrl: text('poster_url').notNull(),
  releaseDate: date('release_date').notNull(),
  rating: real('rating').notNull(),
});

export const cinemas = pgTable('cinemas', {
  id: primaryId(),
  name: text('name').notNull(),
  city: text('city').notNull(),
  address: text('address').notNull(),
  /** IANA zone. Times are stored in UTC; this is applied only for display and date filters. */
  timezone: text('timezone').notNull(),
});

export const halls = pgTable(
  'halls',
  {
    id: primaryId(),
    cinemaId: uuid('cinema_id')
      .notNull()
      .references(() => cinemas.id),
    name: text('name').notNull(),
  },
  (t) => [
    index('halls_cinema_idx').on(t.cinemaId),
    uniqueIndex('halls_cinema_name_uq').on(t.cinemaId, t.name),
  ],
);

/** Pricing policy lives in the database, not in a constant map in the code. */
export const seatCategories = pgTable('seat_categories', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  surchargeCents: integer('surcharge_cents').notNull(),
});

export const seats = pgTable(
  'seats',
  {
    id: primaryId(),
    hallId: uuid('hall_id')
      .notNull()
      .references(() => halls.id),
    rowLabel: text('row_label').notNull(),
    seatNumber: integer('seat_number').notNull(),
    categoryCode: text('category_code')
      .notNull()
      .references(() => seatCategories.code),
  },
  (t) => [
    uniqueIndex('seats_hall_row_number_uq').on(t.hallId, t.rowLabel, t.seatNumber),
    index('seats_hall_idx').on(t.hallId),
  ],
);

export const showtimes = pgTable(
  'showtimes',
  {
    id: primaryId(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    hallId: uuid('hall_id')
      .notNull()
      .references(() => halls.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    basePriceCents: integer('base_price_cents').notNull(),
    language: text('language').notNull(),
    format: text('format').notNull(),
  },
  (t) => [
    index('showtimes_movie_starts_idx').on(t.movieId, t.startsAt),
    index('showtimes_hall_starts_idx').on(t.hallId, t.startsAt),
  ],
);

export const reservations = pgTable(
  'reservations',
  {
    id: primaryId(),
    showtimeId: uuid('showtime_id')
      .notNull()
      .references(() => showtimes.id),
    /**
     * An anonymous browser session, not a user. Phase 2 has no authentication,
     * and a nullable `user_id` nobody writes would be a dead column, not a seam.
     */
    sessionId: uuid('session_id').notNull(),
    status: text('status').notNull(),
    totalPriceCents: integer('total_price_cents').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    index('reservations_session_created_idx').on(t.sessionId, desc(t.createdAt), desc(t.id)),
    check(
      'reservations_status_check',
      sql`${t.status} IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED')`,
    ),
  ],
);

export const reservationSeats = pgTable(
  'reservation_seats',
  {
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    seatId: uuid('seat_id')
      .notNull()
      .references(() => seats.id),
    /**
     * Denormalised from the parent reservation for exactly one reason: a partial
     * unique index can only see columns on its own row, and this is the column
     * the invariant is keyed on.
     */
    showtimeId: uuid('showtime_id')
      .notNull()
      .references(() => showtimes.id),
    /** Quoted at hold time — the showtime's price may move while a user decides. */
    priceCents: integer('price_cents').notNull(),
    /** NULL means this seat is taken. This column is the whole invariant. */
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.reservationId, t.seatId] }),
    uniqueIndex('reservation_seats_active_uq')
      .on(t.showtimeId, t.seatId)
      .where(sql`released_at IS NULL`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: primaryId(),
    /**
     * UNIQUE, and that is the structural half of idempotency. Five concurrent
     * confirms already serialise on the reservation's FOR UPDATE; this index
     * makes a second payment impossible even if that lock were ever wrong. The
     * same move as `reservation_seats_active_uq`: the invariant lives in the
     * schema, not in the code that respects it (ADR 0009, ADR 0035).
     */
    reservationId: uuid('reservation_id')
      .notNull()
      .unique()
      .references(() => reservations.id),
    status: text('status').notNull(),
    /**
     * Copied from the reservation when the payment starts. Not denormalised for
     * speed: this is the sum the provider was asked for, and it must survive any
     * later change to the reservation.
     */
    amountCents: integer('amount_cents').notNull(),
    /** NULL until the provider answers. The first thing a human reading the DLQ wants. */
    providerRef: text('provider_ref'),
    /**
     * Calls made to the provider, replays included. Not a duplicate of the
     * `x-attempt` header: that lives in the message and dies with it.
     */
    attempts: integer('attempts').notNull().default(0),
    /** Fake-provider passthrough; NULL in ordinary use. Stored so retry N sends what attempt 1 sent. */
    scenario: text('scenario'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'payments_status_check',
      sql`${t.status} IN ('PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED')`,
    ),
    /** The reaper's predicate: pending payments, oldest first. */
    index('payments_pending_created_idx').on(t.status, t.createdAt),
  ],
);

export const schema = {
  users,
  movies,
  cinemas,
  halls,
  seatCategories,
  seats,
  showtimes,
  reservations,
  reservationSeats,
  payments,
};
