import type { Channel, ChannelModel } from 'amqplib';

import {
  COMMANDS_EXCHANGE,
  EXPIRE_DLQ,
  EXPIRE_QUEUE,
  EXPIRE_WAIT_QUEUE,
  retryQueue,
} from '../src/messaging/messages';
import { assertTopology } from '../src/messaging/topology';
import { getTestRabbitUrl } from './harness';
import { deleteTopology, openInspection, takeOne } from './rabbit-harness';

const options = { reservationTtlSeconds: 1, retryDelaysMs: [100, 200, 400] };

describe('the reservation.expire topology', () => {
  let connection: ChannelModel;
  let channel: Channel;

  beforeEach(async () => {
    ({ connection, channel } = await openInspection(getTestRabbitUrl()));
    // Queues are declared with per-suite TTLs, and re-declaring an existing
    // queue with different arguments is PRECONDITION_FAILED. Every suite
    // therefore starts by removing what an earlier one left.
    await deleteTopology(connection, 3);
  });

  afterEach(async () => {
    await channel.close();
    await connection.close();
  });

  it('declares every queue', async () => {
    await assertTopology(channel, options);

    for (const queue of [
      EXPIRE_WAIT_QUEUE,
      EXPIRE_QUEUE,
      EXPIRE_DLQ,
      retryQueue(1),
      retryQueue(2),
      retryQueue(3),
    ]) {
      await expect(channel.checkQueue(queue)).resolves.toMatchObject({ queue });
    }
  });

  it('declares one retry queue per configured delay, and no more', async () => {
    await assertTopology(channel, { reservationTtlSeconds: 1, retryDelaysMs: [100] });

    await expect(channel.checkQueue(retryQueue(1))).resolves.toMatchObject({
      queue: retryQueue(1),
    });
    // checkQueue on a missing queue closes the channel, so this assertion needs
    // its own -- which is also why the production code never uses checkQueue.
    const { connection: c2, channel: probe } = await openInspection(getTestRabbitUrl());
    await expect(probe.checkQueue(retryQueue(2))).rejects.toThrow();
    await c2.close();
  });

  it('can be asserted twice on the same channel', async () => {
    // The reconnect hook calls this on every successful connection. If it were
    // not idempotent, the first reconnection would kill the channel it had just
    // opened (spec §3).
    await assertTopology(channel, options);
    await assertTopology(channel, options);

    await expect(channel.checkQueue(EXPIRE_QUEUE)).resolves.toMatchObject({ queue: EXPIRE_QUEUE });
  });

  it('routes a message from the wait queue to the work queue when its ttl lapses', async () => {
    await assertTopology(channel, options);

    channel.publish(COMMANDS_EXCHANGE, EXPIRE_WAIT_QUEUE, Buffer.from('{}'), { persistent: true });

    // One second of wait-queue TTL, then the broker moves it. Nothing in our
    // code is involved: this asserts the mechanism, not our use of it.
    const delivered = await takeOne(channel, EXPIRE_QUEUE, 10_000);
    expect(delivered.content.toString('utf8')).toBe('{}');
    expect(delivered.properties.headers?.['x-death']).toBeDefined();
  });
});
