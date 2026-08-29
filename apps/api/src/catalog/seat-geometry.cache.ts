import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../db/drizzle.module';
import { seats, showtimes } from '../db/schema';
import { ResourceNotFoundError } from '../http/errors';
import { singleFlight } from './memoize';

export interface SeatLabel {
  seatId: string;
  label: string;
}

/**
 * Seat labels for the fast 409 path, held in the process.
 *
 * `SeatsUnavailableError` names seats the way a user sees them ("C7"), and on
 * the fast path no seat row has been read yet. Fetching labels per loser would
 * put nine thousand SELECTs where nine thousand transactions used to be --
 * moving the load Redis was added to remove, not removing it.
 *
 * The catalogue is seeded once and never edited in this sub-project, so no
 * invalidation exists, and that is a recorded limitation rather than an
 * oversight (ADR 0023): when an admin screen starts editing seats, the eviction
 * hook goes here.
 */
@Injectable()
export class SeatGeometryCache {
  private readonly showtimeHalls = new Map<string, Promise<string>>();
  private readonly hallGeometry = new Map<string, Promise<Map<string, string>>>();

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async labels(showtimeId: string, seatIds: string[]): Promise<SeatLabel[]> {
    const hallId = await singleFlight(this.showtimeHalls, showtimeId, () =>
      this.loadHall(showtimeId),
    );
    const geometry = await singleFlight(this.hallGeometry, hallId, () => this.loadGeometry(hallId));

    // A seat that is not in the hall cannot reach this path -- the transaction
    // rejects it first -- but reporting the id beats throwing while building the
    // error that was going to explain the failure.
    return seatIds.map((seatId) => ({ seatId, label: geometry.get(seatId) ?? seatId }));
  }

  private async loadHall(showtimeId: string): Promise<string> {
    const [row] = await this.db
      .select({ hallId: showtimes.hallId })
      .from(showtimes)
      .where(eq(showtimes.id, showtimeId))
      .limit(1);

    if (!row) throw new ResourceNotFoundError('Showtime', showtimeId);
    return row.hallId;
  }

  private async loadGeometry(hallId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ id: seats.id, rowLabel: seats.rowLabel, seatNumber: seats.seatNumber })
      .from(seats)
      .where(eq(seats.hallId, hallId));

    return new Map(rows.map((row) => [row.id, `${row.rowLabel}${String(row.seatNumber)}`]));
  }
}
