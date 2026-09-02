import { randomUUID } from 'node:crypto';

import type { Channel, ChannelModel } from 'amqplib';
import { sql } from 'drizzle-orm';

import { COMMANDS_EXCHANGE, EXPIRE_KEY, EXPIRE_QUEUE } from '../src/messaging/messages';
import { getTestRabbitUrl } from './harness';
import {
  deleteTopology,
  openInspection,
  queueDepth,
  startWorkerHarness,
  type WorkerHarness,
} from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

/** Publishes straight onto the work queue's key, skipping the ten-minute wait. */
function publishExpire(channel: Channel, reservationId: string): void {
  channel.publish(
    COMMANDS_EXCHANGE,
    EXPIRE_KEY,
    Buffer.from(JSON.stringify({ reservationId }), 'utf8'),
    { persistent: true, contentType: 'application/json', headers: { 'x-attempt': 0 } },
  );
}

/**
 * Polls a condition rather than sleeping a fixed time, so the suite is not paced
 * by its slowest machine.
 */
async function until(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition was not met in time');
}

describe('the expiry consumer', () => {
  let api: ReservationHarness;
  let worker: WorkerHarness;
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    ({ connection, channel } = await openInspection(getTestRabbitUrl()));
    await deleteTopology(connection, 3);
    // `queue` mode, because the last case in this suite rides the real
    // wait -> work path the API publishes into.
    // Both harnesses declare the same queues, so both MUST be given the same
    // TTL and the same ladder: queue arguments are part of a queue's identity,
    // and a mismatch is PRECONDITION_FAILED on whichever declares second.
    api = await startReservationHarness({
      lockStrategy: 'redis',
      ttlSeconds: 1,
      expiryMode: 'queue',
      retryDelaysMs: [100, 200, 400],
    });
    worker = await startWorkerHarness({ ttlSeconds: 1, retryDelaysMs: [100, 200, 400] });
  });

  afterAll(async () => {
    await worker.close();
    await api.close();
    await channel.close();
    await connection.close();
  });

  beforeEach(async () => {
    await truncateReservations(api.db, api.redis);
  });

  const statusOf = async (id: string): Promise<string | undefined> => {
    const result = await api.db.execute<{ status: string }>(
      sql`SELECT status FROM reservations WHERE id = ${id}`,
    );
    return result.rows[0]?.status;
  };

  it('expires a lapsed hold without any caller asking for the seats', async () => {
    const reservation = await api.holdOne(api.seatIds[0]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    publishExpire(channel, reservation.id);

    // Nobody calls the API here. That is the entire point of the sub-project:
    // the row settles because a message was delivered, not because someone
    // wanted the seat (spec §1).
    await until(async () => (await statusOf(reservation.id)) === 'EXPIRED');
    await expect(queueDepth(channel, EXPIRE_QUEUE)).resolves.toBe(0);
  });

  it('acknowledges a message for a reservation that no longer exists', async () => {
    publishExpire(channel, randomUUID());

    // Acked, not requeued: a message whose row is gone has nothing to retry.
    await until(async () => (await queueDepth(channel, EXPIRE_QUEUE)) === 0);
  });

  it('leaves a confirmed reservation alone', async () => {
    const session = randomUUID();
    const reservation = await api.holdOne(api.seatIds[1]!, session);
    await api.act('POST', `/${reservation.id}/confirm`, session);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const before = worker.consumer.handledCount;
    publishExpire(channel, reservation.id);
    await until(async () => worker.consumer.handledCount > before);

    await expect(statusOf(reservation.id)).resolves.toBe('CONFIRMED');
  });

  it('handles a duplicate delivery exactly once in effect', async () => {
    const reservation = await api.holdOne(api.seatIds[2]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    publishExpire(channel, reservation.id);
    publishExpire(channel, reservation.id);

    await until(async () => worker.consumer.handledCount >= 2);
    await expect(statusOf(reservation.id)).resolves.toBe('EXPIRED');

    const released = await api.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM reservation_seats
      WHERE reservation_id = ${reservation.id} AND released_at IS NOT NULL
    `);
    // One seat, released once. A second release would be a second timestamp on
    // the same row, which is how a non-idempotent handler would show up here.
    expect(Number(released.rows[0]!.count)).toBe(1);
  });

  it('carries the whole ten-minute path when the wait queue is used', async () => {
    // The only test that exercises wait -> work end to end. The harness sets the
    // wait TTL to one second, so this is the real mechanism at a testable scale.
    const reservation = await api.holdOne(api.seatIds[3]!);

    await until(async () => (await statusOf(reservation.id)) === 'EXPIRED', 20_000);
  });
});
