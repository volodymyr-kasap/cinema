import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { PaymentService } from '../src/payments/payment.service';
import { ProviderUnavailableError } from '../src/payments/payment-provider.client';
import { seatKey } from '../src/locking/seat-lock';
import { getTestProviderUrl, getTestRabbitUrl } from './harness';
import {
  activeSeatCount,
  paymentFor,
  reservationStatus,
  startPaymentWorkerHarness,
  type PaymentWorkerHarness,
} from './payment-harness';
import { deleteTopology, openInspection } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('settling a payment', () => {
  let api: ReservationHarness;
  let worker: PaymentWorkerHarness;
  let payments: PaymentService;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

  /** Confirms a hold and returns the payment id the confirm created. */
  const startPayment = async (
    seat: string,
    scenario?: string,
  ): Promise<{ reservationId: string; paymentId: string }> => {
    const session = randomUUID();
    const reservation = await api.holdOne(seat, session);
    await api.app.inject({
      method: 'POST',
      url: `/api/v1/reservations/${reservation.id}/confirm`,
      headers: { 'x-session-id': session, ...(scenario ? { 'x-payment-scenario': scenario } : {}) },
    });
    const payment = await paymentFor(api.db, reservation.id);
    return { reservationId: reservation.id, paymentId: payment!.id };
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
      ttlSeconds: 600,
    });
    worker = await startPaymentWorkerHarness({ consume: false });
    payments = worker.payments;
  });

  afterAll(async () => {
    await worker.close();
    await api.close();
    await inspection.channel.close().catch(() => {});
    await inspection.connection.close().catch(() => {});
  });

  beforeEach(async () => {
    await truncateReservations(api.db, api.redis);
  });

  it('confirms the reservation when the provider charges', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[0]!, 'success');

    await expect(payments.settle(paymentId)).resolves.toBe('confirmed');

    expect(await reservationStatus(api.db, reservationId)).toBe('CONFIRMED');
    const payment = await paymentFor(api.db, reservationId);
    expect(payment).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(payment!.providerRef).toMatch(/^ch_/);
    expect(payment!.settledAt).not.toBeNull();
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
  });

  it('retains the seat lock on success, rather than releasing it', async () => {
    const { paymentId } = await startPayment(api.seatIds[1]!, 'success');
    await payments.settle(paymentId);

    // Not released: a confirmed seat is never free again, and dropping the key
    // would invite the next request to take the lock, open a transaction and be
    // refused by the index — exactly the work the lock exists to avoid.
    await expect(api.redis!.exists(seatKey(api.showtimeId, api.seatIds[1]!))).resolves.toBe(1);
  });

  it('fails the reservation and frees the seats when the card is declined', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[2]!, 'decline');

    await expect(payments.settle(paymentId)).resolves.toBe('failed');

    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'DECLINED' });
    // PAYMENT_FAILED behaves exactly like EXPIRED as far as the seat pool is
    // concerned: a hold that did not become a sale gives the seats back.
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
    await expect(api.redis!.exists(seatKey(api.showtimeId, api.seatIds[2]!))).resolves.toBe(0);
  });

  it('throws rather than settling when the provider cannot answer', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[3]!, 'error');

    await expect(payments.settle(paymentId)).rejects.toBeInstanceOf(ProviderUnavailableError);

    // Nothing is decided. The message will climb the ladder and try again, and
    // the seats stay held while it does.
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({
      status: 'PENDING',
      attempts: 1,
    });
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
  });

  it('counts every attempt, including the ones that failed', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[4]!, 'error');

    await expect(payments.settle(paymentId)).rejects.toThrow();
    await expect(payments.settle(paymentId)).rejects.toThrow();

    // From the database alone you can tell a payment that worked first time
    // from one that took three goes. x-attempt cannot tell you that: it lives
    // in the message and dies with it.
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ attempts: 2 });
  });

  it('does nothing for a payment that does not exist', async () => {
    await expect(payments.settle(randomUUID())).resolves.toBe('not-found');
  });

  it('does nothing for a payment that already settled', async () => {
    const { paymentId } = await startPayment(api.seatIds[5]!, 'success');
    await payments.settle(paymentId);

    // The duplicate delivery. This is the case that makes at-least-once safe
    // without a dedupe table, and getting it wrong charges twice.
    await expect(payments.settle(paymentId)).resolves.toBe('terminal');
  });

  it('does nothing when the reservation left PAYMENT_PENDING underneath it', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[6]!, 'success');
    await api.db.execute(
      sql`UPDATE reservations SET status = 'PAYMENT_FAILED' WHERE id = ${reservationId}`,
    );

    await expect(payments.settle(paymentId)).resolves.toBe('stale');
  });

  it('abandons a payment when the ladder is exhausted', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[7]!, 'error');

    await expect(payments.abandon(paymentId, 'retries exhausted')).resolves.toBe('failed');

    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'FAILED' });
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    // The seats come back immediately rather than waiting for someone to read
    // the DLQ: leaving them held would mean selling the hall at the speed of
    // whoever is on call.
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
  });
});
