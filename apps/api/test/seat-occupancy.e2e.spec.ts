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
