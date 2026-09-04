import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { PAYMENT_DLQ, PAYMENT_QUEUE } from '../src/messaging/messages';
import { PaymentProviderClient } from '../src/payments/payment-provider.client';
import { getTestProviderUrl, getTestRabbitUrl } from './harness';
import {
  activeSeatCount,
  paymentFor,
  reservationStatus,
  startPaymentWorkerHarness,
  type PaymentWorkerHarness,
} from './payment-harness';
import { deleteTopology, openInspection, queueDepth, takeOne } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('payment under failure', () => {
  let api: ReservationHarness;
  let worker: PaymentWorkerHarness;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

  // Milliseconds, not the production minutes: the ladder's shape is what is
  // under test, not its duration.
  const retryDelaysMs = [200, 400];

  /**
   * `baseline` defaults to a snapshot taken when `settled` itself is called.
   * That default is only safe for callers that have not just raced the worker
   * -- for a plain DB mutation (this file's mid-test `UPDATE payments SET
   * scenario = ...` calls) nothing else is advancing `handledCount` between
   * the mutation and the call, so "now" is an accurate baseline. It is NOT
   * safe after `confirmWith`: `payment.requested` is published inside the
   * confirming transaction before commit (ADR 0037), and against real
   * containers the consumer's whole round trip -- claim, provider call,
   * write, ack -- has been observed completing before `app.inject`'s own
   * remaining commit-and-respond work does, fastest for a provider that
   * refuses the connection outright (no HTTP round trip to wait on at all).
   * A baseline taken after awaiting `confirmWith` can already be stale by the
   * one handling it was meant to count, which turns `settled` into a wait for
   * an event that already happened and will not happen again. `confirmWith`
   * hands back a snapshot taken immediately before it fires the request, for
   * exactly that case.
   */
  const settled = async (
    n: number,
    baseline = worker.consumer.handledCount,
    timeoutMs = 15_000,
  ): Promise<void> => {
    const target = baseline + n;
    const deadline = Date.now() + timeoutMs;
    while (worker.consumer.handledCount < target) {
      if (Date.now() > deadline) {
        throw new Error(
          `expected ${String(n)} more handled from a baseline of ${String(baseline)}, saw ${String(worker.consumer.handledCount)}`,
        );
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
      // Both harnesses MUST agree: queue arguments are part of a queue's
      // identity, and a mismatch is a 406 that kills the channel.
      retryDelaysMs,
    });
  });

  afterAll(async () => {
    await api.close();
    await inspection.channel.close().catch(() => {});
    await inspection.connection.close().catch(() => {});
  });

  beforeEach(async () => {
    await truncateReservations(api.db, api.redis);
    await inspection.channel.purgeQueue(PAYMENT_DLQ).catch(() => {});
  });

  afterEach(async () => {
    await worker.close();
  });

  it('retries a 500 and succeeds when the provider recovers', async () => {
    // The provider answers by header, so "recovery" is the second attempt
    // arriving without the error scenario. The payment row remembers the
    // scenario, so instead the test clears it between attempts.
    worker = await startPaymentWorkerHarness({
      providerUrl: getTestProviderUrl(),
      retryDelaysMs,
    });

    const { reservationId, before } = await confirmWith(api.seatIds[0]!, 'error');
    await settled(1, before);

    // Attempt 1 failed and the message is on tier 1, not lost and not dead.
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({
      status: 'PENDING',
      attempts: 1,
    });

    const payment = await paymentFor(api.db, reservationId);
    await api.db.execute(sql`UPDATE payments SET scenario = 'success' WHERE id = ${payment!.id}`);

    await settled(1);
    expect(await reservationStatus(api.db, reservationId)).toBe('CONFIRMED');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
    });
  });

  it('dead-letters after the ladder is exhausted and frees the seats', async () => {
    worker = await startPaymentWorkerHarness({
      providerUrl: getTestProviderUrl(),
      retryDelaysMs,
    });

    const { reservationId, before } = await confirmWith(api.seatIds[1]!, 'error');
    // Two tiers means three handlings: the first attempt plus two retries.
    await settled(3, before);

    const message = await takeOne(inspection.channel, PAYMENT_DLQ, 5_000);
    expect(message.properties.headers?.['x-attempt']).toBe(3);

    expect(await paymentFor(api.db, reservationId)).toMatchObject({
      status: 'FAILED',
      attempts: 3,
    });
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    // Freed at the moment we gave up, not when a human reads the DLQ.
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
  });

  it('recovers a lost response instead of charging twice', async () => {
    // spec.md section 11, end to end. The provider records its decision before
    // hanging, so attempt 1 charges and never answers; attempt 2 presents the
    // same Idempotency-Key and is handed the stored SUCCEEDED.
    worker = await startPaymentWorkerHarness({
      providerUrl: getTestProviderUrl(),
      retryDelaysMs,
      timeoutMs: 300,
    });

    const { reservationId, before } = await confirmWith(api.seatIds[2]!, 'timeout');
    await settled(1, before);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');

    const payment = await paymentFor(api.db, reservationId);
    await api.db.execute(sql`UPDATE payments SET scenario = NULL WHERE id = ${payment!.id}`);

    await settled(1);

    const settledPayment = await paymentFor(api.db, reservationId);
    expect(await reservationStatus(api.db, reservationId)).toBe('CONFIRMED');
    expect(settledPayment).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    // One charge. The provider replayed rather than charged, which is only
    // true because the key is payments.id and did not change between attempts.
    expect(settledPayment!.providerRef).toMatch(/^ch_/);
  });

  it('opens the breaker against a dead provider and stops calling it', async () => {
    worker = await startPaymentWorkerHarness({
      providerUrl: 'http://127.0.0.1:1',
      retryDelaysMs,
      breakerThreshold: 2,
      breakerOpenMs: 60_000,
      timeoutMs: 300,
    });
    // Reached through the worker's own module graph rather than a second
    // instance: the breaker is per-process state on PaymentProviderClient, and
    // asserting on `worker.payments.breakerState` alone only proves the state
    // machine reports OPEN, not that nothing is dialing out underneath it.
    const provider = worker.context.get(PaymentProviderClient);

    // Taken before the first confirm, not after the third: connecting to a
    // port nothing listens on refuses near-instantly, faster than the other
    // two confirms' own DB round trips, so the first message can already be
    // on its way to a retry before the third `confirmWith` call even returns.
    const before = worker.consumer.handledCount;
    await confirmWith(api.seatIds[3]!, 'success');
    await confirmWith(api.seatIds[4]!, 'success');
    await confirmWith(api.seatIds[5]!, 'success');
    await settled(3, before);

    expect(worker.payments.breakerState).toBe('OPEN');
    const rejectedBeforeRetries = provider.breakerRejections;

    // Every later attempt is refused locally. The ladder still runs -- the
    // breaker decides whether to call, the ladder decides when to try again --
    // so the reservations still end in PAYMENT_FAILED rather than hanging.
    await settled(6, undefined, 20_000);
    expect(await queueDepth(inspection.channel, PAYMENT_QUEUE)).toBe(0);
    // The assertion that actually matters: a breaker that reports OPEN while
    // still calling the downstream is a logging decorator. breakerOpenMs is
    // 60s, far longer than these six handlings take, so the breaker cannot
    // have half-opened and tried a trial call in between -- every one of the
    // six remaining handlings must have been refused locally, with zero new
    // connection attempts.
    expect(provider.breakerRejections - rejectedBeforeRetries).toBe(6);
  });

  it('keeps answering confirms while the provider is down', async () => {
    worker = await startPaymentWorkerHarness({
      providerUrl: 'http://127.0.0.1:1',
      retryDelaysMs,
      timeoutMs: 300,
    });

    const started = Date.now();
    const { reservationId, before } = await confirmWith(api.seatIds[6]!, 'success');
    // The API never touches the provider: it publishes and answers. A dead
    // downstream must not appear in a user's latency.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');

    // Drains what this test published before `afterEach` tears the worker
    // down. `unsubscribe` only cancels new deliveries -- it does not wait for
    // one already on its way from the broker -- so an undrained message here
    // can still arrive after this test's worker has cancelled its consumer,
    // sit in the queue, and be picked up by the NEXT test's fresh worker
    // instead: a stray handling that does not belong to that test's own
    // reservation, and that quietly corrupts its handled-count bookkeeping.
    await settled(3, before, 20_000);
  });

  it('gives the seats back after the ladder runs out, so the hall is not lost', async () => {
    worker = await startPaymentWorkerHarness({
      providerUrl: 'http://127.0.0.1:1',
      retryDelaysMs,
      timeoutMs: 300,
    });

    const { reservationId, before } = await confirmWith(api.seatIds[7]!, 'success');
    await settled(3, before);

    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);

    // And the seat is genuinely re-sellable, which is the assertion that
    // matters to a cinema.
    const response = await api.hold([api.seatIds[7]!], randomUUID());
    expect(response.statusCode).toBe(201);
  });
});
