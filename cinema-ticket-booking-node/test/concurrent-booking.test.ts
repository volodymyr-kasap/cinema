import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { connectRedis, type RedisClient } from '../src/adapters/redis.js';
import { SeatAlreadyBookedError } from '../src/booking/domain.js';
import { RedisBookingStore } from '../src/booking/redis-store.js';
import { BookingService } from '../src/booking/service.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** 100k users going for the same seat at the same instant. */
const NUM_USERS = Number(process.env.CONCURRENCY_TEST_USERS ?? 100_000);

/**
 * How many holds are in flight at once. Go could fire all 100k goroutines at
 * once; here every request is a promise plus a queued Redis command, so they
 * go out in waves to keep the client's write buffer bounded. Redis still sees
 * them as one undifferentiated stampede — which is what the test is about.
 */
const BATCH_SIZE = 2_000;

const redis = await connectRedis(REDIS_URL).catch((err: Error) => {
  console.error(`skipping: no redis at ${REDIS_URL} (${err.message})`);
  return null;
});

describe('concurrent booking', { skip: redis === null && `no redis at ${REDIS_URL}` }, () => {
  const client = redis as RedisClient;
  const store = new RedisBookingStore(client, 60_000);
  const svc = new BookingService(store);

  // A fresh movie id per run keeps the test independent of leftover state.
  const movieId = `screen-${randomUUID()}`;

  after(async () => {
    await client.close();
  });

  it(
    'lets exactly one of many racing users take the seat',
    { timeout: 300_000 },
    async () => {
      let successes = 0;
      let failures = 0;

      for (let sent = 0; sent < NUM_USERS; sent += BATCH_SIZE) {
        const batch = Math.min(BATCH_SIZE, NUM_USERS - sent);

        const results = await Promise.all(
          Array.from({ length: batch }, () =>
            svc
              .hold({ movieId, seatId: 'A1', userId: randomUUID() })
              .then(() => true)
              .catch((err: unknown) => {
                assert.ok(
                  err instanceof SeatAlreadyBookedError,
                  `unexpected error: ${String(err)}`,
                );
                return false;
              }),
          ),
        );

        for (const won of results) {
          if (won) successes += 1;
          else failures += 1;
        }
      }

      assert.equal(successes, 1, `expected exactly 1 success, got ${successes}`);
      assert.equal(failures, NUM_USERS - 1);
    },
  );

  it('reports the winning seat as held', async () => {
    const bookings = await store.listBookings(movieId);

    assert.equal(bookings.length, 1);
    assert.equal(bookings[0]?.seatId, 'A1');
    assert.equal(bookings[0]?.status, 'held');
  });
});
