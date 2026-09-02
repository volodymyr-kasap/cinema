import { reservationSchema } from '@cinema/contracts';
import type { Channel, ChannelModel } from 'amqplib';

import { EXPIRE_WAIT_QUEUE, expireMessageSchema } from '../src/messaging/messages';
import { getTestRabbitUrl } from './harness';
import { deleteTopology, openInspection, queueDepth, takeOne } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('publishing reservation.expire when a hold is created', () => {
  let h: ReservationHarness;
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    ({ connection, channel } = await openInspection(getTestRabbitUrl()));
    await deleteTopology(connection, 3);
    // A wait TTL long enough that the message is still sitting in the wait
    // queue when the assertions look for it: this suite is about publication,
    // not about delivery.
    h = await startReservationHarness({ expiryMode: 'queue', ttlSeconds: 600 });
  });

  afterAll(async () => {
    await h.close();
    await channel.close();
    await connection.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db);
    await channel.purgeQueue(EXPIRE_WAIT_QUEUE);
  });

  it('publishes one message carrying only the reservation id', async () => {
    const reservation = await h.holdOne(h.seatIds[0]!);

    const message = await takeOne(channel, EXPIRE_WAIT_QUEUE, 5_000);
    expect(expireMessageSchema.parse(JSON.parse(message.content.toString('utf8')))).toEqual({
      reservationId: reservation.id,
    });
  });

  it('stamps the message with the reservation id, the request id and attempt zero', async () => {
    const reservation = await h.holdOne(h.seatIds[1]!);

    const message = await takeOne(channel, EXPIRE_WAIT_QUEUE, 5_000);
    expect(message.properties.messageId).toBe(reservation.id);
    // The same id that is on every log line of the request and in the
    // x-request-id header the caller got back.
    expect(message.properties.correlationId).toEqual(expect.any(String));
    expect(message.properties.headers?.['x-attempt']).toBe(0);
    expect(message.properties.deliveryMode).toBe(2);
  });

  it('publishes nothing when a hold is refused', async () => {
    await h.holdOne(h.seatIds[2]!);
    await channel.purgeQueue(EXPIRE_WAIT_QUEUE);

    const response = await h.hold([h.seatIds[2]!]);

    expect(response.statusCode).toBe(409);
    // A hold that did not happen has nothing to expire. This is why the publish
    // is the last statement of a successful create() and not a wrapper round it.
    await expect(queueDepth(channel, EXPIRE_WAIT_QUEUE)).resolves.toBe(0);
  });
});

describe('publishing when the broker is unreachable', () => {
  let h: ReservationHarness;

  beforeAll(async () => {
    // Port 1 is reserved and refuses immediately, so the failure is a refusal
    // rather than a hang -- the same trick the Redis fail-open suite uses.
    h = await startReservationHarness({
      expiryMode: 'queue',
      rabbitmqUrl: 'amqp://guest:guest@127.0.0.1:1',
    });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db);
  });

  it('still holds the seats and still answers 201', async () => {
    const response = await h.hold([h.seatIds[3]!]);

    expect(response.statusCode).toBe(201);
  });

  it('counts the failure so a reader can tell one bad second from a dead afternoon', async () => {
    const before = h.publisher.failureCount;

    await h.hold([h.seatIds[5]!]);

    // The counter is what section 22 will scrape and what the log line quotes.
    // A silent fail-open is indistinguishable from a working system.
    expect(h.publisher.failureCount).toBeGreaterThan(before);
  });

  it('settles the hold by the lazy path regardless', async () => {
    // The message was never published, so nothing will ever be delivered. The
    // seat must still come back, because lazy expiry is authoritative and the
    // worker is only ever a second route to the same result.
    const shortLived = await startReservationHarness({
      expiryMode: 'queue',
      rabbitmqUrl: 'amqp://guest:guest@127.0.0.1:1',
      ttlSeconds: 1,
    });

    try {
      const first = await shortLived.holdOne(shortLived.seatIds[4]!);
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const second = await shortLived.hold([shortLived.seatIds[4]!]);
      expect(second.statusCode).toBe(201);
      expect(reservationSchema.parse(second.json()).id).not.toBe(first.id);
    } finally {
      await shortLived.close();
    }
  });
});
