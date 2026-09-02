import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { seatKey } from '../src/locking/seat-lock';
import { ReservationService } from '../src/reservations/reservation.service';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('settleExpired', () => {
  let h: ReservationHarness;
  let service: ReservationService;

  beforeAll(async () => {
    h = await startReservationHarness({ lockStrategy: 'redis', ttlSeconds: 1 });
    service = h.app.get(ReservationService);
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db, h.redis);
  });

  const activeSeats = async (reservationId: string): Promise<number> => {
    const rows = await h.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM reservation_seats
      WHERE reservation_id = ${reservationId} AND released_at IS NULL
    `);
    return Number(rows.rows[0]!.count);
  };

  it('expires a pending hold whose time has passed and frees its seats', async () => {
    const reservation = await h.holdOne(h.seatIds[0]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    await expect(service.settleExpired(reservation.id)).resolves.toBe('expired');

    const [row] = await h.db
      .execute<{ status: string }>(
        sql`SELECT status FROM reservations WHERE id = ${reservation.id}`,
      )
      .then((result) => result.rows);
    expect(row!.status).toBe('EXPIRED');
    await expect(activeSeats(reservation.id)).resolves.toBe(0);
  });

  it('drops the seat lock so the next caller does not pay a wasted transaction', async () => {
    const reservation = await h.holdOne(h.seatIds[1]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    await service.settleExpired(reservation.id);

    await expect(h.redis!.exists(seatKey(h.showtimeId, h.seatIds[1]!))).resolves.toBe(0);
  });

  it('does nothing for a reservation that does not exist', async () => {
    // A message can outlive its row: TRUNCATE in a test, a purge in production.
    await expect(service.settleExpired(randomUUID())).resolves.toBe('not-found');
  });

  it('does nothing for a confirmed reservation', async () => {
    const session = randomUUID();
    const reservation = await h.holdOne(h.seatIds[2]!, session);
    await h.act('POST', `/${reservation.id}/confirm`, session);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // The message for this hold is already in flight when the user confirms.
    // It must find a terminal row and stop -- this is the single most important
    // case in the sub-project, because getting it wrong un-sells a sold seat.
    await expect(service.settleExpired(reservation.id)).resolves.toBe('terminal');
    await expect(activeSeats(reservation.id)).resolves.toBe(1);
  });

  it('does nothing for a cancelled reservation', async () => {
    const session = randomUUID();
    const reservation = await h.holdOne(h.seatIds[3]!, session);
    await h.act('DELETE', `/${reservation.id}`, session);

    await expect(service.settleExpired(reservation.id)).resolves.toBe('terminal');
  });

  it('does nothing for a hold that is not due yet', async () => {
    const reservation = await h.holdOne(h.seatIds[4]!);
    // Pushing expires_at out beats starting a second harness on a longer TTL:
    // startReservationHarness re-seeds, and seedDatabase truncates showtimes and
    // seats, so a nested harness silently invalidates the seat ids every later
    // test in this file still holds.
    await h.db.execute(
      sql`UPDATE reservations SET expires_at = now() + interval '10 minutes' WHERE id = ${reservation.id}`,
    );

    // The broker's TTL and the database's expires_at are two different clocks,
    // so an early delivery is legal and must be a no-op, not an error.
    await expect(service.settleExpired(reservation.id)).resolves.toBe('not-due');
  });

  it('is idempotent: settling twice expires once', async () => {
    const reservation = await h.holdOne(h.seatIds[5]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    await expect(service.settleExpired(reservation.id)).resolves.toBe('expired');
    // The second delivery of an at-least-once message. Structural idempotence:
    // the first call made the row terminal, so the second finds nothing to do.
    await expect(service.settleExpired(reservation.id)).resolves.toBe('terminal');
    await expect(activeSeats(reservation.id)).resolves.toBe(0);
  });
});
