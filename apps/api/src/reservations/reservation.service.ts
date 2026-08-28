import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateReservation,
  Page,
  PaginationQuery,
  Reservation,
  ReservationSeat,
} from '@cinema/contracts';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { CatalogService } from '../catalog/catalog.service';
import { ConfigService } from '../config/config.service';
import { decodeTimestampIdCursor, encodeCursor } from '../catalog/cursor';
import { DRIZZLE, type Database, type Executor } from '../db/drizzle.module';
import { reservationSeats, reservations, seatCategories, seats } from '../db/schema';
import {
  InvalidStateTransitionError,
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
        // `seatRows`, not the id-sorted `ordered`: insertion order exists to
        // avoid deadlocks, while the response is read by a human and must match
        // the row-then-number order `get` and `list` return.
        seats: seatRows.map((row) => ({
          seatId: row.id,
          rowLabel: row.rowLabel,
          seatNumber: row.seatNumber,
          category: row.category,
          priceCents: row.priceCents,
        })),
      };
    });
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
        and(eq(reservationSeats.reservationId, reservationId), isNull(reservationSeats.releasedAt)),
      );
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
      .where(
        and(inArray(reservationSeats.reservationId, ids), isNull(reservationSeats.releasedAt)),
      );
  }
}
