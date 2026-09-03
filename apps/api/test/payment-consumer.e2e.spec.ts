import { randomUUID } from 'node:crypto';

import { COMMANDS_EXCHANGE, PAYMENT_KEY, PAYMENT_QUEUE } from '../src/messaging/messages';
import { getTestProviderUrl, getTestRabbitUrl } from './harness';
import {
  activeSeatCount,
  paymentFor,
  reservationStatus,
  startPaymentWorkerHarness,
  type PaymentWorkerHarness,
} from './payment-harness';
import { deleteTopology, openInspection, queueDepth } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('the payment consumer', () => {
  let api: ReservationHarness;
  let worker: PaymentWorkerHarness;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

  /**
   * Waits for the consumer to take `n` messages to a conclusion.
   *
   * `baseline` defaults to a snapshot taken when `settled` itself is called,
   * which is correct for the tests below that publish synchronously and then
   * call `settled` right away -- the broker round trip has not happened yet,
   * so nothing has been handled. It is NOT correct after `confirmWith`: on a
   * warm connection the consumer's whole round trip (claim, provider call,
   * write, ack) has been observed finishing in low single-digit milliseconds,
   * faster than `app.inject`'s own remaining commit-and-respond work -- so a
   * snapshot taken after awaiting `confirmWith` can already be stale by the
   * one message it was meant to count. `confirmWith` hands back a snapshot
   * taken immediately before it fires the request, for exactly that case.
   */
  const settled = async (
    n: number,
    baseline = worker.consumer.handledCount,
    timeoutMs = 10_000,
  ): Promise<void> => {
    const target = baseline + n;
    const deadline = Date.now() + timeoutMs;
    while (worker.consumer.handledCount < target) {
      if (Date.now() > deadline) {
        throw new Error(`only ${String(worker.consumer.handledCount)} messages handled`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const confirmWith = async (
    seat: string,
    scenario: string,
  ): Promise<{ reservationId: string; before: number }> => {
    const session = randomUUID();
    const reservation = await api.holdOne(seat, session);
    const before = worker.consumer.handledCount;
    await api.app.inject({
      method: 'POST',
      url: `/api/v1/reservations/${reservation.id}/confirm`,
      headers: { 'x-session-id': session, 'x-payment-scenario': scenario },
    });
    return { reservationId: reservation.id, before };
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
    worker = await startPaymentWorkerHarness({ providerUrl: getTestProviderUrl() });
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

  it('carries a hold all the way to CONFIRMED without anyone asking again', async () => {
    const { reservationId, before } = await confirmWith(api.seatIds[0]!, 'success');
    await settled(1, before);

    expect(await reservationStatus(api.db, reservationId)).toBe('CONFIRMED');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await queueDepth(inspection.channel, PAYMENT_QUEUE)).toBe(0);
  });

  it('carries a declined card to PAYMENT_FAILED and frees the seats', async () => {
    const { reservationId, before } = await confirmWith(api.seatIds[1]!, 'decline');
    await settled(1, before);

    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
  });

  it('drops a message whose payment does not exist', async () => {
    // The rolled-back-after-publish case. It is not an error and must not be
    // retried: the transaction that would have created this row went away.
    inspection.channel.publish(
      COMMANDS_EXCHANGE,
      PAYMENT_KEY,
      Buffer.from(JSON.stringify({ paymentId: randomUUID() })),
      { persistent: true },
    );
    await settled(1);
    expect(await queueDepth(inspection.channel, PAYMENT_QUEUE)).toBe(0);
  });

  it('absorbs a duplicate delivery without charging twice', async () => {
    const { reservationId, before } = await confirmWith(api.seatIds[2]!, 'success');
    await settled(1, before);
    const first = await paymentFor(api.db, reservationId);

    inspection.channel.publish(
      COMMANDS_EXCHANGE,
      PAYMENT_KEY,
      Buffer.from(JSON.stringify({ paymentId: first!.id })),
      { persistent: true },
    );
    await settled(1);

    const second = await paymentFor(api.db, reservationId);
    // Same reference, same attempt count: the redelivery never reached the
    // provider, because claimPayment saw a payment that was no longer PENDING.
    expect(second).toEqual(first);
  });

  it('sends an unparseable body straight to the dead-letter queue', async () => {
    inspection.channel.publish(COMMANDS_EXCHANGE, PAYMENT_KEY, Buffer.from('not json'), {
      persistent: true,
    });
    await settled(1);

    // A body that does not parse will not parse in thirty seconds either, so
    // retrying it only delays the diagnosis.
    expect(await queueDepth(inspection.channel, 'payment.requested.dlq')).toBe(1);
    await inspection.channel.purgeQueue('payment.requested.dlq');
  });

  it('stops taking messages when it is cancelled', async () => {
    await worker.consumer.unsubscribe();
    try {
      await confirmWith(api.seatIds[3]!, 'success');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await queueDepth(inspection.channel, PAYMENT_QUEUE)).toBe(1);
    } finally {
      await worker.consumer.subscribe();
    }
    await settled(1);
  });
});
