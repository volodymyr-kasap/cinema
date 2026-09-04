import { randomUUID } from 'node:crypto';

import { seatKey } from '../src/locking/seat-lock';
import { ReservationService } from '../src/reservations/reservation.service';
import { getTestProviderUrl, getTestRabbitUrl } from './harness';
import { paymentFor, reservationStatus } from './payment-harness';
import { deleteTopology, openInspection } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

/**
 * The seat key and the reservation row have to stop expiring at the same time.
 *
 * They did not. `confirm` left a paying reservation's keys exactly as the hold
 * had set them, while the row moved onto PAYMENT_DEADLINE_SECONDS -- and because
 * `create` acquires the lock BEFORE opening the transaction that runs the
 * reaper, the stale key refuses the very request that would have triggered the
 * reap. With the shipped defaults the database calls a reservation PAYMENT_FAILED
 * at five minutes and Redis holds the seat for five more.
 *
 * A long hold and a one-second deadline, so the gap is the whole subject rather
 * than a detail two long timers happen to hide.
 */
describe('the seat key of a reservation that is paying', () => {
  let api: ReservationHarness;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

  const DEADLINE_SECONDS = 1;
  const TTL_SECONDS = 600;

  const confirmWith = async (seat: string): Promise<string> => {
    const session = randomUUID();
    const reservation = await api.holdOne(seat, session);
    await api.act('POST', `/${reservation.id}/confirm`, session);
    return reservation.id;
  };

  beforeAll(async () => {
    inspection = await openInspection(getTestRabbitUrl());
    await deleteTopology(inspection.connection, 3);

    api = await startReservationHarness({
      lockStrategy: 'redis',
      expiryMode: 'queue',
      paymentMode: 'queue',
      rabbitmqUrl: getTestRabbitUrl(),
      paymentProviderUrl: getTestProviderUrl(),
      ttlSeconds: TTL_SECONDS,
      paymentDeadlineSeconds: DEADLINE_SECONDS,
    });
  });

  afterAll(async () => {
    await api.close();
    await inspection.channel.close().catch(() => {});
    await inspection.connection.close().catch(() => {});
  });

  beforeEach(async () => {
    await truncateReservations(api.db, api.redis);
  });

  it('expires with the payment, not with the hold', async () => {
    await confirmWith(api.seatIds[0]!);

    // Shortened, not merely extended: the hold set 600, and what is left must
    // be the deadline. Reading the TTL rather than only the behaviour below
    // means a failure names the cause instead of the symptom.
    const ttl = await api.redis!.ttl(seatKey(api.showtimeId, api.seatIds[0]!));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(DEADLINE_SECONDS);
  });

  it('lets the seat be sold again as soon as the deadline passes', async () => {
    const reservationId = await confirmWith(api.seatIds[1]!);
    // Nothing consumes here, so this payment is the abandoned case: the message
    // reached the DLQ, or the worker died holding it.
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const response = await api.hold([api.seatIds[1]!], randomUUID());

    // The whole point of the task. Leaving the hold's TTL on the key answers
    // this 409 for another ten minutes, while the row below is already
    // PAYMENT_FAILED and the seat is provably free.
    expect(response.statusCode).toBe(201);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'FAILED' });
  });

  it('goes back to the end of the showtime once the payment succeeds', async () => {
    const reservationId = await confirmWith(api.seatIds[2]!);
    const payment = await paymentFor(api.db, reservationId);

    await api.app.get(ReservationService).settlePayment(payment!.id, {
      status: 'SUCCEEDED',
      providerRef: 'ch_test',
    });

    // The deadline was a window to answer in, not a shorter life for the sale.
    // The harness's showtime is more than a day out, so anything on that scale
    // proves settlePayment's retain still wins.
    const ttl = await api.redis!.ttl(seatKey(api.showtimeId, api.seatIds[2]!));
    expect(ttl).toBeGreaterThan(86_400);
  });
});
