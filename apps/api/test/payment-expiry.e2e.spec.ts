import { randomUUID } from 'node:crypto';

import { ReservationService } from '../src/reservations/reservation.service';
import { getTestProviderUrl, getTestRabbitUrl } from './harness';
import { activeSeatCount, agePayment, paymentFor, reservationStatus } from './payment-harness';
import { deleteTopology, openInspection } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('expiry while a payment is in flight', () => {
  let api: ReservationHarness;
  let service: ReservationService;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

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
      // One second, so the hold is genuinely past its deadline while the
      // payment is still running. No worker consumes here.
      ttlSeconds: 1,
    });
    service = api.app.get(ReservationService);
  });

  afterAll(async () => {
    await api.close();
    await inspection.channel.close().catch(() => {});
    await inspection.connection.close().catch(() => {});
  });

  beforeEach(async () => {
    await truncateReservations(api.db, api.redis);
  });

  it('will not expire a hold whose payment is running', async () => {
    const reservationId = await confirmWith(api.seatIds[0]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // The expire message was published when the hold was taken and arrives on
    // schedule. It must find a row that no longer belongs to it.
    await expect(service.settleExpired(reservationId)).resolves.toBe('awaiting-payment');

    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
    // The seats are the point: un-selling them here would hand away a seat
    // whose charge may already have gone through.
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
  });

  it('still treats a settled payment as terminal', async () => {
    const reservationId = await confirmWith(api.seatIds[1]!);
    const payment = await paymentFor(api.db, reservationId);
    await api.app.get(ReservationService).settlePayment(payment!.id, {
      status: 'SUCCEEDED',
      providerRef: 'ch_test',
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // CONFIRMED reaches the existing terminal branch unchanged; only
    // PAYMENT_PENDING gets the new answer.
    await expect(service.settleExpired(reservationId)).resolves.toBe('terminal');
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
  });

  it('leaves a payment that has not yet reached its deadline alone', async () => {
    const reservationId = await confirmWith(api.seatIds[2]!);

    // Someone else asks for the same seat. The sweep runs, and must not take a
    // seat from a payment that is only seconds old.
    const response = await api.hold([api.seatIds[2]!], randomUUID());
    expect(response.statusCode).toBe(409);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
  });

  it('reaps a payment that never came back and frees its seats', async () => {
    const reservationId = await confirmWith(api.seatIds[3]!);
    const payment = await paymentFor(api.db, reservationId);
    // The message reached the DLQ, or the worker died holding it. Nothing will
    // ever settle this row, and PAYMENT_DEADLINE_SECONDS is how long we wait
    // before saying so.
    await agePayment(api.db, payment!.id, 400);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const response = await api.hold([api.seatIds[3]!], randomUUID());

    expect(response.statusCode).toBe(201);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
    // The payment is marked too: a PENDING payment row against a PAYMENT_FAILED
    // reservation would be a lie in the ledger.
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'FAILED' });
  });

  it('reaps stale holds and abandoned payments in the same sweep', async () => {
    const abandoned = await confirmWith(api.seatIds[4]!);
    const payment = await paymentFor(api.db, abandoned);
    await agePayment(api.db, payment!.id, 400);

    const stale = await api.holdOne(api.seatIds[5]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const response = await api.hold([api.seatIds[4]!, api.seatIds[5]!], randomUUID());

    expect(response.statusCode).toBe(201);
    expect(await reservationStatus(api.db, abandoned)).toBe('PAYMENT_FAILED');
    expect(await reservationStatus(api.db, stale.id)).toBe('EXPIRED');
  });
});
