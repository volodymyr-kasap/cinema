import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateReservation,
  Page,
  PaginationQuery,
  PaymentStatus,
  Reservation,
  ReservationSeat,
} from '@cinema/contracts';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { CatalogService } from '../catalog/catalog.service';
import { SeatGeometryCache } from '../catalog/seat-geometry.cache';
import { ConfigService } from '../config/config.service';
import { decodeTimestampIdCursor, encodeCursor } from '../catalog/cursor';
import { DRIZZLE, type Database, type Executor } from '../db/drizzle.module';
import { uuidv7 } from '../db/uuid-v7';
import {
  payments,
  reservationSeats,
  reservations,
  seatCategories,
  seats,
  showtimes,
} from '../db/schema';
import { SEAT_LOCK, type SeatLock } from '../locking/seat-lock';
import { ExpirePublisher } from '../messaging/expire.publisher';
import { PaymentPublisher } from '../messaging/payment.publisher';
import {
  InvalidStateTransitionError,
  PaymentInFlightError,
  ReservationExpiredError,
  ResourceNotFoundError,
  SeatsNotInHallError,
  SeatsUnavailableError,
  ShowtimeAlreadyStartedError,
} from '../http/errors';
import { canTransition } from './state-machine';

interface SeatRow {
  id: string;
  rowLabel: string;
  seatNumber: number;
  category: ReservationSeat['category'];
  priceCents: number;
}

/** A seat handed back to the pool by a transaction, and the hold it belonged to. */
interface ReleasedSeat {
  reservationId: string;
  showtimeId: string;
  seatId: string;
}

/** What a delivered reservation.expire message turned out to mean. */
export type SettleOutcome = 'expired' | 'not-found' | 'terminal' | 'not-due' | 'awaiting-payment';

/** What claiming an attempt at a payment turned out to mean. */
export type PaymentClaim =
  | {
      kind: 'charge';
      paymentId: string;
      reservationId: string;
      amountCents: number;
      scenario: string | null;
    }
  | { kind: 'not-found' }
  | { kind: 'terminal' }
  | { kind: 'stale' };

/** What the provider decided about one charge. */
export type PaymentOutcome =
  | { status: 'SUCCEEDED'; providerRef: string }
  | { status: 'DECLINED'; reason: string }
  | { status: 'FAILED'; reason: string };

/** What settling a payment turned out to mean. */
export type PaymentSettlement = 'confirmed' | 'failed' | 'not-found' | 'terminal' | 'stale';

@Injectable()
export class ReservationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(SEAT_LOCK) private readonly seatLock: SeatLock,
    private readonly catalog: CatalogService,
    private readonly geometry: SeatGeometryCache,
    private readonly expiry: ExpirePublisher,
    private readonly paymentPublisher: PaymentPublisher,
    private readonly configService: ConfigService,
  ) {}

  async create(sessionId: string, input: CreateReservation): Promise<Reservation> {
    // Minted here, not by the column default: the lock's value has to exist
    // before the row does, or the release cannot check who owns the key.
    const reservationId = uuidv7();

    // Before the transaction, and this is the entire point of the sub-project.
    // A loser answers 409 in one round-trip without taking a connection from
    // the pool and without opening a transaction that would then block inside
    // ON CONFLICT until the winner commits.
    const lost = await this.seatLock.acquire(input.showtimeId, input.seatIds, reservationId);
    if (lost.length > 0) {
      throw new SeatsUnavailableError(await this.geometry.labels(input.showtimeId, lost));
    }

    let outcome: { reservation: Reservation; released: ReleasedSeat[] };
    try {
      outcome = await this.hold(sessionId, input, reservationId);
    } catch (error) {
      // The database refused, so we do not hold these seats and must not keep
      // their keys: a lock outliving the request it belongs to blocks a seat
      // nobody is holding, for the whole TTL. This also covers the seats the
      // lock took before the transaction knew they were in the wrong hall.
      await this.seatLock.release(input.showtimeId, input.seatIds, reservationId);
      throw error;
    }

    // The lazy expiry inside the transaction handed other people's seats back.
    // Their keys are theirs to lose; the ownership check in the Lua makes this
    // safe even for the seats we have just taken over, because those keys are
    // ours now and will not match.
    await this.releaseLocks(outcome.released);

    // After the commit and after the locks settle, and never inside the
    // transaction: a transaction can roll back, a published message cannot be
    // un-published. A failure here is a warning, not an error -- the hold is
    // already the caller's, and lazy expiry will settle it either way.
    await this.expiry.publishExpire(outcome.reservation.id);
    return outcome.reservation;
  }

  /** Sub-project 2's transaction, unchanged except for the supplied id. */
  private hold(
    sessionId: string,
    input: CreateReservation,
    reservationId: string,
  ): Promise<{ reservation: Reservation; released: ReleasedSeat[] }> {
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

      const released = await this.releaseStaleHolds(tx, input.showtimeId, input.seatIds);

      const totalPriceCents = seatRows.reduce((sum, row) => sum + row.priceCents, 0);
      const ttl = this.configService.config.reservationTtlSeconds;

      const [reservation] = await tx
        .insert(reservations)
        .values({
          id: reservationId,
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
        // The index had the last word: the lock was absent or stale, and this is
        // exactly the case that makes a flushed Redis cost a transaction rather
        // than a double booking. Rolling back discards the rows we did win, so
        // the loser leaves no partial hold behind.
        throw new SeatsUnavailableError(
          ordered
            .filter((row) => !kept.has(row.id))
            .map((row) => ({ seatId: row.id, label: `${row.rowLabel}${String(row.seatNumber)}` })),
        );
      }

      return {
        released,
        reservation: {
          id: reservation!.id,
          showtimeId: input.showtimeId,
          status: 'PENDING' as const,
          totalPriceCents,
          expiresAt: reservation!.expiresAt.toISOString(),
          createdAt: reservation!.createdAt.toISOString(),
          // `seatRows`, not the id-sorted `ordered`: insertion order exists to
          // avoid deadlocks, while the response is read by a human and must
          // match the row-then-number order `get` and `list` return.
          seats: seatRows.map((row) => ({
            seatId: row.id,
            rowLabel: row.rowLabel,
            seatNumber: row.seatNumber,
            category: row.category,
            priceCents: row.priceCents,
          })),
        },
      };
    });
  }

  /**
   * Locks are dropped after the commit, never inside the transaction. A
   * transaction can roll back; a released lock cannot be un-released, and
   * dropping one for a seat that is still held is how a double booking would
   * finally become possible.
   */
  private async releaseLocks(rows: ReleasedSeat[]): Promise<void> {
    if (rows.length === 0) return;

    // Grouped by owner because the Lua compares one value against every key, so
    // a batch may only ever carry a single reservation's seats.
    const groups = new Map<string, ReleasedSeat[]>();
    for (const row of rows) {
      const key = `${row.showtimeId}:${row.reservationId}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    await Promise.all(
      [...groups.values()].map((group) =>
        this.seatLock.release(
          group[0]!.showtimeId,
          group.map((row) => row.seatId),
          group[0]!.reservationId,
        ),
      ),
    );
  }

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
      nextCursor: hasMore && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null,
    };
  }

  /**
   * Returns the reservation and whether a payment was started. The caller turns
   * `paying` into 202 rather than 200: the booking is not final yet, and saying
   * so is the difference between a truthful API and one that claims a sale the
   * provider has not agreed to.
   */
  async confirm(
    sessionId: string,
    id: string,
    scenario?: string,
  ): Promise<{ reservation: Reservation; paying: boolean }> {
    const outcome = await this.db.transaction(async (tx) => {
      const row = await this.lockOwned(tx, sessionId, id);

      if (row.status === 'PENDING' && row.expired) {
        return { expired: true as const, released: await this.expire(tx, id) };
      }

      // A replay of a confirm that is already running. Not an error: the caller
      // asked for a payment and a payment is happening. This, plus the row lock
      // above and payments.reservation_id UNIQUE, is the whole of idempotency
      // on this endpoint -- no header, because the path already names the
      // operation (ADR 0035).
      if (row.status === 'PAYMENT_PENDING') {
        return {
          expired: false as const,
          paying: true as const,
          reservation: await this.get(sessionId, id, tx),
          startsAt: null,
        };
      }

      if (this.configService.config.paymentMode !== 'queue') {
        if (!canTransition(row.status, 'CONFIRMED')) {
          throw new InvalidStateTransitionError(row.status, 'CONFIRMED');
        }

        await tx
          .update(reservations)
          .set({ status: 'CONFIRMED', confirmedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(reservations.id, id));

        const reservation = await this.get(sessionId, id, tx);
        const [showtime] = await tx
          .select({ startsAt: showtimes.startsAt })
          .from(showtimes)
          .where(eq(showtimes.id, reservation.showtimeId))
          .limit(1);

        return {
          expired: false as const,
          paying: false as const,
          reservation,
          startsAt: showtime!.startsAt,
        };
      }

      if (!canTransition(row.status, 'PAYMENT_PENDING')) {
        throw new InvalidStateTransitionError(row.status, 'PAYMENT_PENDING');
      }

      await tx
        .update(reservations)
        .set({ status: 'PAYMENT_PENDING', updatedAt: sql`now()` })
        .where(eq(reservations.id, id));

      const [amounts] = await tx
        .select({ totalPriceCents: reservations.totalPriceCents })
        .from(reservations)
        .where(eq(reservations.id, id))
        .limit(1);

      // Minted here, before the insert, because it is the Idempotency-Key the
      // provider will be shown on every attempt (ADR 0035).
      const paymentId = uuidv7();
      await tx.insert(payments).values({
        id: paymentId,
        reservationId: id,
        status: 'PENDING',
        amountCents: amounts!.totalPriceCents,
        scenario: scenario ?? null,
      });

      // INSIDE the transaction, and it throws. See PaymentPublisher's comment
      // and ADR 0037: a message published for a transaction that rolls back is
      // dropped by the consumer, while a lost message strands a hold.
      await this.paymentPublisher.publishPayment(paymentId);

      return {
        expired: false as const,
        paying: true as const,
        reservation: await this.get(sessionId, id, tx),
        startsAt: null,
      };
    });

    if (outcome.expired) {
      await this.releaseLocks(outcome.released);
      throw new ReservationExpiredError(id);
    }

    // Only a finished sale retains its keys. A payment in flight leaves them
    // exactly as the hold left them: still owned, still expiring with the hold.
    if (!outcome.paying) {
      await this.seatLock.retain(
        outcome.reservation.showtimeId,
        outcome.reservation.seats.map((seat) => seat.seatId),
        id,
        outcome.startsAt!,
      );
    }

    return { reservation: outcome.reservation, paying: outcome.paying };
  }

  async cancel(sessionId: string, id: string): Promise<void> {
    const released = await this.db.transaction(async (tx) => {
      const row = await this.lockOwned(tx, sessionId, id);

      // The money may already have moved. Answering 409 here rather than
      // letting canTransition do it names the reason, which a client can act on.
      if (row.status === 'PAYMENT_PENDING') throw new PaymentInFlightError(id);

      // Cancelling is idempotent. The caller asked for the seats to be released;
      // for a reservation that already ended, they are.
      if (row.status === 'CANCELLED' || row.status === 'EXPIRED') return [];
      if (row.status === 'PENDING' && row.expired) return this.expire(tx, id);
      if (!canTransition(row.status, 'CANCELLED')) {
        throw new InvalidStateTransitionError(row.status, 'CANCELLED');
      }

      await tx
        .update(reservations)
        .set({ status: 'CANCELLED', cancelledAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(reservations.id, id));
      return this.releaseSeatsOf(tx, id);
    });

    await this.releaseLocks(released);
  }

  /**
   * The worker's entire job. Idempotent by construction: the terminal check
   * below is what makes at-least-once delivery safe without a dedupe table --
   * a second delivery finds a row that is no longer PENDING and does nothing.
   *
   * `lockOwned` is not reused because it filters by session, and the worker acts
   * for the system rather than for a caller. The row lock is the same one.
   */
  async settleExpired(reservationId: string): Promise<SettleOutcome> {
    const outcome = await this.db.transaction(
      async (tx): Promise<{ result: SettleOutcome; released: ReleasedSeat[] }> => {
        const [row] = await tx
          .select({
            status: reservations.status,
            // The database's clock, never the broker's: the TTL that delivered
            // this message was measured somewhere else entirely.
            due: sql<boolean>`${reservations.expiresAt} <= now()`,
          })
          .from(reservations)
          .where(eq(reservations.id, reservationId))
          .limit(1)
          .for('update');

        if (!row) return { result: 'not-found', released: [] };
        // The payment owns this row now (ADR 0036). Not 'terminal', because it
        // is not over -- naming it separately is what makes the log line and
        // the test say which of the two things happened.
        if (row.status === 'PAYMENT_PENDING') return { result: 'awaiting-payment', released: [] };
        if (row.status !== 'PENDING') return { result: 'terminal', released: [] };
        if (!row.due) return { result: 'not-due', released: [] };

        return { result: 'expired', released: await this.expire(tx, reservationId) };
      },
    );

    // After the commit, like every other release in this service.
    await this.releaseLocks(outcome.released);
    return outcome.result;
  }

  /**
   * Takes ownership of one attempt: checks the payment is still ours to make
   * and counts the attempt, in one transaction.
   *
   * The attempt is counted here rather than after the provider answers,
   * because a provider that never answers is exactly the case the counter
   * exists to record.
   */
  async claimPayment(paymentId: string): Promise<PaymentClaim> {
    return this.db.transaction(async (tx): Promise<PaymentClaim> => {
      const [head] = await tx
        .select({ reservationId: payments.reservationId })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);
      if (!head) return { kind: 'not-found' };

      // Reservations first, then payments, everywhere in this service. The
      // reaper takes the same two rows in the same order; two paths taking them
      // in opposite orders is a deadlock waiting for load.
      const [reservation] = await tx
        .select({ status: reservations.status })
        .from(reservations)
        .where(eq(reservations.id, head.reservationId))
        .limit(1)
        .for('update');

      const [row] = await tx
        .select({
          status: payments.status,
          amountCents: payments.amountCents,
          scenario: payments.scenario,
        })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1)
        .for('update');

      if (!row) return { kind: 'not-found' };
      if (row.status !== 'PENDING') return { kind: 'terminal' };
      if (!reservation || reservation.status !== 'PAYMENT_PENDING') return { kind: 'stale' };

      await tx
        .update(payments)
        .set({ attempts: sql`${payments.attempts} + 1` })
        .where(eq(payments.id, paymentId));

      return {
        kind: 'charge',
        paymentId,
        reservationId: head.reservationId,
        amountCents: row.amountCents,
        scenario: row.scenario,
      };
    });
  }

  /**
   * Records what the provider decided and moves the reservation with it.
   *
   * Idempotent by the same construction as settleExpired: a payment that is no
   * longer PENDING is left alone, which is what makes at-least-once delivery
   * safe without a dedupe table.
   */
  async settlePayment(paymentId: string, outcome: PaymentOutcome): Promise<PaymentSettlement> {
    const settled = await this.db.transaction(async (tx) => {
      const [head] = await tx
        .select({ reservationId: payments.reservationId })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);
      if (!head) return { result: 'not-found' as const, released: [] as ReleasedSeat[] };

      const [reservation] = await tx
        .select({ status: reservations.status, showtimeId: reservations.showtimeId })
        .from(reservations)
        .where(eq(reservations.id, head.reservationId))
        .limit(1)
        .for('update');

      const [row] = await tx
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1)
        .for('update');

      if (!row) return { result: 'not-found' as const, released: [] as ReleasedSeat[] };
      if (row.status !== 'PENDING')
        return { result: 'terminal' as const, released: [] as ReleasedSeat[] };
      if (!reservation || reservation.status !== 'PAYMENT_PENDING') {
        return { result: 'stale' as const, released: [] as ReleasedSeat[] };
      }

      await tx
        .update(payments)
        .set({
          status: outcome.status,
          providerRef: outcome.status === 'SUCCEEDED' ? outcome.providerRef : null,
          settledAt: sql`now()`,
        })
        .where(eq(payments.id, paymentId));

      if (outcome.status !== 'SUCCEEDED') {
        await tx
          .update(reservations)
          .set({ status: 'PAYMENT_FAILED', cancelledAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(reservations.id, head.reservationId));

        return {
          result: 'failed' as const,
          released: await this.releaseSeatsOf(tx, head.reservationId),
        };
      }

      await tx
        .update(reservations)
        .set({ status: 'CONFIRMED', confirmedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(reservations.id, head.reservationId));

      const confirmed = await this.hydrateById(tx, head.reservationId);
      const [showtime] = await tx
        .select({ startsAt: showtimes.startsAt })
        .from(showtimes)
        .where(eq(showtimes.id, reservation.showtimeId))
        .limit(1);

      return {
        result: 'confirmed' as const,
        released: [] as ReleasedSeat[],
        retain: {
          showtimeId: reservation.showtimeId,
          seatIds: confirmed.seats.map((seat) => seat.seatId),
          reservationId: head.reservationId,
          startsAt: showtime!.startsAt,
        },
      };
    });

    // After the commit, like every other lock operation in this service.
    if (settled.result === 'failed') await this.releaseLocks(settled.released);
    if (settled.result === 'confirmed' && 'retain' in settled && settled.retain) {
      await this.seatLock.retain(
        settled.retain.showtimeId,
        settled.retain.seatIds,
        settled.retain.reservationId,
        settled.retain.startsAt,
      );
    }
    return settled.result;
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

  private async expire(executor: Executor, id: string): Promise<ReleasedSeat[]> {
    await executor
      .update(reservations)
      .set({ status: 'EXPIRED', updatedAt: sql`now()` })
      .where(eq(reservations.id, id));
    return this.releaseSeatsOf(executor, id);
  }

  private releaseSeatsOf(executor: Executor, reservationId: string): Promise<ReleasedSeat[]> {
    return executor
      .update(reservationSeats)
      .set({ releasedAt: sql`now()` })
      .where(
        and(eq(reservationSeats.reservationId, reservationId), isNull(reservationSeats.releasedAt)),
      )
      .returning({
        reservationId: reservationSeats.reservationId,
        showtimeId: reservationSeats.showtimeId,
        seatId: reservationSeats.seatId,
      });
  }

  /** `get` without the session filter: the worker acts for the system, not a caller. */
  private async hydrateById(executor: Executor, id: string): Promise<Reservation> {
    const [row] = await executor
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    if (!row) throw new ResourceNotFoundError('Reservation', id);
    return this.hydrate(executor, row);
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

    const [payment] = await executor
      .select({
        status: payments.status,
        amountCents: payments.amountCents,
        attempts: payments.attempts,
      })
      .from(payments)
      .where(eq(payments.reservationId, row.id))
      .limit(1);

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
      // Present only once a payment has been started. Attached here, not in
      // `get`, because `get`, `list` and Task 8's `hydrateById` all build their
      // Reservation through `hydrate` -- attaching it anywhere else would give
      // one caller a payment and leave the others `undefined` for the same row.
      payment: payment
        ? {
            status: payment.status as PaymentStatus,
            amountCents: payment.amountCents,
            attempts: payment.attempts,
          }
        : undefined,
    };
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
   * Lazy release, and still the authoritative one (ADR 0030). Two things can
   * leave a seat held by a reservation that is over:
   *
   *   a PENDING hold past its expires_at            -> EXPIRED
   *   a PAYMENT_PENDING row whose payment never
   *   came back within PAYMENT_DEADLINE_SECONDS     -> PAYMENT_FAILED
   *
   * The second arm closes the only unbounded case in the payment path: the
   * message reached the DLQ, or the worker died holding it. Without it a seat
   * could be owned for ever by a charge nobody is making.
   */
  private async releaseStaleHolds(
    executor: Executor,
    showtimeId: string,
    seatIds: string[],
  ): Promise<ReleasedSeat[]> {
    const deadline = this.configService.config.paymentDeadlineSeconds;

    const stale = await executor
      .selectDistinct({ id: reservations.id, status: reservations.status })
      .from(reservations)
      .innerJoin(reservationSeats, eq(reservationSeats.reservationId, reservations.id))
      .leftJoin(payments, eq(payments.reservationId, reservations.id))
      .where(
        and(
          eq(reservationSeats.showtimeId, showtimeId),
          inArray(reservationSeats.seatId, seatIds),
          isNull(reservationSeats.releasedAt),
          or(
            and(eq(reservations.status, 'PENDING'), sql`${reservations.expiresAt} <= now()`),
            and(
              eq(reservations.status, 'PAYMENT_PENDING'),
              sql`${payments.createdAt} <= now() - make_interval(secs => ${deadline})`,
            ),
          ),
        ),
      );

    if (stale.length === 0) return [];

    const expiredIds = stale.filter((row) => row.status === 'PENDING').map((row) => row.id);
    const abandonedIds = stale
      .filter((row) => row.status === 'PAYMENT_PENDING')
      .map((row) => row.id);

    if (expiredIds.length > 0) {
      await executor
        .update(reservations)
        .set({ status: 'EXPIRED', updatedAt: sql`now()` })
        .where(and(inArray(reservations.id, expiredIds), eq(reservations.status, 'PENDING')));
    }

    if (abandonedIds.length > 0) {
      await executor
        .update(reservations)
        .set({ status: 'PAYMENT_FAILED', cancelledAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(inArray(reservations.id, abandonedIds), eq(reservations.status, 'PAYMENT_PENDING')),
        );

      // A PENDING payment against a PAYMENT_FAILED reservation would be a lie
      // in the ledger, and the row is the only place a refund would ever start.
      await executor
        .update(payments)
        .set({ status: 'FAILED', settledAt: sql`now()` })
        .where(and(inArray(payments.reservationId, abandonedIds), eq(payments.status, 'PENDING')));
    }

    const ids = [...expiredIds, ...abandonedIds];
    return executor
      .update(reservationSeats)
      .set({ releasedAt: sql`now()` })
      .where(and(inArray(reservationSeats.reservationId, ids), isNull(reservationSeats.releasedAt)))
      .returning({
        reservationId: reservationSeats.reservationId,
        showtimeId: reservationSeats.showtimeId,
        seatId: reservationSeats.seatId,
      });
  }
}
