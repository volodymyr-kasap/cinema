import { randomUUID } from 'node:crypto';

import { reservationSchema } from '@cinema/contracts';
import { sql } from 'drizzle-orm';

import { PAYMENT_QUEUE, paymentMessageSchema } from '../src/messaging/messages';
import { getTestRabbitUrl } from './harness';
import { activeSeatCount, paymentFor, reservationStatus } from './payment-harness';
import { deleteTopology, openInspection, queueDepth, takeOne } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('confirm starts a payment', () => {
  let h: ReservationHarness;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

  beforeAll(async () => {
    inspection = await openInspection(getTestRabbitUrl());
    // Earlier suites declare these queues with millisecond TTLs; re-declaring
    // with different arguments is a 406 that kills the channel.
    await deleteTopology(inspection.connection, 3);

    h = await startReservationHarness({
      expiryMode: 'queue',
      paymentMode: 'queue',
      // Confirm only publishes payment.requested here; nothing in this suite
      // calls the provider, so a syntactically valid URL satisfies env
      // validation without needing Task 7's provider harness wired up yet.
      paymentProviderUrl: 'http://127.0.0.1:1',
      rabbitmqUrl: getTestRabbitUrl(),
      ttlSeconds: 600,
    });
  });

  afterAll(async () => {
    await h.close();
    await inspection.channel.close().catch(() => {});
    await inspection.connection.close().catch(() => {});
  });

  beforeEach(async () => {
    await truncateReservations(h.db, h.redis);
    // Truncating the tables does not drain the broker: a message published by
    // one test and never consumed would be the one `takeOne` hands back to the
    // next, naming a payment that test never made (the same reason
    // expire-publisher.e2e.spec.ts purges EXPIRE_WAIT_QUEUE here).
    await inspection.channel.purgeQueue(PAYMENT_QUEUE);
  });

  it('answers 202 with PAYMENT_PENDING rather than 200 CONFIRMED', async () => {
    const session = randomUUID();
    const reservation = await h.holdOne(h.seatIds[0]!, session);

    const response = await h.act('POST', `/${reservation.id}/confirm`, session);

    expect(response.statusCode).toBe(202);
    const body = reservationSchema.parse(response.json());
    expect(body.status).toBe('PAYMENT_PENDING');
    expect(body.payment).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('writes one payment row for the reservation total', async () => {
    const session = randomUUID();
    const reservation = await h.holdOne(h.seatIds[1]!, session);
    await h.act('POST', `/${reservation.id}/confirm`, session);

    const payment = await paymentFor(h.db, reservation.id);
    expect(payment).toMatchObject({
      status: 'PENDING',
      amountCents: reservation.totalPriceCents,
      providerRef: null,
      attempts: 0,
    });
  });

  it('publishes exactly one message naming that payment', async () => {
    const session = randomUUID();
    const reservation = await h.holdOne(h.seatIds[2]!, session);
    await h.act('POST', `/${reservation.id}/confirm`, session);

    const message = await takeOne(inspection.channel, PAYMENT_QUEUE, 5_000);
    const body = paymentMessageSchema.parse(JSON.parse(message.content.toString('utf8')));

    const payment = await paymentFor(h.db, reservation.id);
    expect(body.paymentId).toBe(payment!.id);
    // The id and nothing else. A body carrying the amount could be acted on
    // after the row moved underneath it (ADR 0027).
    expect(Object.keys(JSON.parse(message.content.toString('utf8')))).toEqual(['paymentId']);
    expect(message.properties.messageId).toBe(payment!.id);
  });

  it('does not move expires_at', async () => {
    const session = randomUUID();
    const reservation = await h.holdOne(h.seatIds[3]!, session);
    const before = reservation.expiresAt;

    await h.act('POST', `/${reservation.id}/confirm`, session);

    const after = reservationSchema.parse(
      (await h.act('GET', `/${reservation.id}`, session)).json(),
    ).expiresAt;
    // reservation.expire.wait is correct only because every hold shares one TTL
    // (ADR 0024). Extending one row's deadline would require replacing that
    // queue, so PAYMENT_PENDING changes who owns the seats, not when the hold
    // ends (ADR 0036).
    expect(after).toBe(before);
  });

  it('is idempotent: five confirms make one payment and one message', async () => {
    const session = randomUUID();
    const reservation = await h.holdOne(h.seatIds[4]!, session);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => h.act('POST', `/${reservation.id}/confirm`, session)),
    );

    // Every one of them answers 202 with the same state: the operation the
    // caller asked for is already happening, which is not an error. No
    // Idempotency-Key is involved -- the reservation id in the path already
    // names the operation uniquely (ADR 0035).
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202, 202, 202, 202]);
    for (const response of responses) {
      expect(reservationSchema.parse(response.json()).status).toBe('PAYMENT_PENDING');
    }

    const rows = await h.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM payments WHERE reservation_id = ${reservation.id}`,
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
    expect(await queueDepth(inspection.channel, PAYMENT_QUEUE)).toBe(1);
  });

  it('refuses to cancel a reservation that is paying', async () => {
    const session = randomUUID();
    const reservation = await h.holdOne(h.seatIds[5]!, session);
    await h.act('POST', `/${reservation.id}/confirm`, session);

    const response = await h.act('DELETE', `/${reservation.id}`, session);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ type: expect.stringContaining('payment-in-flight') });
    // The seats stay held: the money may already have moved.
    expect(await activeSeatCount(h.db, reservation.id)).toBe(1);
  });

  it('keeps phase 2 behaviour when PAYMENT_MODE is off', async () => {
    // Explicit, not omitted: the outer harness `h` is still open and holds
    // PAYMENT_MODE=queue in process.env for the duration of this describe
    // block, and an omitted override leaves whatever is already there rather
    // than resetting to the schema default.
    const off = await startReservationHarness({ ttlSeconds: 600, paymentMode: 'off' });
    try {
      const session = randomUUID();
      const reservation = await off.holdOne(off.seatIds[6]!, session);
      const response = await off.act('POST', `/${reservation.id}/confirm`, session);

      expect(response.statusCode).toBe(200);
      expect(reservationSchema.parse(response.json()).status).toBe('CONFIRMED');
      expect(await paymentFor(off.db, reservation.id)).toBeNull();
    } finally {
      await off.close();
    }
  });

  it('rolls the hold back and answers 503 when the broker will not take the message', async () => {
    // A closed port, so the publish confirmation never arrives.
    const dead = await startReservationHarness({
      expiryMode: 'queue',
      paymentMode: 'queue',
      paymentProviderUrl: 'http://127.0.0.1:1',
      rabbitmqUrl: 'amqp://127.0.0.1:1',
      ttlSeconds: 600,
    });
    try {
      const session = randomUUID();
      const reservation = await dead.holdOne(dead.seatIds[7]!, session);
      const response = await dead.act('POST', `/${reservation.id}/confirm`, session);

      expect(response.statusCode).toBe(503);
      // The whole transaction went back, which is the point of publishing
      // inside it: the hold is still the caller's and still retryable.
      expect(await reservationStatus(dead.db, reservation.id)).toBe('PENDING');
      expect(await paymentFor(dead.db, reservation.id)).toBeNull();
      expect(await activeSeatCount(dead.db, reservation.id)).toBe(1);
    } finally {
      await dead.close();
    }
  });
});
