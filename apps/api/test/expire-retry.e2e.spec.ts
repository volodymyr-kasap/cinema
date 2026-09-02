import { randomUUID } from 'node:crypto';

import type { Channel, ChannelModel } from 'amqplib';

import {
  COMMANDS_EXCHANGE,
  EXPIRE_DLQ,
  EXPIRE_KEY,
  EXPIRE_QUEUE,
  retryQueue,
} from '../src/messaging/messages';
import { getTestRabbitUrl } from './harness';
import {
  deleteTopology,
  openInspection,
  queueDepth,
  startWorkerHarness,
  takeOne,
  type WorkerHarness,
} from './rabbit-harness';

const ladder = [100, 200, 400];

function publish(channel: Channel, body: string, attempt = 0): void {
  channel.publish(COMMANDS_EXCHANGE, EXPIRE_KEY, Buffer.from(body, 'utf8'), {
    persistent: true,
    contentType: 'application/json',
    headers: { 'x-attempt': attempt },
  });
}

describe('a handler that keeps failing', () => {
  let worker: WorkerHarness;
  let connection: ChannelModel;
  let channel: Channel;
  let attempts: number[];

  beforeAll(async () => {
    ({ connection, channel } = await openInspection(getTestRabbitUrl()));
    await deleteTopology(connection, 3);

    attempts = [];
    worker = await startWorkerHarness({
      ttlSeconds: 1,
      retryDelaysMs: ladder,
      settle: () => {
        attempts.push(Date.now());
        return Promise.reject(new Error('the database said no'));
      },
    });
  });

  afterAll(async () => {
    await worker.close();
    await channel.close();
    await connection.close();
  });

  it('walks every tier and ends in the dead-letter queue', async () => {
    const id = randomUUID();
    publish(channel, JSON.stringify({ reservationId: id }));

    const dead = await takeOne(channel, EXPIRE_DLQ, 20_000);

    // Three tiers, so four handler runs: the original delivery plus one per
    // tier. The header records the last of them.
    expect(attempts).toHaveLength(ladder.length + 1);
    expect(dead.properties.headers?.['x-attempt']).toBe(ladder.length + 1);
    expect(JSON.parse(dead.content.toString('utf8'))).toEqual({ reservationId: id });
  });

  it('waits each tier delay between attempts rather than retrying immediately', async () => {
    attempts.length = 0;
    publish(channel, JSON.stringify({ reservationId: randomUUID() }));
    await takeOne(channel, EXPIRE_DLQ, 20_000);

    // The point of the ladder: a handler failing on a transient blip must not
    // burn its whole budget in milliseconds, which is what a quorum queue's
    // x-delivery-limit would have done (ADR 0032). Compared loosely because a
    // broker's TTL sweep is not a stopwatch.
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index]!);
    expect(gaps[0]).toBeGreaterThanOrEqual(ladder[0]! * 0.5);
    expect(gaps[1]).toBeGreaterThanOrEqual(ladder[1]! * 0.5);
    expect(gaps[2]).toBeGreaterThanOrEqual(ladder[2]! * 0.5);
  });

  it('leaves the work queue empty at every step', async () => {
    await expect(queueDepth(channel, EXPIRE_QUEUE)).resolves.toBe(0);
    for (const tier of [1, 2, 3]) {
      await expect(queueDepth(channel, retryQueue(tier))).resolves.toBe(0);
    }
  });
});

describe('a message that is not a message', () => {
  let worker: WorkerHarness;
  let connection: ChannelModel;
  let channel: Channel;
  let calls: number;

  beforeAll(async () => {
    ({ connection, channel } = await openInspection(getTestRabbitUrl()));
    await deleteTopology(connection, 3);

    calls = 0;
    worker = await startWorkerHarness({
      ttlSeconds: 1,
      retryDelaysMs: ladder,
      settle: () => {
        calls += 1;
        return Promise.resolve('expired');
      },
    });
  });

  afterAll(async () => {
    await worker.close();
    await channel.close();
    await connection.close();
  });

  it('dead-letters an unparseable body immediately, without touching a retry tier', async () => {
    publish(channel, 'this is not json');

    const dead = await takeOne(channel, EXPIRE_DLQ, 10_000);

    expect(dead.content.toString('utf8')).toBe('this is not json');
    // No retries: a body that does not parse will not parse in thirty seconds,
    // and retrying it only delays the diagnosis (spec §5).
    expect(dead.properties.headers?.['x-attempt']).toBe(0);
    expect(calls).toBe(0);
    for (const tier of [1, 2, 3]) {
      await expect(queueDepth(channel, retryQueue(tier))).resolves.toBe(0);
    }
  });

  it('dead-letters a body whose reservation id is not a uuid', async () => {
    publish(channel, JSON.stringify({ reservationId: 'nope' }));

    const dead = await takeOne(channel, EXPIRE_DLQ, 10_000);
    expect(JSON.parse(dead.content.toString('utf8'))).toEqual({ reservationId: 'nope' });
    expect(calls).toBe(0);
  });
});
