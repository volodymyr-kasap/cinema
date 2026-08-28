# Cinema Booking Platform — Phase 2 (Reservations & Contention) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user select seats, hold them, and confirm the hold — and prove with a test that two people racing for one seat produce exactly one reservation and zero double bookings.

**Architecture:** A `reservations` aggregate with a line table `reservation_seats` whose partial unique index `(showtime_id, seat_id) WHERE released_at IS NULL` **is** the no-double-booking invariant. Holds are taken inside one `READ COMMITTED` transaction with `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so the index — not application code — serialises the race, and the returned rows name the seats the caller lost. Expiry is lazy: a `PENDING` hold past `expires_at` is released by whoever it blocks, so no scheduler exists yet. The SPA gains multi-seat selection, a reservation page with a countdown, cancel, and confirm.

**Tech Stack:** Unchanged from phase 1 — NestJS 12 on Fastify, Drizzle + PostgreSQL 18, Zod 4 contracts, Jest 30 + Testcontainers, React 19 + TanStack Query 5, Vitest 4 + Testing Library + MSW, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-28-cinema-platform-phase-2-design.md`

## Global Constraints

No new runtime dependencies are added by this plan. If a task seems to need one, stop and ask — phase 2's entire point is that PostgreSQL alone is enough, and the comparison in sub-project 3 is worthless if something else sneaks in.

Rules that apply to every task:

- **Redis, RabbitMQ, Kafka, k6, payments, `Idempotency-Key`, and real authentication are out of scope.** Each has its own sub-project. Do not add a scheduler, a cron job, or a `setInterval` sweeper for expiry either — lazy expiry is a deliberate design decision (spec §4).
- **Do not install Zustand or React Hook Form.** Phase 1's spec deferred them to here; phase 2's spec cancels that (spec §8). Selection state is page-local `useState`.
- **The invariant lives in the database.** Never write a "is this seat free?" `SELECT` followed by an `INSERT` — that is the check-then-act race this whole sub-project exists to eliminate.
- **Money is `integer` in minor units** (`*_cents`), single currency UAH. **Timestamps are `timestamptz` in UTC.** **JSON field names are camelCase.**
- **`@cinema/contracts` must be rebuilt (`npm run build -w @cinema/contracts`) before `apps/api` or `apps/web` are typechecked or tested** after any change to it.
- **Time comparisons use the database's `now()`, never the Node process clock.** Two clocks disagreeing is a bug that only shows up under load.
- **Commit after every task** using the message given in that task's final step.

## Existing code this plan builds on

Read these before starting — the plan assumes their shapes and does not repeat them:

| File | What it gives you |
| --- | --- |
| `apps/api/src/db/drizzle.module.ts` | `DRIZZLE` token, `Database`, and the `Executor` type that already accepts a transaction |
| `apps/api/src/http/errors.ts` | `DomainError` base — status and `typeSlug` live on the error class |
| `apps/api/src/http/problem-details.filter.ts` | Turns a `DomainError` into RFC 9457 JSON |
| `apps/api/src/http/zod-validation.pipe.ts` | `zodPipe(schema)` for params, query, and body |
| `apps/api/src/http/validated.decorator.ts` | `@Validated(schema)` declares the response contract |
| `apps/api/src/catalog/catalog.service.ts` | `getShowtime(id, executor)` and the `getShowtimeSeats` stub this plan replaces |
| `apps/api/test/harness.ts` | One Testcontainers Postgres per Jest run; suites re-seed in `beforeAll` |
| `apps/web/src/shared/api/client.ts` | `apiFetch(path, schema, init)` and `ApiError` carrying the problem document |
| `apps/web/src/shared/api/query-keys.ts` | The typed key factory this plan extends |

## File Structure

```
packages/contracts/src/
├── reservation.ts                        # NEW: status, create input, reservation + page schemas
├── seat.ts                               # MODIFY: heldByYou on showtimeSeatSchema
├── common.ts                             # MODIFY: seatIds extension on problemDetailsSchema
└── index.ts                              # MODIFY: export reservation.ts

apps/api/
├── drizzle/0002_reservations.sql         # NEW: generated tables
├── drizzle/0003_reservation_invariant.sql # NEW: hand-written partial unique index + CHECK
├── src/config/env.ts                     # MODIFY: RESERVATION_TTL_SECONDS, DATABASE_POOL_MAX
├── src/db/schema.ts                       # MODIFY: reservations, reservationSeats
├── src/db/seed.ts                         # MODIFY: TRUNCATE list
├── src/db/drizzle.module.ts               # MODIFY: pool max from config
├── src/http/errors.ts                     # MODIFY: six new DomainError subclasses
├── src/http/problem-details.filter.ts     # MODIFY: serialise error extensions
├── src/http/session.decorator.ts          # NEW: @SessionId() / @OptionalSessionId()
├── src/catalog/catalog.service.ts         # MODIFY: real seat occupancy
├── src/reservations/
│   ├── state-machine.ts                   # NEW: canTransition — pure, unit-tested
│   ├── state-machine.test.ts              # NEW
│   ├── reservation.service.ts             # NEW: create / get / list / cancel / confirm
│   ├── reservation.controller.ts          # NEW
│   └── reservation.module.ts              # NEW
├── src/openapi/routes.ts                  # MODIFY: widen RouteDoc, add five routes
├── src/app.module.ts                      # MODIFY: import ReservationModule
└── test/
    ├── truncate.ts                        # NEW: shared cleanup helper
    ├── reservations.e2e.spec.ts           # NEW: lifecycle, ownership, validation
    ├── reservations-contention.e2e.spec.ts # NEW: THE deliverable
    └── seat-occupancy.e2e.spec.ts         # NEW: seat map reflects holds

apps/web/src/
├── shared/api/session.ts                  # NEW: per-browser session id
├── shared/api/client.ts                   # MODIFY: attach X-Session-Id
├── shared/api/reservations.ts             # NEW: reservation endpoints
├── shared/api/query-keys.ts               # MODIFY: reservations keys
├── shared/lib/use-countdown.ts            # NEW
├── features/seat-map/                     # MODIFY: selection, summary bar, hold mutation
└── features/reservations/                 # NEW: reservation page

docs/adr/0009..0015-*.md                   # NEW: seven decision records
```

---

## Task 1: Contracts — reservation schemas and the two additive field changes

**Files:**

- Create: `packages/contracts/src/reservation.ts`
- Create: `packages/contracts/src/reservation.test.ts`
- Modify: `packages/contracts/src/seat.ts`
- Modify: `packages/contracts/src/common.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Consumes: `pageSchema` and `problemDetailsSchema` from `common.ts`; `seatCategorySchema` from `seat.ts`.
- Produces: `reservationStatusSchema`, `createReservationSchema`, `reservationSchema`, `reservationPageSchema`, and the types `ReservationStatus`, `CreateReservation`, `Reservation`, `ReservationSeat`. Adds `heldByYou: boolean` to `showtimeSeatSchema` and optional `seatIds?: string[]` to `problemDetailsSchema`. Every later task imports from here.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/reservation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createReservationSchema, reservationSchema } from './reservation';

describe('createReservationSchema', () => {
  const showtimeId = '019298a1-7c4e-7c3a-8f21-000000000001';
  const seat = (n: number) => `019298a1-7c4e-7c3a-8f21-00000000000${n}`;

  it('accepts a showtime and between one and ten seats', () => {
    const parsed = createReservationSchema.parse({ showtimeId, seatIds: [seat(1), seat(2)] });
    expect(parsed.seatIds).toHaveLength(2);
  });

  it('rejects an empty seat list', () => {
    expect(createReservationSchema.safeParse({ showtimeId, seatIds: [] }).success).toBe(false);
  });

  it('rejects more than ten seats', () => {
    const many = Array.from({ length: 11 }, (_, i) => `019298a1-7c4e-7c3a-8f21-0000000000${10 + i}`);
    expect(createReservationSchema.safeParse({ showtimeId, seatIds: many }).success).toBe(false);
  });

  // A repeated id would collapse inside `seat_id = ANY(...)`, and the service's
  // "fewer rows than seats asked for" check would report a conflict on a seat
  // nobody holds. Rejecting here keeps that lie impossible.
  it('rejects a repeated seat id', () => {
    const result = createReservationSchema.safeParse({ showtimeId, seatIds: [seat(1), seat(1)] });
    expect(result.success).toBe(false);
  });
});

describe('reservationSchema', () => {
  it('parses a hold with its seats', () => {
    const parsed = reservationSchema.parse({
      id: '019298a1-7c4e-7c3a-8f21-000000000009',
      showtimeId: '019298a1-7c4e-7c3a-8f21-000000000001',
      status: 'PENDING',
      totalPriceCents: 45000,
      expiresAt: '2026-08-28T12:10:00.000Z',
      createdAt: '2026-08-28T12:00:00.000Z',
      seats: [
        {
          seatId: '019298a1-7c4e-7c3a-8f21-000000000002',
          rowLabel: 'C',
          seatNumber: 7,
          category: 'VIP',
          priceCents: 22500,
        },
      ],
    });

    expect(parsed.status).toBe('PENDING');
    expect(parsed.seats[0]?.rowLabel).toBe('C');
  });

  it('rejects a status outside the state machine', () => {
    expect(reservationSchema.safeParse({ status: 'PAID' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/contracts`
Expected: FAIL — `Failed to resolve import "./reservation"`.

- [ ] **Step 3: Write `packages/contracts/src/reservation.ts`**

```ts
import { z } from 'zod';

import { pageSchema } from './common';
import { seatCategorySchema } from './seat';

/**
 * The whole state machine. `PENDING` is the only non-terminal state: a hold
 * either becomes a purchase, is given up, or runs out of time.
 */
export const reservationStatusSchema = z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED']);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;

/** Not a business rule: an upper bound on how many rows one transaction may lock. */
export const MAX_SEATS_PER_RESERVATION = 10;

export const createReservationSchema = z.object({
  showtimeId: z.uuid(),
  seatIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_SEATS_PER_RESERVATION)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'seatIds must not repeat a seat',
    }),
});
export type CreateReservation = z.infer<typeof createReservationSchema>;

/** Geometry travels with the reservation so the confirmation screen needs no second request. */
export const reservationSeatSchema = z.object({
  seatId: z.uuid(),
  rowLabel: z.string().min(1),
  seatNumber: z.int().positive(),
  category: seatCategorySchema,
  /** The price quoted when the hold was taken, not today's price of the showtime. */
  priceCents: z.int().nonnegative(),
});
export type ReservationSeat = z.infer<typeof reservationSeatSchema>;

export const reservationSchema = z.object({
  id: z.uuid(),
  showtimeId: z.uuid(),
  status: reservationStatusSchema,
  totalPriceCents: z.int().nonnegative(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  seats: z.array(reservationSeatSchema).min(1),
});
export type Reservation = z.infer<typeof reservationSchema>;

export const reservationPageSchema = pageSchema(reservationSchema);
```

- [ ] **Step 4: Add `heldByYou` to the seat schema**

In `packages/contracts/src/seat.ts`, add the field to `showtimeSeatSchema` after `status` and replace the stale phase 1 comment on `seatStatusSchema`:

```ts
/**
 * `HELD` means someone's unexpired hold covers this seat; `CONFIRMED` means it
 * is sold. A hold past its expiry reads as `AVAILABLE` — expiry is decided by
 * the same predicate that decides whether a hold blocks an insert.
 */
export const seatStatusSchema = z.enum(['AVAILABLE', 'HELD', 'CONFIRMED']);
export type SeatStatus = z.infer<typeof seatStatusSchema>;

export const showtimeSeatSchema = z.object({
  seatId: z.uuid(),
  rowLabel: z.string().min(1),
  seatNumber: z.int().positive(),
  category: seatCategorySchema,
  /** Showtime base price plus the category surcharge; the client never computes this. */
  priceCents: z.int().nonnegative(),
  status: seatStatusSchema,
  /**
   * True when the reservation covering this seat belongs to the caller's
   * session. Without it the map cannot tell your own hold from a stranger's and
   * shows your seats as unavailable to you.
   */
  heldByYou: z.boolean(),
});
```

- [ ] **Step 5: Add the problem-details extension**

In `packages/contracts/src/common.ts`, add one optional field to `problemDetailsSchema`:

```ts
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  detail: z.string(),
  instance: z.string(),
  traceId: z.string(),
  /**
   * RFC 9457 extension member, present only on `seats-unavailable`: the seats
   * this request lost. It is what lets the map highlight exactly those.
   */
  seatIds: z.array(z.uuid()).optional(),
});
```

- [ ] **Step 6: Export the new module**

Add to `packages/contracts/src/index.ts`, keeping the file's existing alphabetical order of `export *` lines:

```ts
export * from './reservation';
```

- [ ] **Step 7: Run the tests**

Run: `npm test -w @cinema/contracts`
Expected: PASS, including the existing `common.test.ts`.

- [ ] **Step 8: Rebuild contracts and typecheck the consumers**

Run: `npm run build -w @cinema/contracts && npm run typecheck`
Expected: `apps/api` and `apps/web` both **fail** — `showtimeSeatSchema` now requires `heldByYou`, which `catalog.service.ts` does not return and the web fixtures do not provide. That failure is the point: the contract change has found every place that must be updated. Tasks 8 and 9 fix the API side; Task 11 fixes the web fixtures. To keep this task's commit green, add the field as `heldByYou: false` in `apps/api/src/catalog/catalog.service.ts` (beside the existing `status: 'AVAILABLE' as const`) and in `apps/web/src/test/fixtures.ts`, with the comment `// Task 9 replaces this constant with the real occupancy join.`

- [ ] **Step 9: Verify and commit**

Run: `npm run build -w @cinema/contracts && npm run typecheck && npm test -w @cinema/contracts`
Expected: all PASS.

```bash
git add packages/contracts apps/api/src/catalog/catalog.service.ts apps/web/src/test/fixtures.ts
git commit -m "feat(contracts): add reservation schemas and seat ownership"
```

---

## Task 2: Database schema, the invariant, and configuration

**Files:**

- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0002_reservations.sql` (generated)
- Create: `apps/api/drizzle/0003_reservation_invariant.sql` (hand-written)
- Modify: `apps/api/drizzle/meta/_journal.json`
- Modify: `apps/api/src/db/seed.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/db/drizzle.module.ts`
- Modify: `apps/api/test/schema.e2e.spec.ts`
- Modify: `.env.example`

**Interfaces:**

- Consumes: `primaryId()`, `showtimes`, `seats` from `schema.ts`.
- Produces: `reservations` and `reservationSeats` Drizzle tables, both added to the exported `schema` object; `AppConfig.reservationTtlSeconds: number` and `AppConfig.databasePoolMax: number`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/schema.e2e.spec.ts`, inside the existing top-level `describe`. It uses the same `db`/`pool` fixtures the file already sets up — read the file first and reuse its helpers rather than creating new ones.

```ts
describe('the no-double-booking invariant', () => {
  it('has a unique index over active seat rows only', async () => {
    const result = await db.execute<{ indexdef: string }>(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'reservation_seats_active_uq'`,
    );

    expect(result.rows[0]?.indexdef).toMatch(/UNIQUE/);
    expect(result.rows[0]?.indexdef).toMatch(/released_at IS NULL/);
  });

  it('refuses a second active row for the same seat and showtime', async () => {
    const { showtimeId, seatId } = await anyShowtimeAndSeat();
    const first = await insertReservation(showtimeId);
    const second = await insertReservation(showtimeId);

    await db.execute(sql`
      INSERT INTO reservation_seats (reservation_id, seat_id, showtime_id, price_cents)
      VALUES (${first}, ${seatId}, ${showtimeId}, 1000)
    `);

    await expect(
      db.execute(sql`
        INSERT INTO reservation_seats (reservation_id, seat_id, showtime_id, price_cents)
        VALUES (${second}, ${seatId}, ${showtimeId}, 1000)
      `),
    ).rejects.toThrow(/reservation_seats_active_uq/);
  });

  it('lets a released seat be taken again', async () => {
    const { showtimeId, seatId } = await anyShowtimeAndSeat();
    const first = await insertReservation(showtimeId);
    const second = await insertReservation(showtimeId);

    await db.execute(sql`
      INSERT INTO reservation_seats (reservation_id, seat_id, showtime_id, price_cents, released_at)
      VALUES (${first}, ${seatId}, ${showtimeId}, 1000, now())
    `);

    await expect(
      db.execute(sql`
        INSERT INTO reservation_seats (reservation_id, seat_id, showtime_id, price_cents)
        VALUES (${second}, ${seatId}, ${showtimeId}, 1000)
      `),
    ).resolves.toBeDefined();
  });

  it('rejects a status the state machine does not define', async () => {
    const { showtimeId } = await anyShowtimeAndSeat();

    await expect(
      db.execute(sql`
        INSERT INTO reservations (showtime_id, session_id, status, total_price_cents, expires_at)
        VALUES (${showtimeId}, gen_random_uuid(), 'PAID', 100, now() + interval '10 minutes')
      `),
    ).rejects.toThrow(/reservations_status_check/);
  });

  async function anyShowtimeAndSeat(): Promise<{ showtimeId: string; seatId: string }> {
    const result = await db.execute<{ showtime_id: string; seat_id: string }>(sql`
      SELECT sh.id AS showtime_id, se.id AS seat_id
      FROM showtimes sh JOIN seats se ON se.hall_id = sh.hall_id
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error('the seed produced no showtime with seats');
    return { showtimeId: row.showtime_id, seatId: row.seat_id };
  }

  async function insertReservation(showtimeId: string): Promise<string> {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO reservations (showtime_id, session_id, status, total_price_cents, expires_at)
      VALUES (${showtimeId}, gen_random_uuid(), 'PENDING', 1000, now() + interval '10 minutes')
      RETURNING id
    `);
    const id = result.rows[0]?.id;
    if (!id) throw new Error('reservation insert returned no id');
    return id;
  }

  afterEach(async () => {
    await db.execute(sql`TRUNCATE reservations, reservation_seats CASCADE`);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- schema.e2e`
Expected: FAIL — `relation "reservations" does not exist`.

- [ ] **Step 3: Add the tables to the Drizzle schema**

In `apps/api/src/db/schema.ts`, extend the imports and append the tables. Note the new imports: `check` and `primaryKey` from `drizzle-orm/pg-core`, `desc` from `drizzle-orm`.

```ts
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
      sql`${t.status} IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')`,
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
```

Add both to the exported bag at the bottom of the file:

```ts
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
};
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate -w @cinema/api`
Then open the generated `apps/api/drizzle/0002_*.sql` and **read it**. Confirm it creates both tables and both foreign keys.

drizzle-kit's coverage of partial-index predicates and `CHECK` constraints varies by version, so do not assume. If the generated file already contains `WHERE "released_at" IS NULL` on the unique index **and** the `reservations_status_check` constraint, skip Step 5 and delete the reference to `0003` from this task's file list. Otherwise strip any incomplete version of them from `0002` and continue.

- [ ] **Step 5: Hand-write the invariant migration**

This follows the precedent of `0001_showtime_overlap.sql`, which is also hand-written: the constraints that carry the design are the ones worth reading in SQL.

Create `apps/api/drizzle/0003_reservation_invariant.sql`:

```sql
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_status_check"
  CHECK ("status" IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'));

--> statement-breakpoint
-- The no-double-booking invariant. A row with released_at IS NULL means the
-- seat is taken; cancelling or expiring stamps released_at and the seat is free
-- again. Because it is the database that enforces this, no code path -- service,
-- worker, migration or admin console -- can produce a double booking.
CREATE UNIQUE INDEX "reservation_seats_active_uq"
  ON "reservation_seats" ("showtime_id", "seat_id")
  WHERE "released_at" IS NULL;
```

Append the entry to `apps/api/drizzle/meta/_journal.json`, matching the shape of the existing entries (`idx: 3`, `version: "7"`, `tag: "0003_reservation_invariant"`, `breakpoints: true`, and a `when` timestamp greater than the previous entry's).

- [ ] **Step 6: Extend the seed's truncate list**

In `apps/api/src/db/seed.ts`, name the new tables explicitly:

```ts
  await db.execute(
    // reservations and reservation_seats would be swept by CASCADE anyway,
    // through their foreign key to showtimes. Naming them is the difference
    // between a rule you can read and one you have to derive.
    sql`TRUNCATE TABLE reservation_seats, reservations, showtimes, seats, halls, cinemas, movies, seat_categories, users RESTART IDENTITY CASCADE`,
  );
```

- [ ] **Step 7: Add the two configuration values**

In `apps/api/src/config/env.ts`, add to `envSchema`, to `AppConfig`, and to the object `parseEnv` returns:

```ts
  // Section 9 of spec.md gives the user ten minutes to pay. Configurable because
  // the contention tests need it expressed in seconds.
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(600),
  // The contention test must hold more simultaneous transactions than it has
  // clients; at the default of 10 it would measure the connection queue instead
  // of the seat race, and pass for the wrong reason.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
```

```ts
export type AppConfig = {
  // ...existing fields...
  reservationTtlSeconds: number;
  databasePoolMax: number;
};
```

```ts
    reservationTtlSeconds: env.RESERVATION_TTL_SECONDS,
    databasePoolMax: env.DATABASE_POOL_MAX,
```

In `apps/api/src/db/drizzle.module.ts`, feed the pool from config:

```ts
      useFactory: (configService: ConfigService) =>
        new Pool({
          connectionString: configService.config.databaseUrl,
          max: configService.config.databasePoolMax,
        }),
```

Add both variables to `.env.example` with their defaults and a one-line comment each.

- [ ] **Step 8: Run the tests**

Run: `npm test -w @cinema/api -- schema.e2e`
Expected: PASS — all four invariant tests plus the existing schema tests.

- [ ] **Step 9: Verify the config parser still passes and commit**

Run: `npm test -w @cinema/api -- env.test`
Expected: PASS.

```bash
git add apps/api packages/contracts .env.example
git commit -m "feat(api): add reservations schema with the partial unique index invariant"
```

---

## Task 3: The state machine

**Files:**

- Create: `apps/api/src/reservations/state-machine.ts`
- Create: `apps/api/src/reservations/state-machine.test.ts`

**Interfaces:**

- Consumes: `ReservationStatus` from `@cinema/contracts`.
- Produces: `canTransition(from: ReservationStatus, to: ReservationStatus): boolean` and `TERMINAL_STATUSES: ReadonlySet<ReservationStatus>`. Tasks 5 and 7 import both.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/reservations/state-machine.test.ts`:

```ts
import type { ReservationStatus } from '@cinema/contracts';

import { TERMINAL_STATUSES, canTransition } from './state-machine';

describe('canTransition', () => {
  it('allows every exit from PENDING', () => {
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
    expect(canTransition('PENDING', 'EXPIRED')).toBe(true);
  });

  it('treats CONFIRMED, CANCELLED and EXPIRED as terminal', () => {
    const terminal: ReservationStatus[] = ['CONFIRMED', 'CANCELLED', 'EXPIRED'];
    const every: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'];

    for (const from of terminal) {
      for (const to of every) {
        expect(canTransition(from, to)).toBe(false);
      }
    }

    expect(TERMINAL_STATUSES).toEqual(new Set(terminal));
  });

  // A confirmed hold must never be resurrected as pending, and a cancelled one
  // must never be confirmed: both would take a seat that is already free or
  // already sold.
  it('never returns to PENDING', () => {
    expect(canTransition('CONFIRMED', 'PENDING')).toBe(false);
    expect(canTransition('CANCELLED', 'PENDING')).toBe(false);
    expect(canTransition('EXPIRED', 'PENDING')).toBe(false);
  });

  it('rejects a transition to itself', () => {
    expect(canTransition('PENDING', 'PENDING')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- state-machine`
Expected: FAIL — `Cannot find module './state-machine'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/reservations/state-machine.ts`:

```ts
import type { ReservationStatus } from '@cinema/contracts';

/**
 * The graph of legal transitions, in one place. The database's CHECK constraint
 * guards the set of values; this guards the edges between them. Splitting the
 * two is deliberate — SQL expresses the first well and the second badly.
 */
const TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const TERMINAL_STATUSES: ReadonlySet<ReservationStatus> = new Set(
  (Object.keys(TRANSITIONS) as ReservationStatus[]).filter(
    (status) => TRANSITIONS[status].length === 0,
  ),
);

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @cinema/api -- state-machine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/reservations
git commit -m "feat(api): add the reservation state machine"
```

---

## Task 4: Domain errors and problem-details extensions

**Files:**

- Modify: `apps/api/src/http/errors.ts`
- Modify: `apps/api/src/http/problem-details.filter.ts`
- Create: `apps/api/src/http/errors.test.ts`

**Interfaces:**

- Consumes: the existing `DomainError` base class.
- Produces: `MissingSessionError`, `SeatsNotInHallError`, `SeatsUnavailableError`, `ShowtimeAlreadyStartedError`, `ReservationExpiredError`, `InvalidStateTransitionError`; and an optional `extensions` getter on `DomainError` that the filter merges into the problem document. Tasks 5–8 throw these.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/http/errors.test.ts`:

```ts
import {
  InvalidStateTransitionError,
  MissingSessionError,
  ReservationExpiredError,
  SeatsNotInHallError,
  SeatsUnavailableError,
  ShowtimeAlreadyStartedError,
} from './errors';

describe('reservation domain errors', () => {
  it('reports a lost race as 409 and names the seats that were lost', () => {
    const error = new SeatsUnavailableError([
      { seatId: '019298a1-7c4e-7c3a-8f21-000000000001', label: 'C7' },
      { seatId: '019298a1-7c4e-7c3a-8f21-000000000002', label: 'C8' },
    ]);

    expect(error.status).toBe(409);
    expect(error.typeSlug).toBe('seats-unavailable');
    expect(error.message).toContain('C7, C8');
    expect(error.extensions).toEqual({
      seatIds: [
        '019298a1-7c4e-7c3a-8f21-000000000001',
        '019298a1-7c4e-7c3a-8f21-000000000002',
      ],
    });
  });

  it('maps each remaining failure to its status', () => {
    expect(new MissingSessionError().status).toBe(400);
    expect(new SeatsNotInHallError(['C7']).status).toBe(400);
    expect(new ShowtimeAlreadyStartedError('019298a1').status).toBe(409);
    expect(new ReservationExpiredError('019298a1').status).toBe(409);
    expect(new InvalidStateTransitionError('CONFIRMED', 'CANCELLED').status).toBe(409);
  });

  it('explains which transition was refused', () => {
    const error = new InvalidStateTransitionError('CONFIRMED', 'CANCELLED');
    expect(error.message).toContain('CONFIRMED');
    expect(error.message).toContain('CANCELLED');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- errors.test`
Expected: FAIL — the new classes are not exported.

- [ ] **Step 3: Add the extensions hook to the base class**

In `apps/api/src/http/errors.ts`, add to `DomainError`:

```ts
  /**
   * RFC 9457 extension members merged into the problem document. Machine-
   * readable detail belongs here rather than parsed out of `detail`, which is
   * prose meant for a human.
   */
  get extensions(): Record<string, unknown> | undefined {
    return undefined;
  }
```

- [ ] **Step 4: Add the six error classes**

Append to `apps/api/src/http/errors.ts`:

```ts
export class MissingSessionError extends DomainError {
  readonly status = 400;
  readonly typeSlug = 'missing-session';
  readonly title = 'Session required';

  constructor() {
    super('This endpoint requires an X-Session-Id header carrying a UUID');
  }
}

export class SeatsNotInHallError extends DomainError {
  readonly status = 400;
  readonly typeSlug = 'seats-not-in-hall';
  readonly title = 'Seats do not belong to this showtime';

  constructor(seatIds: string[]) {
    super(`Seats ${seatIds.join(', ')} are not in the hall this showtime plays in`);
  }
}

export class ShowtimeAlreadyStartedError extends DomainError {
  readonly status = 409;
  readonly typeSlug = 'showtime-already-started';
  readonly title = 'Showtime already started';

  constructor(showtimeId: string) {
    super(`Showtime ${showtimeId} has already started and can no longer be booked`);
  }
}

export class ReservationExpiredError extends DomainError {
  readonly status = 409;
  readonly typeSlug = 'reservation-expired';
  readonly title = 'Reservation expired';

  constructor(reservationId: string) {
    super(`Reservation ${reservationId} expired before it was confirmed`);
  }
}

export class InvalidStateTransitionError extends DomainError {
  readonly status = 409;
  readonly typeSlug = 'invalid-state-transition';
  readonly title = 'Invalid reservation state transition';

  constructor(from: string, to: string) {
    super(`A reservation in state ${from} cannot become ${to}`);
  }
}

/**
 * The lost race. Carries the seat ids as an extension member so the seat map can
 * highlight exactly the seats that were taken rather than re-fetching and
 * guessing at the difference.
 */
export class SeatsUnavailableError extends DomainError {
  readonly status = 409;
  readonly typeSlug = 'seats-unavailable';
  readonly title = 'Seats unavailable';

  constructor(private readonly lost: { seatId: string; label: string }[]) {
    super(
      `Seats ${lost.map((seat) => seat.label).join(', ')} were taken by another reservation`,
    );
  }

  override get extensions(): Record<string, unknown> {
    return { seatIds: this.lost.map((seat) => seat.seatId) };
  }
}
```

- [ ] **Step 5: Merge extensions in the filter**

In `apps/api/src/http/problem-details.filter.ts`, in the `DomainError` branch of `toProblem`:

```ts
    if (exception instanceof DomainError) {
      return {
        type: `${base}/${exception.typeSlug}`,
        title: exception.title,
        status: exception.status,
        detail: exception.message,
        instance,
        traceId,
        ...exception.extensions,
      };
    }
```

- [ ] **Step 6: Run the tests**

Run: `npm test -w @cinema/api -- errors.test problem-details`
Expected: PASS, including the existing `problem-details.e2e.spec.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http
git commit -m "feat(api): add reservation domain errors with problem-details extensions"
```

---

## Task 5: Session identification and the shared test cleanup helper

**Files:**

- Create: `apps/api/src/http/session.decorator.ts`
- Create: `apps/api/src/http/session.test.ts`
- Create: `apps/api/test/truncate.ts`
- Create: `apps/api/test/reservation-harness.ts`

**Interfaces:**

- Consumes: `MissingSessionError` from Task 4.
- Produces: `readSessionId(header: unknown): string` (throws `MissingSessionError`), `readOptionalSessionId(header: unknown): string | null`, the parameter decorators `@SessionId()` and `@OptionalSessionId()`, and `SESSION_HEADER = 'x-session-id'`. Also `truncateReservations(db)` and `startReservationHarness()`, which Tasks 6, 7, 9 and 10 all build on.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/http/session.test.ts`:

```ts
import { MissingSessionError } from './errors';
import { readOptionalSessionId, readSessionId } from './session.decorator';

const VALID = '019298a1-7c4e-7c3a-8f21-000000000001';

describe('readSessionId', () => {
  it('returns a well-formed uuid', () => {
    expect(readSessionId(VALID)).toBe(VALID);
  });

  it('rejects a missing header', () => {
    expect(() => readSessionId(undefined)).toThrow(MissingSessionError);
  });

  // A caller sending junk gets the same answer as one sending nothing: without a
  // usable session there is no reservation to act on either way.
  it('rejects a header that is not a uuid', () => {
    expect(() => readSessionId('session-42')).toThrow(MissingSessionError);
  });

  it('rejects an array of headers', () => {
    expect(() => readSessionId([VALID, VALID])).toThrow(MissingSessionError);
  });
});

describe('readOptionalSessionId', () => {
  it('returns null rather than throwing when absent', () => {
    expect(readOptionalSessionId(undefined)).toBeNull();
  });

  it('returns null for a malformed value', () => {
    expect(readOptionalSessionId('nonsense')).toBeNull();
  });

  it('returns the uuid when present', () => {
    expect(readOptionalSessionId(VALID)).toBe(VALID);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- session.test`
Expected: FAIL — `Cannot find module './session.decorator'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/http/session.decorator.ts`:

```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { MissingSessionError } from './errors';

export const SESSION_HEADER = 'x-session-id';

const sessionIdSchema = z.uuid();

/** Required: every reservation endpoint needs to know whose reservation this is. */
export function readSessionId(header: unknown): string {
  const parsed = sessionIdSchema.safeParse(header);
  if (!parsed.success) throw new MissingSessionError();
  return parsed.data;
}

/**
 * Optional: the seat map stays public. Without a session every seat simply
 * reads `heldByYou: false`, which is true — an anonymous caller holds nothing.
 */
export function readOptionalSessionId(header: unknown): string | null {
  const parsed = sessionIdSchema.safeParse(header);
  return parsed.success ? parsed.data : null;
}

export const SessionId = createParamDecorator((_data: unknown, context: ExecutionContext): string =>
  readSessionId(context.switchToHttp().getRequest<FastifyRequest>().headers[SESSION_HEADER]),
);

export const OptionalSessionId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    readOptionalSessionId(
      context.switchToHttp().getRequest<FastifyRequest>().headers[SESSION_HEADER],
    ),
);
```

- [ ] **Step 4: Write the test cleanup helper**

Create `apps/api/test/truncate.ts`:

```ts
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
```

- [ ] **Step 5: Write the shared reservation harness**

Four test files need the same app, the same future showtime, and the same seats. Building that four times invites four subtly different setups.

Create `apps/api/test/reservation-harness.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { reservationSchema, type Reservation } from '@cinema/contracts';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { InjectOptions, LightMyRequestResponse } from 'light-my-request';
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

  const hold: ReservationHarness['hold'] = (seatsToHold, session = randomUUID(), showtime = showtimeId) =>
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
```

- [ ] **Step 6: Run the tests**

Run: `npm test -w @cinema/api -- session.test`
Expected: PASS. `reservation-harness.ts` has no test of its own — Tasks 6, 7, 9 and 10 exercise it.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/session.decorator.ts apps/api/src/http/session.test.ts apps/api/test/truncate.ts apps/api/test/reservation-harness.ts
git commit -m "feat(api): identify callers by anonymous session id"
```

---

## Task 6: Taking a hold — the contention core

This is the task the sub-project exists for. Read spec §4 in full before starting.

**Files:**

- Create: `apps/api/src/reservations/reservation.service.ts`
- Create: `apps/api/test/reservations.e2e.spec.ts`

**Interfaces:**

- Consumes: `canTransition` (Task 3); the errors from Task 4; `CatalogService.getShowtime(id, executor)`; `DRIZZLE`, `Database`, `Executor`; `truncateReservations` (Task 5).
- Produces: `ReservationService.create(sessionId: string, input: CreateReservation): Promise<Reservation>`. Task 7 adds `get`, `list`, `cancel` and `confirm` to the same class; Task 8 wires the controller.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/reservations.e2e.spec.ts`, built on the harness from Task 5.

```ts
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, reservationSchema } from '@cinema/contracts';
import { sql } from 'drizzle-orm';

import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('reservations: taking a hold', () => {
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  // Phase 1's suites only read, so seeding once per file was enough. These
  // write, and a hold left behind changes the next test's answer.
  beforeEach(async () => {
    await truncateReservations(h.db);
  });

  it('creates a pending hold priced from the showtime and the seat category', async () => {
    const response = await h.hold(h.seatIds.slice(0, 2));

    expect(response.statusCode).toBe(201);
    const reservation = reservationSchema.parse(response.json());
    expect(reservation.status).toBe('PENDING');
    expect(reservation.seats).toHaveLength(2);
    expect(reservation.totalPriceCents).toBe(
      reservation.seats.reduce((sum, seat) => sum + seat.priceCents, 0),
    );
    expect(reservation.seats[0]?.rowLabel).toEqual(expect.any(String));
    expect(new Date(reservation.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a seat already held, naming it in the problem document', async () => {
    await h.hold(h.seatIds.slice(0, 1));

    const response = await h.hold(h.seatIds.slice(0, 1));

    expect(response.statusCode).toBe(409);
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.type).toMatch(/seats-unavailable$/);
    expect(problem.seatIds).toEqual([h.seatIds[0]]);
  });

  // All-or-nothing: a partial hold would leave the user with seats they never
  // chose and no screen able to explain it.
  it('holds nothing when one seat of several is taken', async () => {
    await h.hold([h.seatIds[2]!]);

    const response = await h.hold([h.seatIds[3]!, h.seatIds[2]!, h.seatIds[4]!]);

    expect(response.statusCode).toBe(409);
    const remaining = await h.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM reservation_seats WHERE released_at IS NULL`,
    );
    expect(remaining.rows[0]?.n).toBe('1');
  });

  it('releases an expired hold to the next caller without any sweeper running', async () => {
    const first = await h.holdOne(h.seatIds[5]!);
    await h.db.execute(
      sql`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${first.id}`,
    );

    const response = await h.hold([h.seatIds[5]!]);

    expect(response.statusCode).toBe(201);
    const superseded = await h.db.execute<{ status: string }>(
      sql`SELECT status FROM reservations WHERE id = ${first.id}`,
    );
    expect(superseded.rows[0]?.status).toBe('EXPIRED');
  });

  it('rejects a seat from another hall', async () => {
    const foreign = await h.db.execute<{ id: string }>(sql`
      SELECT se.id FROM seats se
      WHERE se.hall_id <> (SELECT hall_id FROM showtimes WHERE id = ${h.showtimeId})
      LIMIT 1
    `);

    const response = await h.hold([foreign.rows[0]!.id]);

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/seats-not-in-hall$/);
  });

  it('rejects a showtime that has already started', async () => {
    const past = await h.db.execute<{ id: string }>(sql`
      SELECT id FROM showtimes WHERE starts_at < now() ORDER BY starts_at DESC LIMIT 1
    `);
    const pastId = past.rows[0]?.id;
    if (!pastId) throw new Error('the seed window must include at least one past showtime');

    const seats = await h.db.execute<{ id: string }>(sql`
      SELECT se.id FROM seats se JOIN showtimes sh ON sh.hall_id = se.hall_id
      WHERE sh.id = ${pastId} LIMIT 1
    `);

    const response = await h.hold([seats.rows[0]!.id], randomUUID(), pastId);

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/showtime-already-started$/);
  });

  it('requires a session header', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reservations',
      payload: { showtimeId: h.showtimeId, seatIds: h.seatIds.slice(0, 1) },
    });

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/missing-session$/);
  });

  it('rejects a repeated seat id before it reaches the database', async () => {
    const response = await h.hold([h.seatIds[6]!, h.seatIds[6]!]);

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/validation-failed$/);
  });

  it('rejects more than ten seats', async () => {
    const response = await h.hold(h.seatIds.slice(0, 11));

    expect(response.statusCode).toBe(400);
  });

  it('answers 404 for a showtime that does not exist', async () => {
    const response = await h.hold(
      h.seatIds.slice(0, 1),
      randomUUID(),
      '019298a1-7c4e-7c3a-8f21-0000000000ff',
    );

    expect(response.statusCode).toBe(404);
  });
});
```

Check the seed before writing the "already started" test: if `SEED_START_DATE` and `SEED_DAYS` place every showtime in the future, that test has nothing to select. If so, extend the seed by one past day rather than deleting the test — a showtime that has started is a real state the API must refuse.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- reservations.e2e`
Expected: FAIL — every case answers 404, because `POST /api/v1/reservations` is not routed yet. That is expected: Task 8 mounts the controller, and this test only passes at the end of Task 8. Confirm the failure is a routing 404 and not a crash in `beforeAll`, then continue.

- [ ] **Step 3: Write the service**

Create `apps/api/src/reservations/reservation.service.ts`. The spec shows the stale-hold release as one CTE for exposition; implement it as three statements inside the transaction — the atomicity comes from the transaction either way, and this version is type-checked and reads like the rest of the codebase.

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { CreateReservation, Reservation, ReservationSeat } from '@cinema/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { CatalogService } from '../catalog/catalog.service';
import { ConfigService } from '../config/config.service';
import { DRIZZLE, type Database, type Executor } from '../db/drizzle.module';
import { reservationSeats, reservations, seatCategories, seats } from '../db/schema';
import {
  SeatsNotInHallError,
  SeatsUnavailableError,
  ShowtimeAlreadyStartedError,
} from '../http/errors';

interface SeatRow {
  id: string;
  rowLabel: string;
  seatNumber: number;
  category: ReservationSeat['category'];
  priceCents: number;
}

@Injectable()
export class ReservationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalog: CatalogService,
    private readonly configService: ConfigService,
  ) {}

  async create(sessionId: string, input: CreateReservation): Promise<Reservation> {
    return this.db.transaction(async (tx) => {
      const showtime = await this.catalog.getShowtime(input.showtimeId, tx);

      // The database's clock, not the process's: two clocks that disagree
      // produce a bug that only appears under load.
      const clock = await tx.execute<{ started: boolean }>(
        sql`SELECT (${showtime.startsAt}::timestamptz <= now()) AS started`,
      );
      if (clock.rows[0]?.started) throw new ShowtimeAlreadyStartedError(showtime.id);

      const seatRows = await this.loadSeats(
        tx,
        showtime.hallId,
        showtime.basePriceCents,
        input.seatIds,
      );
      if (seatRows.length !== input.seatIds.length) {
        const found = new Set(seatRows.map((row) => row.id));
        throw new SeatsNotInHallError(input.seatIds.filter((id) => !found.has(id)));
      }

      await this.releaseStaleHolds(tx, input.showtimeId, input.seatIds);

      const totalPriceCents = seatRows.reduce((sum, row) => sum + row.priceCents, 0);
      const ttl = this.configService.config.reservationTtlSeconds;

      const [reservation] = await tx
        .insert(reservations)
        .values({
          showtimeId: input.showtimeId,
          sessionId,
          status: 'PENDING',
          totalPriceCents,
          expiresAt: sql`now() + make_interval(secs => ${ttl})`,
        })
        .returning({
          id: reservations.id,
          expiresAt: reservations.expiresAt,
          createdAt: reservations.createdAt,
        });

      // Sorted by seat id so every transaction takes its rows in the same
      // order. Without this, two overlapping requests can wait on each other
      // crosswise and Postgres kills one with a deadlock (40P01) -- a 500 where
      // the caller had earned an honest 409.
      const ordered = [...seatRows].sort((a, b) => (a.id < b.id ? -1 : 1));

      const won = await tx
        .insert(reservationSeats)
        .values(
          ordered.map((row) => ({
            reservationId: reservation!.id,
            seatId: row.id,
            showtimeId: input.showtimeId,
            priceCents: row.priceCents,
          })),
        )
        .onConflictDoNothing()
        .returning({ seatId: reservationSeats.seatId });

      if (won.length !== ordered.length) {
        const kept = new Set(won.map((row) => row.seatId));
        // Rolling back discards the rows we did win, so the loser leaves no
        // partial hold behind.
        throw new SeatsUnavailableError(
          ordered
            .filter((row) => !kept.has(row.id))
            .map((row) => ({ seatId: row.id, label: `${row.rowLabel}${row.seatNumber}` })),
        );
      }

      return {
        id: reservation!.id,
        showtimeId: input.showtimeId,
        status: 'PENDING',
        totalPriceCents,
        expiresAt: reservation!.expiresAt.toISOString(),
        createdAt: reservation!.createdAt.toISOString(),
        seats: ordered.map((row) => ({
          seatId: row.id,
          rowLabel: row.rowLabel,
          seatNumber: row.seatNumber,
          category: row.category,
          priceCents: row.priceCents,
        })),
      };
    });
  }

  /**
   * Seats of this hall only: a seat from another hall must neither price nor
   * hold. The price is quoted here and stored on the row, so it survives a
   * later change to the showtime's base price.
   */
  private async loadSeats(
    executor: Executor,
    hallId: string,
    basePriceCents: number,
    seatIds: string[],
  ): Promise<SeatRow[]> {
    const rows = await executor
      .select({
        id: seats.id,
        rowLabel: seats.rowLabel,
        seatNumber: seats.seatNumber,
        category: seats.categoryCode,
        surchargeCents: seatCategories.surchargeCents,
      })
      .from(seats)
      .innerJoin(seatCategories, eq(seatCategories.code, seats.categoryCode))
      .where(and(eq(seats.hallId, hallId), inArray(seats.id, seatIds)))
      .orderBy(asc(seats.rowLabel), asc(seats.seatNumber));

    return rows.map((row) => ({
      id: row.id,
      rowLabel: row.rowLabel,
      seatNumber: row.seatNumber,
      category: row.category as SeatRow['category'],
      priceCents: basePriceCents + row.surchargeCents,
    }));
  }

  /**
   * Lazy expiry, scoped to the seats this request wants. Sweeping the whole
   * showtime would make every hold on a busy screening write to the same rows --
   * a contention point invented for no reason.
   */
  private async releaseStaleHolds(
    executor: Executor,
    showtimeId: string,
    seatIds: string[],
  ): Promise<void> {
    const stale = await executor
      .selectDistinct({ id: reservations.id })
      .from(reservations)
      .innerJoin(reservationSeats, eq(reservationSeats.reservationId, reservations.id))
      .where(
        and(
          eq(reservationSeats.showtimeId, showtimeId),
          inArray(reservationSeats.seatId, seatIds),
          isNull(reservationSeats.releasedAt),
          eq(reservations.status, 'PENDING'),
          sql`${reservations.expiresAt} <= now()`,
        ),
      );

    if (stale.length === 0) return;
    const ids = stale.map((row) => row.id);

    await executor
      .update(reservations)
      .set({ status: 'EXPIRED', updatedAt: sql`now()` })
      .where(and(inArray(reservations.id, ids), eq(reservations.status, 'PENDING')));

    await executor
      .update(reservationSeats)
      .set({ releasedAt: sql`now()` })
      .where(and(inArray(reservationSeats.reservationId, ids), isNull(reservationSeats.releasedAt)));
  }
}
```

- [ ] **Step 4: Verify the file typechecks**

Run: `npm run typecheck -w @cinema/api`
Expected: PASS. The service is not yet reachable over HTTP — Task 8 mounts it.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/reservations/reservation.service.ts apps/api/test/reservations.e2e.spec.ts
git commit -m "feat(api): hold seats in one transaction guarded by the unique index"
```

---

## Task 7: Reading, cancelling and confirming

**Files:**

- Modify: `apps/api/src/reservations/reservation.service.ts`
- Modify: `apps/api/test/reservations.e2e.spec.ts`

**Interfaces:**

- Consumes: everything from Task 6, plus `canTransition` and `TERMINAL_STATUSES` (Task 3), `ReservationExpiredError`, `InvalidStateTransitionError`, `ResourceNotFoundError`.
- Produces: `get(sessionId, id)`, `list(sessionId, query)`, `cancel(sessionId, id)`, `confirm(sessionId, id)` on `ReservationService`.

- [ ] **Step 1: Write the failing test**

Append a second top-level `describe` to `apps/api/test/reservations.e2e.spec.ts`, with its own harness instance:

```ts
describe('reservations: lifecycle and ownership', () => {
  const session = randomUUID();
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db);
  });

  const holdOne = (seat: string, owner = session) => h.holdOne(seat, owner);
  const act = (method: 'GET' | 'DELETE' | 'POST', path: string, owner = session) =>
    h.act(method, path, owner);

  it('reads back a hold with its seats', async () => {
    const created = await holdOne(h.seatIds[0]!);

    const response = await act('GET', `/${created.id}`);

    expect(response.statusCode).toBe(200);
    expect(reservationSchema.parse(response.json()).id).toBe(created.id);
  });

  it('lists only this session, newest first', async () => {
    await holdOne(h.seatIds[0]!);
    await holdOne(h.seatIds[1]!);
    await holdOne(h.seatIds[2]!, randomUUID());

    const page = reservationPageSchema.parse((await act('GET', '')).json());

    expect(page.data).toHaveLength(2);
    expect(new Date(page.data[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(page.data[1]!.createdAt).getTime(),
    );
  });

  it('confirms a pending hold', async () => {
    const created = await holdOne(h.seatIds[3]!);

    const response = await act('POST', `/${created.id}/confirm`);

    expect(response.statusCode).toBe(200);
    expect(reservationSchema.parse(response.json()).status).toBe('CONFIRMED');
  });

  it('cancels a pending hold and frees the seat', async () => {
    const created = await holdOne(h.seatIds[4]!);

    expect((await act('DELETE', `/${created.id}`)).statusCode).toBe(204);

    const retaken = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reservations',
      headers: { 'x-session-id': randomUUID() },
      payload: { showtimeId: h.showtimeId, seatIds: [h.seatIds[4]!] },
    });
    expect(retaken.statusCode).toBe(201);
  });

  // The user asked for the seats to be released and they are released. An error
  // here would report a problem that does not exist.
  it('treats cancelling twice as success', async () => {
    const created = await holdOne(h.seatIds[5]!);
    await act('DELETE', `/${created.id}`);

    expect((await act('DELETE', `/${created.id}`)).statusCode).toBe(204);
  });

  it('refuses to cancel a confirmed reservation', async () => {
    const created = await holdOne(h.seatIds[6]!);
    await act('POST', `/${created.id}/confirm`);

    const response = await act('DELETE', `/${created.id}`);

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/invalid-state-transition$/);
  });

  it('refuses to confirm a hold that expired while the page was open', async () => {
    const created = await holdOne(h.seatIds[7]!);
    await h.db.execute(
      sql`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${created.id}`,
    );

    const response = await act('POST', `/${created.id}/confirm`);

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/reservation-expired$/);

    // Whoever discovers the expiry records it, and the seat is free again.
    const after = await h.db.execute<{ status: string }>(
      sql`SELECT status FROM reservations WHERE id = ${created.id}`,
    );
    expect(after.rows[0]?.status).toBe('EXPIRED');
  });

  it('resolves a confirm racing a cancel to exactly one winner', async () => {
    const created = await holdOne(h.seatIds[8]!);

    const [confirmed, cancelled] = await Promise.all([
      act('POST', `/${created.id}/confirm`),
      act('DELETE', `/${created.id}`),
    ]);

    const codes = [confirmed.statusCode, cancelled.statusCode].sort();
    // Either the confirm lands first (200) and the cancel is refused (409), or
    // the cancel lands first (204) and the confirm is refused (409).
    expect(codes).toEqual(expect.arrayContaining([409]));
    expect(codes.filter((code) => code < 300)).toHaveLength(1);
  });

  // 403 would confirm the id exists. 404 is also simply true from where the
  // caller stands: it is not among their reservations.
  it('hides another session’s reservation behind 404', async () => {
    const created = await holdOne(h.seatIds[9]!, randomUUID());

    expect((await act('GET', `/${created.id}`)).statusCode).toBe(404);
    expect((await act('DELETE', `/${created.id}`)).statusCode).toBe(404);
    expect((await act('POST', `/${created.id}/confirm`)).statusCode).toBe(404);
  });
});
```

Add `reservationPageSchema` to the file's imports from `@cinema/contracts`, and `startReservationHarness`, `type ReservationHarness` from `./reservation-harness`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- reservations.e2e`
Expected: FAIL — still unrouted until Task 8.

- [ ] **Step 3: Add the read methods**

Append to `ReservationService`:

```ts
  async get(sessionId: string, id: string, executor: Executor = this.db): Promise<Reservation> {
    const [row] = await executor
      .select()
      .from(reservations)
      .where(and(eq(reservations.id, id), eq(reservations.sessionId, sessionId)))
      .limit(1);

    if (!row) throw new ResourceNotFoundError('Reservation', id);
    return this.hydrate(executor, row);
  }

  async list(sessionId: string, query: PaginationQuery): Promise<Page<Reservation>> {
    const filters = [eq(reservations.sessionId, sessionId)];
    if (query.cursor) {
      const [createdAt, id] = decodeTimestampIdCursor(query.cursor);
      filters.push(
        sql`(${reservations.createdAt}, ${reservations.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
      );
    }

    const rows = await this.db
      .select()
      .from(reservations)
      .where(and(...filters))
      .orderBy(desc(reservations.createdAt), desc(reservations.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const data = await Promise.all(page.map((row) => this.hydrate(this.db, row)));
    const last = page.at(-1);

    return {
      data,
      nextCursor:
        hasMore && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null,
    };
  }

  /** One reservation row plus its seats, in the shape the contract promises. */
  private async hydrate(
    executor: Executor,
    row: typeof reservations.$inferSelect,
  ): Promise<Reservation> {
    const seatRows = await executor
      .select({
        seatId: reservationSeats.seatId,
        rowLabel: seats.rowLabel,
        seatNumber: seats.seatNumber,
        category: seats.categoryCode,
        priceCents: reservationSeats.priceCents,
      })
      .from(reservationSeats)
      .innerJoin(seats, eq(seats.id, reservationSeats.seatId))
      .where(eq(reservationSeats.reservationId, row.id))
      .orderBy(asc(seats.rowLabel), asc(seats.seatNumber));

    return {
      id: row.id,
      showtimeId: row.showtimeId,
      status: row.status as Reservation['status'],
      totalPriceCents: row.totalPriceCents,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      seats: seatRows.map((seat) => ({
        ...seat,
        category: seat.category as ReservationSeat['category'],
      })),
    };
  }
```

Add the imports this needs: `desc` from `drizzle-orm`; `Page`, `PaginationQuery` types from `@cinema/contracts`; `ResourceNotFoundError` from `../http/errors`; `decodeTimestampIdCursor`, `encodeCursor` from `../catalog/cursor`.

- [ ] **Step 4: Add cancel and confirm**

Both take the row lock first. Without it, a confirm and a cancel arriving together both read `PENDING` and both write their own ending.

```ts
  async confirm(sessionId: string, id: string): Promise<Reservation> {
    return this.db.transaction(async (tx) => {
      const row = await this.lockOwned(tx, sessionId, id);

      if (row.status === 'PENDING' && row.expired) {
        await this.expire(tx, id);
        throw new ReservationExpiredError(id);
      }
      if (!canTransition(row.status, 'CONFIRMED')) {
        throw new InvalidStateTransitionError(row.status, 'CONFIRMED');
      }

      await tx
        .update(reservations)
        .set({ status: 'CONFIRMED', confirmedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(reservations.id, id));

      return this.get(sessionId, id, tx);
    });
  }

  async cancel(sessionId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lockOwned(tx, sessionId, id);

      // Cancelling is idempotent. The caller asked for the seats to be released;
      // for a reservation that already ended, they are.
      if (row.status === 'CANCELLED' || row.status === 'EXPIRED') return;
      if (row.status === 'PENDING' && row.expired) {
        await this.expire(tx, id);
        return;
      }
      if (!canTransition(row.status, 'CANCELLED')) {
        throw new InvalidStateTransitionError(row.status, 'CANCELLED');
      }

      await tx
        .update(reservations)
        .set({ status: 'CANCELLED', cancelledAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(reservations.id, id));
      await this.releaseSeatsOf(tx, id);
    });
  }

  /**
   * `FOR UPDATE` is the one pessimistic lock in this sub-project, and it guards
   * a single row against its own concurrent endings -- not against the seat race,
   * which the unique index already settles.
   */
  private async lockOwned(
    executor: Executor,
    sessionId: string,
    id: string,
  ): Promise<{ status: Reservation['status']; expired: boolean }> {
    const [row] = await executor
      .select({
        status: reservations.status,
        expired: sql<boolean>`${reservations.expiresAt} <= now()`,
      })
      .from(reservations)
      .where(and(eq(reservations.id, id), eq(reservations.sessionId, sessionId)))
      .limit(1)
      .for('update');

    if (!row) throw new ResourceNotFoundError('Reservation', id);
    return { status: row.status as Reservation['status'], expired: row.expired };
  }

  private async expire(executor: Executor, id: string): Promise<void> {
    await executor
      .update(reservations)
      .set({ status: 'EXPIRED', updatedAt: sql`now()` })
      .where(eq(reservations.id, id));
    await this.releaseSeatsOf(executor, id);
  }

  private async releaseSeatsOf(executor: Executor, reservationId: string): Promise<void> {
    await executor
      .update(reservationSeats)
      .set({ releasedAt: sql`now()` })
      .where(
        and(
          eq(reservationSeats.reservationId, reservationId),
          isNull(reservationSeats.releasedAt),
        ),
      );
  }
```

Add `canTransition` from `./state-machine` and the two new errors to the imports.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @cinema/api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/reservations apps/api/test/reservations.e2e.spec.ts
git commit -m "feat(api): read, cancel and confirm reservations under a row lock"
```

---

## Task 8: Controller, module, and OpenAPI

**Files:**

- Create: `apps/api/src/reservations/reservation.controller.ts`
- Create: `apps/api/src/reservations/reservation.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/catalog/catalog.module.ts`
- Modify: `apps/api/src/openapi/routes.ts`
- Modify: `apps/api/test/openapi.e2e.spec.ts`

**Interfaces:**

- Consumes: `ReservationService` (Tasks 6–7), `@SessionId()` (Task 5), the contracts from Task 1.
- Produces: five routed endpoints. `RouteDoc` gains `method: 'get' | 'post' | 'delete'`, an optional `body?: z.ZodType`, and an optional `requiresSession?: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/openapi.e2e.spec.ts`, following the assertions already in that file:

```ts
  it('documents the reservation endpoints with their bodies', () => {
    expect(document.paths['/api/v1/reservations']?.post).toBeDefined();
    expect(document.paths['/api/v1/reservations/{id}']?.delete).toBeDefined();
    expect(document.paths['/api/v1/reservations/{id}/confirm']?.post).toBeDefined();

    const create = document.paths['/api/v1/reservations']?.post;
    expect(create?.requestBody).toBeDefined();
    expect(create?.responses['409']).toBeDefined();
  });
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- openapi.e2e`
Expected: FAIL — the reservation paths are absent from the document.

- [ ] **Step 3: Write the controller**

Create `apps/api/src/reservations/reservation.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  createReservationSchema,
  idParamSchema,
  paginationQuerySchema,
  reservationPageSchema,
  reservationSchema,
  type CreateReservation,
  type IdParam,
  type Page,
  type PaginationQuery,
  type Reservation,
} from '@cinema/contracts';

import { SessionId } from '../http/session.decorator';
import { Validated } from '../http/validated.decorator';
import { zodPipe } from '../http/zod-validation.pipe';
import { ReservationService } from './reservation.service';

@Controller({ path: 'reservations', version: '1' })
export class ReservationController {
  constructor(private readonly reservations: ReservationService) {}

  @Post()
  @Validated(reservationSchema)
  create(
    @SessionId() sessionId: string,
    @Body(zodPipe(createReservationSchema)) body: CreateReservation,
  ): Promise<Reservation> {
    return this.reservations.create(sessionId, body);
  }

  @Get()
  @Validated(reservationPageSchema)
  list(
    @SessionId() sessionId: string,
    @Query(zodPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<Reservation>> {
    return this.reservations.list(sessionId, query);
  }

  @Get(':id')
  @Validated(reservationSchema)
  get(
    @SessionId() sessionId: string,
    @Param(zodPipe(idParamSchema)) params: IdParam,
  ): Promise<Reservation> {
    return this.reservations.get(sessionId, params.id);
  }

  @Delete(':id')
  @HttpCode(204)
  cancel(
    @SessionId() sessionId: string,
    @Param(zodPipe(idParamSchema)) params: IdParam,
  ): Promise<void> {
    return this.reservations.cancel(sessionId, params.id);
  }

  @Post(':id/confirm')
  @Validated(reservationSchema)
  confirm(
    @SessionId() sessionId: string,
    @Param(zodPipe(idParamSchema)) params: IdParam,
  ): Promise<Reservation> {
    return this.reservations.confirm(sessionId, params.id);
  }
}
```

- [ ] **Step 4: Write the module and register it**

Create `apps/api/src/reservations/reservation.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';

@Module({
  imports: [CatalogModule],
  controllers: [ReservationController],
  providers: [ReservationService],
})
export class ReservationModule {}
```

`ReservationService` injects `CatalogService`, so `CatalogModule` must export it. Open `apps/api/src/catalog/catalog.module.ts` and add `exports: [CatalogService]` if it is not already there.

Add `ReservationModule` to the `imports` array in `apps/api/src/app.module.ts`.

- [ ] **Step 5: Extend the OpenAPI route table**

In `apps/api/src/openapi/routes.ts`, widen the interface and append the routes:

```ts
export interface RouteDoc {
  method: 'get' | 'post' | 'delete';
  /** OpenAPI path template, with `{id}` where Nest writes `:id`. */
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  pathParams: string[];
  query?: z.ZodType;
  body?: z.ZodType;
  /** Documents the `X-Session-Id` header as a required parameter. */
  requiresSession?: boolean;
  /** `undefined` for 204 responses, which carry no body. */
  response?: z.ZodType;
  errors: number[];
}
```

```ts
  {
    method: 'post',
    path: '/api/v1/reservations',
    operationId: 'createReservation',
    summary: 'Hold seats for a showtime',
    tags: ['reservations'],
    pathParams: [],
    body: createReservationSchema,
    requiresSession: true,
    response: reservationSchema,
    errors: [400, 404, 409],
  },
  {
    method: 'get',
    path: '/api/v1/reservations',
    operationId: 'listReservations',
    summary: "List this session's reservations, newest first",
    tags: ['reservations'],
    pathParams: [],
    query: paginationQuerySchema,
    requiresSession: true,
    response: reservationPageSchema,
    errors: [400],
  },
  {
    method: 'get',
    path: '/api/v1/reservations/{id}',
    operationId: 'getReservation',
    summary: 'Fetch one reservation of this session',
    tags: ['reservations'],
    pathParams: ID_PARAM,
    requiresSession: true,
    response: reservationSchema,
    errors: [400, 404],
  },
  {
    method: 'delete',
    path: '/api/v1/reservations/{id}',
    operationId: 'cancelReservation',
    summary: 'Cancel a reservation and release its seats',
    tags: ['reservations'],
    pathParams: ID_PARAM,
    requiresSession: true,
    errors: [400, 404, 409],
  },
  {
    method: 'post',
    path: '/api/v1/reservations/{id}/confirm',
    operationId: 'confirmReservation',
    summary: 'Confirm a pending reservation',
    tags: ['reservations'],
    pathParams: ID_PARAM,
    requiresSession: true,
    response: reservationSchema,
    errors: [400, 404, 409],
  },
```

Import `createReservationSchema`, `reservationSchema` and `reservationPageSchema` at the top of the file.

- [ ] **Step 6: Teach the document builder the new fields**

In `apps/api/src/openapi/document.ts`, four changes. The first is a latent bug that only appears now: `/api/v1/reservations` has both a `GET` and a `POST`, and the current loop assigns `paths[route.path] = { get: ... }`, so the second route silently erases the first.

```ts
export interface OpenApiOperation {
  operationId: string;
  summary: string;
  tags: string[];
  parameters?: {
    name: string;
    in: 'path' | 'query' | 'header';
    required: boolean;
    schema: JsonSchema;
  }[];
  requestBody?: { required: true; content: Record<string, { schema: JsonSchema }> };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  >;
}

export interface OpenApiDocument {
  openapi: '3.0.3';
  info: { title: string; version: string; description: string };
  paths: Record<string, Partial<Record<RouteDoc['method'], OpenApiOperation>>>;
}
```

In `operationFor`, replace the fixed `'200'` response and add the body and header:

```ts
  const responses: OpenApiOperation['responses'] = route.response
    ? {
        '200': {
          description: 'Success',
          content: { 'application/json': { schema: toJson(route.response, 'output') } },
        },
      }
    : { '204': { description: 'No content' } };
```

```ts
  return {
    operationId: route.operationId,
    summary: route.summary,
    tags: route.tags,
    parameters: [
      ...route.pathParams.map((name) => ({
        name,
        in: 'path' as const,
        required: true,
        schema: { type: 'string', format: 'uuid' } as JsonSchema,
      })),
      ...(route.requiresSession
        ? [
            {
              name: 'X-Session-Id',
              in: 'header' as const,
              required: true,
              schema: { type: 'string', format: 'uuid' } as JsonSchema,
            },
          ]
        : []),
      ...(route.query ? (queryParameters(route.query) ?? []) : []),
    ],
    ...(route.body
      ? {
          requestBody: {
            required: true as const,
            content: { 'application/json': { schema: toJson(route.body, 'input') } },
          },
        }
      : {}),
    responses,
  };
```

And in `buildOpenApiDocument`, merge rather than overwrite:

```ts
  for (const route of ROUTES) {
    paths[route.path] = { ...paths[route.path], [route.method]: operationFor(route) };
  }
```

Also widen the `description` in `info`: it still says "Read-only catalogue", which stopped being true in this task.

- [ ] **Step 7: Run the tests**

Run: `npm test -w @cinema/api`
Expected: PASS — including the whole of `reservations.e2e.spec.ts` from Tasks 6 and 7, which is now routed. If `document.test.ts` asserts an exhaustive route count, update that number.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): expose the reservation endpoints and document them"
```

---

## Task 9: Real seat occupancy on the seat map

**Files:**

- Modify: `apps/api/src/catalog/catalog.service.ts`
- Modify: `apps/api/src/catalog/catalog.controller.ts`
- Create: `apps/api/test/seat-occupancy.e2e.spec.ts`

**Interfaces:**

- Consumes: `reservations`, `reservationSeats` tables; `@OptionalSessionId()` (Task 5).
- Produces: `CatalogService.getShowtimeSeats(id, sessionId: string | null, executor?)` — note the **new second parameter**; the controller passes the header through.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/seat-occupancy.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { showtimeSeatsSchema, type ShowtimeSeats } from '@cinema/contracts';
import { sql } from 'drizzle-orm';

import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('seat occupancy on the seat map', () => {
  const session = randomUUID();
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db);
  });

  const seatsOf = async (caller?: string) =>
    showtimeSeatsSchema.parse(
      (
        await h.app.inject({
          method: 'GET',
          url: `/api/v1/showtimes/${h.showtimeId}/seats`,
          headers: caller ? { 'x-session-id': caller } : {},
        })
      ).json(),
    );

  const find = (map: ShowtimeSeats, seatId: string) =>
    map.seats.find((seat) => seat.seatId === seatId)!;

  it('reports every seat available when nothing is held', async () => {
    const map = await seatsOf();

    expect(map.seats.every((seat) => seat.status === 'AVAILABLE')).toBe(true);
    expect(map.seats.every((seat) => !seat.heldByYou)).toBe(true);
  });

  it('reports a pending hold as HELD', async () => {
    await h.hold([h.seatIds[0]!], session);

    expect(find(await seatsOf(), h.seatIds[0]!).status).toBe('HELD');
  });

  it('reports a confirmed reservation as CONFIRMED', async () => {
    const created = await h.holdOne(h.seatIds[1]!, session);
    await h.act('POST', `/${created.id}/confirm`, session);

    expect(find(await seatsOf(), h.seatIds[1]!).status).toBe('CONFIRMED');
  });

  // Your own hold must be distinguishable from a stranger's, or the map shows
  // you your own seats as unavailable.
  it('marks your own holds and nobody else’s', async () => {
    await h.hold([h.seatIds[2]!], session);
    await h.hold([h.seatIds[3]!], randomUUID());

    const mine = await seatsOf(session);

    expect(find(mine, h.seatIds[2]!).heldByYou).toBe(true);
    expect(find(mine, h.seatIds[3]!).heldByYou).toBe(false);
  });

  it('reports heldByYou false for an anonymous caller', async () => {
    await h.hold([h.seatIds[4]!], session);

    expect(find(await seatsOf(), h.seatIds[4]!).heldByYou).toBe(false);
  });

  // The same predicate decides both "this hold blocks an insert" and "this seat
  // reads as taken". One definition of occupied, not two that can disagree.
  it('reports an expired hold as available again', async () => {
    const created = await h.holdOne(h.seatIds[5]!, session);
    await h.db.execute(
      sql`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${created.id}`,
    );

    expect(find(await seatsOf(session), h.seatIds[5]!).status).toBe('AVAILABLE');
  });

  it('reports a cancelled hold as available again', async () => {
    const created = await h.holdOne(h.seatIds[6]!, session);
    await h.act('DELETE', `/${created.id}`, session);

    expect(find(await seatsOf(session), h.seatIds[6]!).status).toBe('AVAILABLE');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- seat-occupancy`
Expected: FAIL — every seat still reads `AVAILABLE` because of the phase 1 constant.

- [ ] **Step 3: Replace the constant with the occupancy join**

In `apps/api/src/catalog/catalog.service.ts`, rewrite `getShowtimeSeats`:

```ts
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
```

Add `isNull` to the `drizzle-orm` imports and `reservationSeats`, `reservations` to the schema imports.

- [ ] **Step 4: Pass the session through the controller**

In `apps/api/src/catalog/catalog.controller.ts`:

```ts
  @Get('showtimes/:id/seats')
  @Validated(showtimeSeatsSchema)
  getShowtimeSeats(
    @Param(zodPipe(idParamSchema)) params: IdParam,
    @OptionalSessionId() sessionId: string | null,
  ): Promise<ShowtimeSeats> {
    return this.catalog.getShowtimeSeats(params.id, sessionId);
  }
```

Import `OptionalSessionId` from `../http/session.decorator`.

- [ ] **Step 5: Run the whole API suite**

Run: `npm test -w @cinema/api`
Expected: PASS. `catalog-showtimes.e2e.spec.ts` from phase 1 still passes — with no reservations in the database every seat is `AVAILABLE`, exactly as before.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): report real seat occupancy on the seat map"
```

---

## Task 10: The contention test

The deliverable of the sub-project. Everything before this exists so that this test can be written and can pass.

**Files:**

- Create: `apps/api/test/reservations-contention.e2e.spec.ts`

**Interfaces:**

- Consumes: the running app, `truncateReservations`, and `DATABASE_POOL_MAX` from Task 2.
- Produces: nothing other tasks import. It is the proof.

- [ ] **Step 1: Write the test**

This one is written to pass, not to fail first: it asserts a property of the system that Tasks 2–8 have already built. Its value is that it fails loudly if anyone ever weakens the invariant.

Create `apps/api/test/reservations-contention.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

/**
 * Section 7 of spec.md, stated as a test:
 *
 *   N users, one seat  ->  successful reservations = 1
 *
 * The pool is raised above the client count on purpose. At the default of ten
 * connections, forty of fifty clients would be queuing for a connection rather
 * than racing for a seat, and the test would pass for the wrong reason.
 */
describe('reservations under contention', () => {
  const CLIENTS = 50;
  let h: ReservationHarness;

  beforeAll(async () => {
    // Set before the module compiles: ConfigService parses the environment once,
    // at construction, so assigning this afterwards would have no effect.
    process.env.DATABASE_POOL_MAX = String(CLIENTS + 10);
    h = await startReservationHarness();
  });

  afterAll(async () => {
    await h.close();
    delete process.env.DATABASE_POOL_MAX;
  });

  beforeEach(async () => {
    await truncateReservations(h.db);
  });

  const race = (seats: string[], clients: number) =>
    Promise.all(
      Array.from({ length: clients }, () =>
        h.hold(seats, randomUUID()),
      ),
    );

  it('lets exactly one of fifty clients hold the same seat', async () => {
    const responses = await race([h.seatIds[0]!], CLIENTS);

    const created = responses.filter((response) => response.statusCode === 201);
    const conflicted = responses.filter((response) => response.statusCode === 409);

    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(CLIENTS - 1);
    // Nothing else: a 500 here would mean a deadlock or an unmapped constraint
    // violation escaped as an internal error.
    expect(created.length + conflicted.length).toBe(CLIENTS);
  });

  it('leaves exactly one active row in the database', async () => {
    await race([h.seatIds[0]!], CLIENTS);

    const active = await h.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM reservation_seats
      WHERE seat_id = ${h.seatIds[0]!} AND showtime_id = ${h.showtimeId} AND released_at IS NULL
    `);

    expect(active.rows[0]?.n).toBe('1');
  });

  it('leaves no partial holds behind when clients ask for overlapping pairs', async () => {
    // Every client wants the same two seats. A loser must hold neither.
    const responses = await race([h.seatIds[1]!, h.seatIds[2]!], CLIENTS);

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const active = await h.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM reservation_seats WHERE released_at IS NULL`,
    );
    expect(active.rows[0]?.n).toBe('2');
  });

  // Different seats must not serialise against each other. If this is slow or
  // fails, the invariant is locking more than the row it needs to.
  it('lets a thousand clients hold a thousand distinct seats', async () => {
    const premiere = await h.db.execute<{ showtime_id: string }>(sql`
      SELECT sh.id AS showtime_id FROM showtimes sh
      JOIN halls h ON h.id = sh.hall_id
      WHERE (SELECT count(*) FROM seats WHERE hall_id = h.id) = 1000
        AND sh.starts_at > now() + interval '1 day'
      ORDER BY sh.starts_at LIMIT 1
    `);
    const target = premiere.rows[0]!.showtime_id;

    const all = await h.db.execute<{ id: string }>(sql`
      SELECT se.id FROM seats se
      JOIN showtimes sh ON sh.hall_id = se.hall_id
      WHERE sh.id = ${target}
    `);
    expect(all.rows).toHaveLength(1000);

    const responses = await Promise.all(
      all.rows.map((seat) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/reservations',
          headers: { 'x-session-id': randomUUID() },
          payload: { showtimeId: target, seatIds: [seat.id] },
        }),
      ),
    );

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1000);
    expect(responses.filter((r) => r.statusCode !== 201)).toHaveLength(0);
  }, 120_000);
});
```

- [ ] **Step 2: Run it**

Run: `npm test -w @cinema/api -- reservations-contention`
Expected: PASS, all four.

If the first test reports two or more `201`s, the invariant is broken — stop and fix the index or the insert, do not adjust the test. If any response is a `500`, read its problem document: a `40P01` means the deterministic seat ordering in `ReservationService.create` was lost.

- [ ] **Step 3: Run the whole suite**

Run: `npm test -w @cinema/api`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/reservations-contention.e2e.spec.ts
git commit -m "test(api): prove exactly one of fifty clients wins a contested seat"
```

---

## Task 11: Web — session identity and the reservation API client

**Files:**

- Create: `apps/web/src/shared/api/session.ts`
- Create: `apps/web/src/shared/api/session.test.ts`
- Modify: `apps/web/src/shared/api/client.ts`
- Create: `apps/web/src/shared/api/reservations.ts`
- Modify: `apps/web/src/shared/api/query-keys.ts`
- Modify: `apps/web/src/test/fixtures.ts`
- Modify: `apps/web/src/test/handlers.ts`

**Interfaces:**

- Consumes: `apiFetch`, `ApiError` from `client.ts`; the contracts from Task 1.
- Produces: `getSessionId(): string`; `reservationsApi.create/get/list/cancel/confirm`; `queryKeys.reservations.{all,list,detail}`; `lostSeatIds(error: unknown): string[]`. Tasks 12 and 13 use all of them.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/shared/api/session.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { SESSION_STORAGE_KEY, getSessionId } from './session';

describe('getSessionId', () => {
  beforeEach(() => localStorage.clear());

  it('creates and stores an id on first use', () => {
    const id = getSessionId();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(id);
  });

  // The same browser must keep its reservations across a reload; a new id every
  // page load would orphan every hold the user is holding.
  it('returns the same id on later calls', () => {
    expect(getSessionId()).toBe(getSessionId());
  });

  it('replaces a stored value that is not a uuid', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'not-a-uuid');

    const id = getSessionId();

    expect(id).not.toBe('not-a-uuid');
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(id);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/web -- session`
Expected: FAIL — `Failed to resolve import "./session"`.

- [ ] **Step 3: Write the session module**

Create `apps/web/src/shared/api/session.ts`:

```ts
export const SESSION_STORAGE_KEY = 'cinema.sessionId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cached: string | null = null;

/**
 * Phase 2 has no accounts, so a reservation belongs to a browser. The id is
 * minted once and kept, because losing it means losing every hold this browser
 * is holding.
 */
export function getSessionId(): string {
  if (cached && UUID.test(cached)) return cached;

  const stored = localStorage.getItem(SESSION_STORAGE_KEY);
  if (stored && UUID.test(stored)) {
    cached = stored;
    return stored;
  }

  const created = crypto.randomUUID();
  localStorage.setItem(SESSION_STORAGE_KEY, created);
  cached = created;
  return created;
}
```

- [ ] **Step 4: Attach the header in one place**

In `apps/web/src/shared/api/client.ts`, extend `apiFetch`'s header merge — one place, so a new endpoint cannot forget it:

```ts
import { getSessionId } from './session';

  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      // Sent on every request, including the seat map, which uses it to mark
      // the caller's own holds.
      'x-session-id': getSessionId(),
      ...init?.headers,
    },
  });
```

Also export the helper that reads the extension member off a failed hold:

```ts
/** The seats a `seats-unavailable` response says this request lost. */
export function lostSeatIds(error: unknown): string[] {
  return error instanceof ApiError ? (error.problem.seatIds ?? []) : [];
}
```

- [ ] **Step 5: Write the reservation client and query keys**

Create `apps/web/src/shared/api/reservations.ts`:

```ts
import {
  reservationPageSchema,
  reservationSchema,
  type CreateReservation,
  type Page,
  type Reservation,
} from '@cinema/contracts';
import { z } from 'zod';

import { apiFetch } from './client';

export const reservationsApi = {
  create: (input: CreateReservation): Promise<Reservation> =>
    apiFetch('/api/v1/reservations', reservationSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  get: (id: string): Promise<Reservation> =>
    apiFetch(`/api/v1/reservations/${id}`, reservationSchema),

  list: (): Promise<Page<Reservation>> =>
    apiFetch('/api/v1/reservations?limit=20', reservationPageSchema),

  confirm: (id: string): Promise<Reservation> =>
    apiFetch(`/api/v1/reservations/${id}/confirm`, reservationSchema, { method: 'POST' }),

  // 204 carries no body; `z.void()` is what the parse of an empty response
  // needs to succeed.
  cancel: (id: string): Promise<void> =>
    apiFetch(`/api/v1/reservations/${id}`, z.void(), { method: 'DELETE' }),
};
```

`apiFetch` calls `response.json()` unconditionally, which throws on an empty 204 body. Add a guard to `apiFetch` before the parse:

```ts
  if (response.status === 204) return schema.parse(undefined);
```

Add to `apps/web/src/shared/api/query-keys.ts`:

```ts
  reservations: {
    all: ['reservations'] as const,
    list: () => ['reservations', 'list'] as const,
    detail: (id: string) => ['reservations', 'detail', id] as const,
  },
```

- [ ] **Step 6: Update the MSW fixtures**

In `apps/web/src/test/fixtures.ts`, add `heldByYou: false` to the seat factory (replacing the stopgap from Task 1's Step 8, and dropping that comment) and add a reservation factory:

```ts
export function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: '019298a1-7c4e-7c3a-8f21-000000000090',
    showtimeId: '019298a1-7c4e-7c3a-8f21-000000000001',
    status: 'PENDING',
    totalPriceCents: 45000,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString(),
    seats: [
      {
        seatId: '019298a1-7c4e-7c3a-8f21-000000000002',
        rowLabel: 'C',
        seatNumber: 7,
        category: 'VIP',
        priceCents: 45000,
      },
    ],
    ...overrides,
  };
}
```

In `apps/web/src/test/handlers.ts`, add handlers for `POST /api/v1/reservations`, `GET /api/v1/reservations/:id`, `POST /api/v1/reservations/:id/confirm`, and `DELETE /api/v1/reservations/:id`, following the shape of the existing handlers. Parse every response body through the contract schemas the same way the current handlers do — a mock that drifts from the contract is worse than no mock.

- [ ] **Step 7: Run the tests**

Run: `npm run build -w @cinema/contracts && npm test -w @cinema/web`
Expected: PASS, including the phase 1 component tests.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/shared apps/web/src/test
git commit -m "feat(web): identify the browser by session and add the reservation client"
```

---

## Task 12: Web — selecting seats and taking a hold

**Files:**

- Modify: `apps/web/src/features/seat-map/seat-button.tsx`
- Modify: `apps/web/src/features/seat-map/seat-grid.tsx`
- Modify: `apps/web/src/features/seat-map/seat-map-page.tsx`
- Create: `apps/web/src/features/seat-map/selection-summary.tsx`
- Modify: `apps/web/src/features/seat-map/seat-map-page.test.tsx`

**Interfaces:**

- Consumes: `reservationsApi.create`, `lostSeatIds`, `queryKeys` (Task 11).
- Produces: nothing other tasks import — this is a leaf screen.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/features/seat-map/seat-map-page.test.tsx`. The file already imports `renderWithProviders`, `screen` and `userEvent`; add `server` from `../../test/server`, and `conflictOnHold` and `SEAT_A1_ID` from `../../test/handlers`.

```tsx
  it('selects and deselects a seat', async () => {
    renderWithProviders(<SeatMapPage />, { route: `/showtimes/${SHOWTIME_ID}` });
    const seat = await screen.findByRole('button', { name: /row a, seat 1/i });

    await userEvent.click(seat);
    expect(seat).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(seat);
    expect(seat).toHaveAttribute('aria-pressed', 'false');
  });

  it('announces the running total of the selection', async () => {
    renderWithProviders(<SeatMapPage />, { route: `/showtimes/${SHOWTIME_ID}` });

    await userEvent.click(await screen.findByRole('button', { name: /row a, seat 1/i }));
    await userEvent.click(await screen.findByRole('button', { name: /row a, seat 2/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/2 seats/i);
  });

  it('does not let a taken seat be selected', async () => {
    // handler returns seat A3 as HELD by someone else
    renderWithProviders(<SeatMapPage />, { route: `/showtimes/${SHOWTIME_ID}` });

    expect(await screen.findByRole('button', { name: /row a, seat 3.*held/i })).toBeDisabled();
  });

  it('navigates to the reservation once the hold succeeds', async () => {
    renderWithProviders(<SeatMapPage />, { route: `/showtimes/${SHOWTIME_ID}` });

    await userEvent.click(await screen.findByRole('button', { name: /row a, seat 1/i }));
    await userEvent.click(screen.getByRole('button', { name: /hold seats/i }));

    expect(await screen.findByText(/your seats are held/i)).toBeInTheDocument();
  });

  // The point of the extension member: the user is told which seats they lost,
  // not just that something failed.
  it('names the seats lost to another user', async () => {
    server.use(conflictOnHold([SEAT_A1_ID]));
    renderWithProviders(<SeatMapPage />, { route: `/showtimes/${SHOWTIME_ID}` });

    await userEvent.click(await screen.findByRole('button', { name: /row a, seat 1/i }));
    await userEvent.click(screen.getByRole('button', { name: /hold seats/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/a1/i);
  });
```

Add to `apps/web/src/test/handlers.ts` an exported `SEAT_A1_ID` (the id the seat fixtures give row A seat 1) and this factory:

```ts
export function conflictOnHold(seatIds: string[]) {
  return http.post('*/api/v1/reservations', () =>
    HttpResponse.json(
      {
        type: 'https://cinema.example/errors/seats-unavailable',
        title: 'Seats unavailable',
        status: 409,
        detail: 'Seats A1 were taken by another reservation',
        instance: '/api/v1/reservations',
        traceId: 'test',
        seatIds,
      },
      { status: 409, headers: { 'content-type': 'application/problem+json' } },
    ),
  );
}
```

The default handler set must also return seat A3 as `HELD` with `heldByYou: false`, which the "taken seat" test above relies on.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/web -- seat-map`
Expected: FAIL — seats have no `aria-pressed` and there is no hold button.

- [ ] **Step 3: Make the seat button selectable**

In `seat-button.tsx`, extend the props and the rendering. The memo comparison matters here: this is the moment phase 1's memoisation is supposed to pay off, and it only does if `onToggle` is stable.

```ts
export interface SeatButtonProps {
  seat: ShowtimeSeat;
  position: string;
  isActive: boolean;
  isSelected: boolean;
  onFocus: () => void;
  onToggle: (seatId: string) => void;
}
```

```tsx
  // Your own hold is still unavailable to select: choosing it again would lose
  // a 409 to your own reservation. It is labelled differently, not enabled.
  const taken = seat.status !== 'AVAILABLE';

  return (
    <button
      type="button"
      data-grid-cell={position}
      tabIndex={isActive ? 0 : -1}
      onFocus={onFocus}
      onClick={() => onToggle(seat.seatId)}
      disabled={taken}
      aria-pressed={isSelected}
      aria-label={`Row ${seat.rowLabel}, seat ${seat.seatNumber}, ${seat.category.toLowerCase()}, ${formatPrice(
        seat.priceCents,
      )}, ${seat.heldByYou ? 'held by you' : seat.status.toLowerCase()}`}
      className={`... ${isSelected ? 'ring-2 ring-sky-500' : ''} ${CATEGORY_STYLE[seat.category]}`}
    >
      {/* Selection is never carried by the ring alone: a glyph carries it too. */}
      <span aria-hidden>{isSelected ? '✓' : STATUS_GLYPH[seat.status] || seat.seatNumber}</span>
    </button>
  );
```

Thread `isSelected` and `onToggle` through `seat-grid.tsx`: `SeatGrid` takes `selected: ReadonlySet<string>` and `onToggle: (seatId: string) => void`, passing `isSelected={selected.has(seat.seatId)}` to each button.

- [ ] **Step 4: Write the selection summary**

Create `apps/web/src/features/seat-map/selection-summary.tsx`:

```tsx
import type { ShowtimeSeat } from '@cinema/contracts';

import { formatPrice } from '../../shared/lib/format';
import { Button } from '../../shared/ui/button';

export interface SelectionSummaryProps {
  seats: ShowtimeSeat[];
  isHolding: boolean;
  onHold: () => void;
}

export function SelectionSummary({ seats, isHolding, onHold }: SelectionSummaryProps) {
  const total = seats.reduce((sum, seat) => sum + seat.priceCents, 0);
  const labels = seats.map((seat) => `${seat.rowLabel}${seat.seatNumber}`).join(', ');

  return (
    <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-4 border-t bg-white/90 p-4 backdrop-blur dark:bg-slate-900/90">
      {/* polite, not assertive: this updates on every click and must not
          interrupt what the screen reader is already saying. */}
      <p role="status" aria-live="polite" className="text-sm">
        {seats.length === 0
          ? 'No seats selected'
          : `${seats.length} seats selected · ${labels} · ${formatPrice(total)}`}
      </p>
      <Button onClick={onHold} disabled={seats.length === 0 || isHolding}>
        {isHolding ? 'Holding…' : 'Hold seats'}
      </Button>
    </div>
  );
}
```

- [ ] **Step 5: Wire the page**

In `seat-map-page.tsx`: hold `selected` in `useState<Set<string>>`, memoise `onToggle` with `useCallback` so the memoised seat buttons are not all invalidated on every click, and add the mutation.

```tsx
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const seats = useQuery({
    queryKey: queryKeys.showtimes.seats(showtimeId),
    queryFn: () => catalogApi.getShowtimeSeats(showtimeId),
    // Seats change under the user while they choose. Five seconds is short
    // enough to see contention and long enough not to be a load generator; a
    // subscription waits for sub-project 5, where Kafka gives it a real reason.
    refetchInterval: 5_000,
    staleTime: 0,
  });

  const toggle = useCallback((seatId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(seatId)) next.add(seatId);
      return next;
    });
  }, []);

  const hold = useMutation({
    mutationFn: () =>
      reservationsApi.create({ showtimeId, seatIds: [...selected] }),
    onSuccess: (reservation) => {
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: queryKeys.showtimes.seats(showtimeId) });
      void navigate(`/reservations/${reservation.id}`);
    },
    onError: () => {
      // A lost race means the map is out of date; refetch rather than guess.
      void queryClient.invalidateQueries({ queryKey: queryKeys.showtimes.seats(showtimeId) });
    },
  });
```

Render, above the summary, an `alert` region when `hold.isError`:

```tsx
      {hold.isError && (
        <p role="alert" className="mt-4 rounded bg-rose-100 p-3 text-sm dark:bg-rose-950">
          {lostSeats.length > 0
            ? `Seats ${lostSeats.join(', ')} were taken while you were choosing. Pick again.`
            : hold.error.message}
        </p>
      )}
```

where `lostSeats` maps `lostSeatIds(hold.error)` (imported from `../../shared/api/client`) onto `${rowLabel}${seatNumber}` labels using `seats.data.seats`.

**No optimistic update.** Do not add `onMutate` with a cache write: an optimistic hold under contention shows the user a seat as theirs that the server refuses 200ms later.

- [ ] **Step 6: Run the tests**

Run: `npm test -w @cinema/web -- seat-map`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/seat-map apps/web/src/test
git commit -m "feat(web): select seats and hold them from the seat map"
```

---

## Task 13: Web — the reservation page

**Files:**

- Create: `apps/web/src/shared/lib/use-countdown.ts`
- Create: `apps/web/src/shared/lib/use-countdown.test.ts`
- Create: `apps/web/src/features/reservations/reservation-page.tsx`
- Create: `apps/web/src/features/reservations/reservation-page.test.tsx`
- Modify: `apps/web/src/app/router.tsx`

**Interfaces:**

- Consumes: `reservationsApi`, `queryKeys.reservations` (Task 11).
- Produces: the `/reservations/:reservationId` route.

- [ ] **Step 1: Write the failing test for the countdown**

Create `apps/web/src/shared/lib/use-countdown.test.ts`:

```ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCountdown } from './use-countdown';

describe('useCountdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts down each second', () => {
    const deadline = new Date(Date.now() + 90_000).toISOString();
    const { result } = renderHook(() => useCountdown(deadline));

    expect(result.current.secondsLeft).toBe(90);
    expect(result.current.label).toBe('1:30');

    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.secondsLeft).toBe(89);
  });

  it('floors at zero and reports expiry', () => {
    const { result } = renderHook(() => useCountdown(new Date(Date.now() - 1000).toISOString()));

    expect(result.current.secondsLeft).toBe(0);
    expect(result.current.hasExpired).toBe(true);
  });

  // The screen reader must not become a metronome. Only threshold crossings are
  // announced; the visible timer keeps ticking every second.
  it('announces only at thresholds', () => {
    const { result } = renderHook(() =>
      useCountdown(new Date(Date.now() + 301_000).toISOString()),
    );

    expect(result.current.announcement).toBe('');
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.announcement).toMatch(/5 minutes/i);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/web -- use-countdown`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the hook**

Create `apps/web/src/shared/lib/use-countdown.ts`:

```ts
import { useEffect, useState } from 'react';

const ANNOUNCE_AT = [300, 60, 30] as const;

export interface Countdown {
  secondsLeft: number;
  label: string;
  hasExpired: boolean;
  /** Non-empty only on the tick that crosses a threshold. */
  announcement: string;
}

function remaining(deadline: string): number {
  return Math.max(0, Math.round((new Date(deadline).getTime() - Date.now()) / 1000));
}

export function useCountdown(deadline: string): Countdown {
  const [secondsLeft, setSecondsLeft] = useState(() => remaining(deadline));

  useEffect(() => {
    setSecondsLeft(remaining(deadline));
    const timer = setInterval(() => setSecondsLeft(remaining(deadline)), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const minutes = Math.floor(secondsLeft / 60);
  const threshold = ANNOUNCE_AT.find((mark) => mark === secondsLeft);

  return {
    secondsLeft,
    label: `${minutes}:${String(secondsLeft % 60).padStart(2, '0')}`,
    hasExpired: secondsLeft === 0,
    announcement: threshold
      ? threshold >= 60
        ? `${threshold / 60} minutes left to confirm`
        : `${threshold} seconds left to confirm`
      : '',
  };
}
```

- [ ] **Step 4: Write the failing test for the page**

Create `apps/web/src/features/reservations/reservation-page.test.tsx`, in the style of `movie-list-page.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { makeReservation } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { server } from '../../test/server';
import { ReservationPage } from './reservation-page';

const ID = '019298a1-7c4e-7c3a-8f21-000000000090';
const route = `/reservations/${ID}`;

describe('ReservationPage', () => {
  it('shows the held seats, the total and the countdown', async () => {
    renderWithProviders(<ReservationPage />, { route });

    expect(await screen.findByText(/C7/)).toBeInTheDocument();
    expect(screen.getByText(/450/)).toBeInTheDocument();
    expect(screen.getByTestId('countdown')).toHaveTextContent(/\d+:\d\d/);
  });

  it('confirms the reservation', async () => {
    renderWithProviders(<ReservationPage />, { route });

    await userEvent.click(await screen.findByRole('button', { name: /confirm/i }));

    expect(await screen.findByRole('heading', { name: /confirmed/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
  });

  it('cancels the reservation and returns to the seat map', async () => {
    renderWithProviders(<ReservationPage />, { route });

    await userEvent.click(await screen.findByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(window.location.pathname).toMatch(/^\/showtimes\//));
  });

  it('offers no confirm button once the reservation has expired', async () => {
    server.use(
      http.get('*/api/v1/reservations/:id', () =>
        HttpResponse.json(makeReservation({ status: 'EXPIRED' })),
      ),
    );
    renderWithProviders(<ReservationPage />, { route });

    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
  });

  // Expiry is the server's decision. The countdown reaching zero is a reason to
  // ask again, never a reason for the client to declare the hold dead itself.
  it('refetches when the countdown reaches zero rather than deciding locally', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/v1/reservations/:id', () => {
        calls += 1;
        return HttpResponse.json(
          makeReservation(
            calls === 1
              ? { expiresAt: new Date(Date.now() + 1000).toISOString() }
              : { status: 'EXPIRED' },
          ),
        );
      }),
    );

    renderWithProviders(<ReservationPage />, { route });
    await screen.findByTestId('countdown');

    await waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 3000 });
    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run it to make sure it fails, then write the page**

Run: `npm test -w @cinema/web -- reservation-page`
Expected: FAIL — module not found.

Create `apps/web/src/features/reservations/reservation-page.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';

import { reservationsApi } from '../../shared/api/reservations';
import { queryKeys } from '../../shared/api/query-keys';
import { useCountdown } from '../../shared/lib/use-countdown';
import { formatPrice } from '../../shared/lib/format';
import { Button } from '../../shared/ui/button';
import { ErrorState } from '../../shared/ui/error-state';
import { Skeleton } from '../../shared/ui/skeleton';

export function ReservationPage() {
  const { reservationId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const reservation = useQuery({
    queryKey: queryKeys.reservations.detail(reservationId),
    queryFn: () => reservationsApi.get(reservationId),
  });

  const countdown = useCountdown(reservation.data?.expiresAt ?? new Date().toISOString());

  // The server declares expiry; the client only notices it is time to ask again.
  useEffect(() => {
    if (countdown.hasExpired && reservation.data?.status === 'PENDING') {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.reservations.detail(reservationId),
      });
    }
  }, [countdown.hasExpired, reservation.data?.status, queryClient, reservationId]);

  const invalidate = (showtimeId: string) => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.reservations.detail(reservationId),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.showtimes.seats(showtimeId) });
  };

  const confirm = useMutation({
    mutationFn: () => reservationsApi.confirm(reservationId),
    onSuccess: (updated) => invalidate(updated.showtimeId),
  });

  const cancel = useMutation({
    mutationFn: () => reservationsApi.cancel(reservationId),
    onSuccess: () => {
      const showtimeId = reservation.data?.showtimeId;
      if (!showtimeId) return;
      invalidate(showtimeId);
      void navigate(`/showtimes/${showtimeId}`);
    },
  });

  if (reservation.isError) {
    return <ErrorState error={reservation.error} onRetry={() => void reservation.refetch()} />;
  }
  if (reservation.isPending) return <Skeleton className="h-64 w-full" />;

  const { status, seats, totalPriceCents, showtimeId } = reservation.data;
  const isPending = status === 'PENDING' && !countdown.hasExpired;

  return (
    <section className="mx-auto max-w-xl">
      <h1 className="text-2xl font-semibold">
        {status === 'CONFIRMED' ? 'Booking confirmed' : 'Your seats are held'}
      </h1>

      <ul className="mt-4 space-y-1">
        {seats.map((seat) => (
          <li key={seat.seatId} className="flex justify-between text-sm">
            <span>
              Row {seat.rowLabel}, seat {seat.seatNumber} · {seat.category.toLowerCase()}
            </span>
            <span>{formatPrice(seat.priceCents)}</span>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-lg font-medium">Total {formatPrice(totalPriceCents)}</p>

      {isPending && (
        <>
          {/* Visible every second, announced only at thresholds: a timer read
              aloud once a second is a metronome, not information. */}
          <p data-testid="countdown" aria-hidden className="mt-4 text-3xl tabular-nums">
            {countdown.label}
          </p>
          <p aria-live="polite" className="sr-only">
            {countdown.announcement}
          </p>

          <div className="mt-6 flex gap-3">
            <Button onClick={() => confirm.mutate()} disabled={confirm.isPending}>
              {confirm.isPending ? 'Confirming…' : 'Confirm booking'}
            </Button>
            <Button onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {status === 'CONFIRMED' && (
        <h2 className="mt-6 text-lg">Confirmed — these seats are yours.</h2>
      )}

      {(status === 'EXPIRED' || status === 'CANCELLED' || countdown.hasExpired) &&
        status !== 'CONFIRMED' && (
          <p className="mt-6">
            {status === 'CANCELLED'
              ? 'This reservation was cancelled.'
              : 'This hold expired and the seats were released.'}{' '}
            <a className="underline" href={`/showtimes/${showtimeId}`}>
              Choose seats again
            </a>
          </p>
        )}

      {(confirm.isError || cancel.isError) && (
        <p role="alert" className="mt-4 rounded bg-rose-100 p-3 text-sm dark:bg-rose-950">
          {(confirm.error ?? cancel.error)?.message}
        </p>
      )}
    </section>
  );
}
```

Note the deliberate omission: there is no local "expire it myself" branch that rewrites the cached reservation. The countdown hitting zero only triggers a refetch.

- [ ] **Step 6: Add the route**

In `apps/web/src/app/router.tsx`:

```tsx
        <Route path="reservations/:reservationId" element={<ReservationPage />} />
```

- [ ] **Step 7: Run the tests**

Run: `npm test -w @cinema/web`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add the reservation page with a countdown, confirm and cancel"
```

---

## Task 14: End-to-end smoke, README and decision records

**Files:**

- Modify: `apps/web/e2e/smoke.spec.ts`
- Modify: `README.md`
- Create: `docs/adr/0009-partial-unique-index-as-the-booking-invariant.md`
- Create: `docs/adr/0010-read-committed-instead-of-serializable.md`
- Create: `docs/adr/0011-lazy-hold-expiry-without-a-sweeper.md`
- Create: `docs/adr/0012-anonymous-sessions-instead-of-authentication.md`
- Create: `docs/adr/0013-reservation-without-booking.md`
- Create: `docs/adr/0014-still-no-zustand.md`
- Create: `docs/adr/0015-contention-tests-and-pool-size.md`

**Interfaces:**

- Consumes: everything.
- Produces: documentation. No code depends on it.

- [ ] **Step 1: Extend the Playwright smoke test**

Add to `apps/web/e2e/smoke.spec.ts` a continuation of the existing walk: from the seat map, click the first available seat, click "Hold seats", assert the reservation page shows a countdown, click "Confirm", assert the confirmed state. Then reload the seat map and assert that seat now renders as confirmed.

This stays one test, not five: the smoke test's job is proving the stack is wired together, and the behaviour itself is covered by Tasks 6–13.

- [ ] **Step 2: Run it against the stack**

Run: `docker compose up --build -d && npm run e2e -w @cinema/web`
Expected: PASS. Then `docker compose down -v`.

- [ ] **Step 3: Write the seven ADRs**

Follow the format of `docs/adr/0008-no-redis-in-phase-1.md` exactly: `# N. Title`, `**Status:** accepted (2026-08-28)`, then `## Context`, `## Decision`, `## Alternatives considered`, `## Consequences`. English, as all the existing ADRs are.

The substance of each is in the spec — do not invent new reasoning, transcribe it:

| ADR | Source in the spec | The alternative that must be argued against |
| --- | --- | --- |
| 0009 | §4, "Инвариант в базе, а не в сервисе" | A `SELECT` for availability followed by an `INSERT` — the check-then-act race |
| 0010 | §4, "Уровень изоляции" | `SERIALIZABLE` plus a retry loop on `40001` |
| 0011 | §4 and §5, lazy expiry | A scheduled sweeper, and doing nothing at all |
| 0012 | §3, `session_id` | A JWT login over the seeded users; a nullable `user_id` column |
| 0013 | §2 and §10 | Creating `bookings` now, as spec.md's entity list lists it |
| 0014 | §8 | Importing Zustand because phase 1's spec promised it |
| 0015 | §7 | A default-sized pool, which makes the contention test pass for the wrong reason |

- [ ] **Step 4: Update the README**

Replace the phase 1 framing:

- The opening paragraph: phase 2 is what exists today.
- "What phase 1 deliberately does not have" becomes "What phase 2 deliberately does not have" — still no Redis, no queues, no payments, no metrics, no authentication.
- Add to "Notable details": that the no-double-booking guarantee is a partial unique index rather than application code, and that expiry is lazy with no scheduler.
- Add a "Proving it" section showing how to run the contention suite:

```bash
npm test -w @cinema/api -- reservations-contention
```

with a sentence on what it asserts: fifty clients, one seat, exactly one reservation.

- [ ] **Step 5: Run everything**

Run: `npm run build -w @cinema/contracts && npm run lint && npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add docs README.md apps/web/e2e
git commit -m "docs: record the phase 2 decisions and extend the smoke test through booking"
```

---

## Definition of Done

- [ ] Fifty concurrent clients contending for one seat produce exactly one `201`, forty-nine `409`s, no `500`s, and exactly one active row.
- [ ] A thousand clients holding a thousand distinct seats all succeed — different seats do not serialise against each other.
- [ ] A hold that lapses is released by the next caller who wants those seats. No scheduler, no cron, no `setInterval` exists anywhere in the codebase.
- [ ] Confirm racing cancel on one reservation resolves to exactly one winner.
- [ ] A reservation belonging to another session is invisible: 404 on read, cancel and confirm.
- [ ] The seat map shows `HELD`, `CONFIRMED` and `heldByYou`, and refetches while the user chooses.
- [ ] A user can select seats, hold them, watch the timer, and confirm or cancel — in a browser, against the compose stack.
- [ ] `npm run lint && npm run typecheck && npm test` pass, and the Playwright smoke test walks from the movie list to a confirmed reservation.
- [ ] No Redis, RabbitMQ, Kafka, k6, payment code, `Idempotency-Key`, Zustand or React Hook Form was added.
- [ ] Seven ADRs record the decisions, each naming the alternative it rejected.

## Handover to sub-project 3

- `ReservationService.releaseStaleHolds` is the seam Redis TTL and the RabbitMQ `reservation.expire` message replace.
- `reservations-contention.e2e.spec.ts` gives the baseline the §25 experiment measures Redis against.
- The `PENDING → CONFIRMED` edge in `state-machine.ts` is where `PAYMENT_PENDING` is inserted in sub-project 5.
- `reservations.session_id` becomes `user_id` when authentication earns its place.
