import { randomUUID } from 'node:crypto';

import type { Channel, ChannelModel } from 'amqplib';

import {
  COMMANDS_EXCHANGE,
  EXPIRE_KEY,
  EXPIRE_QUEUE,
  EXPIRE_WAIT_QUEUE,
} from '../src/messaging/messages';
import { RABBIT } from '../src/messaging/rabbit.module';
import { getTestRabbitManagementUrl, getTestRabbitUrl } from './harness';
import {
  deleteTopology,
  killBrokerConnections,
  openInspection,
  queueDepth,
  startWorkerHarness,
  type WorkerHarness,
} from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

function publish(channel: Channel, reservationId: string): void {
  channel.publish(
    COMMANDS_EXCHANGE,
    EXPIRE_KEY,
    Buffer.from(JSON.stringify({ reservationId }), 'utf8'),
    { persistent: true, contentType: 'application/json', headers: { 'x-attempt': 0 } },
  );
}

async function until(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition was not met in time');
}

describe('losing the broker', () => {
  let worker: WorkerHarness;
  let connection: ChannelModel;
  let channel: Channel;
  let settled: string[];

  beforeAll(async () => {
    ({ connection, channel } = await openInspection(getTestRabbitUrl()));
    await deleteTopology(connection, 3);

    settled = [];
    worker = await startWorkerHarness({
      ttlSeconds: 1,
      retryDelaysMs: [100, 200, 400],
      settle: (id) => {
        settled.push(id);
        return Promise.resolve('expired');
      },
    });
  });

  afterAll(async () => {
    await worker.close();
    await channel.close().catch(() => {});
    await connection.close().catch(() => {});
  });

  it('reconnects, reasserts the topology and resumes consuming', async () => {
    const before = randomUUID();
    publish(channel, before);
    await until(() => settled.includes(before));

    // Cut every connection from the broker's side, the worker's included.
    await killBrokerConnections(getTestRabbitManagementUrl());

    // A fresh inspection connection: ours was killed too.
    const revived = await openInspection(getTestRabbitUrl());
    try {
      const after = randomUUID();
      // Recovery reopens the connection, the setup hook reasserts the topology,
      // and the 'connect' listener resubscribes the consumer -- none of which is
      // our code, which is the point of using amqplib's recovery (ADR 0031).
      await until(async () => {
        publish(revived.channel, after);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return settled.includes(after);
      }, 30_000);
    } finally {
      await revived.channel.close().catch(() => {});
      await revived.connection.close().catch(() => {});
    }
  });
});

describe('two workers on one queue', () => {
  let first: WorkerHarness;
  let second: WorkerHarness;
  let connection: ChannelModel;
  let channel: Channel;
  let firstCount: number;
  let secondCount: number;

  beforeAll(async () => {
    ({ connection, channel } = await openInspection(getTestRabbitUrl()));
    await deleteTopology(connection, 3);

    firstCount = 0;
    secondCount = 0;
    first = await startWorkerHarness({
      ttlSeconds: 1,
      retryDelaysMs: [100],
      prefetch: 1,
      settle: () => {
        firstCount += 1;
        return Promise.resolve('expired');
      },
    });
    second = await startWorkerHarness({
      ttlSeconds: 1,
      retryDelaysMs: [100],
      prefetch: 1,
      settle: () => {
        secondCount += 1;
        return Promise.resolve('expired');
      },
    });
  });

  afterAll(async () => {
    await first.close();
    await second.close();
    await channel.close();
    await connection.close();
  });

  it('delivers one message to exactly one of them', async () => {
    publish(channel, randomUUID());

    await until(() => firstCount + secondCount === 1);
    // Held for a moment: a second delivery would show up as a two here, which is
    // what a queue bound twice, or a nack loop, would look like.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(firstCount + secondCount).toBe(1);
  });
});

describe('shutting a worker down', () => {
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    ({ connection, channel } = await openInspection(getTestRabbitUrl()));
    await deleteTopology(connection, 3);
  });

  afterAll(async () => {
    await channel.close();
    await connection.close();
  });

  it('finishes the message it is holding before the process goes', async () => {
    let started = false;
    let finished = false;

    const worker = await startWorkerHarness({
      ttlSeconds: 1,
      retryDelaysMs: [100],
      settle: async () => {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 400));
        finished = true;
        return 'expired';
      },
    });

    publish(channel, randomUUID());
    await until(() => started, 10_000);

    // close() runs onApplicationShutdown, which cancels the consumer and then
    // drains. Without the drain the handler would be cut off mid-flight and its
    // message redelivered -- safe, but noisy and slow.
    await worker.close();

    expect(finished).toBe(true);
    await expect(queueDepth(channel, EXPIRE_QUEUE)).resolves.toBe(0);
  });
});

describe('a broker holding an incompatible topology', () => {
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    ({ connection, channel } = await openInspection(getTestRabbitUrl()));
    await deleteTopology(connection, 3);
    // A wait queue that already exists with a TTL the application will not ask
    // for: what a redeploy with a changed RESERVATION_TTL_SECONDS leaves behind
    // (ADR 0024). Asserting it again with different arguments is a 406.
    await channel.assertQueue(EXPIRE_WAIT_QUEUE, {
      durable: true,
      arguments: { 'x-message-ttl': 987_000, 'x-dead-letter-exchange': COMMANDS_EXCHANGE },
    });
  });

  afterAll(async () => {
    await channel.close();
    await connection.close();
  });

  it('fails open at boot instead of hanging on a topology it cannot assert', async () => {
    // amqplib's recovery catches a failing `setup`, emits connect-failed and
    // reschedules for ever without resolving or rejecting, so a connection
    // opened straight into recovery would hang boot for good. Booting at all is
    // most of this assertion.
    const api = await startReservationHarness({ expiryMode: 'queue', ttlSeconds: 1 });

    try {
      expect(api.app.get(RABBIT)).toBeNull();

      // The seats are what matters. A queue the operator misconfigured must
      // cost the API nothing: lazy expiry was always the authority (ADR 0011).
      const response = await api.hold([api.seatIds[2]!]);
      expect(response.statusCode).toBe(201);
    } finally {
      await api.close();
    }
  });
});

describe('lazy mode', () => {
  let api: ReservationHarness;
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    ({ connection, channel } = await openInspection(getTestRabbitUrl()));
    await deleteTopology(connection, 3);
    // Declared by this suite, not by the application: the assertion below is
    // that the application left it alone.
    await channel.assertQueue(EXPIRE_WAIT_QUEUE, { durable: true });
    api = await startReservationHarness({ expiryMode: 'lazy' });
  });

  afterAll(async () => {
    await api.close();
    await channel.close();
    await connection.close();
  });

  it('opens no connection and publishes nothing', async () => {
    await truncateReservations(api.db);

    expect(api.app.get(RABBIT)).toBeNull();

    await api.holdOne(api.seatIds[0]!);

    // Phase 3's baseline must be reproducible on this commit: in lazy mode the
    // API performs no operation phase 3 did not perform (ADR 0017).
    await expect(queueDepth(channel, EXPIRE_WAIT_QUEUE)).resolves.toBe(0);
    expect(api.publisher.failureCount).toBe(0);
  });

  it('still expires holds, because lazy expiry never stopped being authoritative', async () => {
    const short = await startReservationHarness({ expiryMode: 'lazy', ttlSeconds: 1 });
    try {
      await short.holdOne(short.seatIds[1]!);
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const second = await short.hold([short.seatIds[1]!]);
      expect(second.statusCode).toBe(201);
    } finally {
      await short.close();
    }
  });
});
