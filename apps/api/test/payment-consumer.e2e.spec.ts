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

  // Short, matching the ladder in every consumer suite: a queue's arguments
  // are part of its identity, and the reservation harness and the worker
  // harness would otherwise fight over declaring PAYMENT_QUEUE with different
  // ones (PRECONDITION_FAILED, 406). Kept short so the "does not exist" test
  // below, which now climbs all three tiers before dead-lettering, does not
  // wait on production timings (the real ladder's first hop alone is 5s).
  const retryDelaysMs = [100, 200, 400];

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
      retryDelaysMs,
    });
    worker = await startPaymentWorkerHarness({ providerUrl: getTestProviderUrl(), retryDelaysMs });
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

  it('climbs the ladder and dead-letters a message whose payment never existed', async () => {
    // The rolled-back-after-publish case -- except settleWithGrace can no
    // longer tell it apart, from the row alone, from a payment whose
    // producing transaction just hasn't committed yet (see payment.consumer.ts).
    // So it is no longer a silent, single-tick drop: the grace window expires,
    // the message climbs the ladder same as a provider failure, and every hop
    // reports the same "not-found" until it dead-letters -- four handled
    // ticks (the original delivery plus one per retry tier), not one. A
    // stranded hold would be the worse failure; a DLQ entry is visible.
    inspection.channel.publish(
      COMMANDS_EXCHANGE,
      PAYMENT_KEY,
      Buffer.from(JSON.stringify({ paymentId: randomUUID() })),
      { persistent: true },
    );
    await settled(1 + retryDelaysMs.length);

    expect(await queueDepth(inspection.channel, PAYMENT_QUEUE)).toBe(0);
    expect(await queueDepth(inspection.channel, 'payment.requested.dlq')).toBe(1);
    await inspection.channel.purgeQueue('payment.requested.dlq');
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
