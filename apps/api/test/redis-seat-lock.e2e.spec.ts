import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';

import { ConfigService } from '../src/config/config.service';
import { createRedisClient } from '../src/locking/redis.module';
import { RedisSeatLock } from '../src/locking/redis-seat-lock';
import { seatKey } from '../src/locking/seat-lock';
import { getTestRedisUrl } from './harness';

/**
 * A ConfigService reading a temporarily patched environment. Keys are restored
 * one by one rather than by reassigning `process.env`, which Node treats as a
 * different object with different coercion rules.
 */
function configWith(overrides: Record<string, string>): ConfigService {
  const restore = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return new ConfigService();
  } finally {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('RedisSeatLock', () => {
  const showtime = randomUUID();
  let redis: Redis;
  let lock: RedisSeatLock;

  beforeAll(async () => {
    redis = createRedisClient(getTestRedisUrl(), 200, () => {});
    await redis.connect();
    lock = new RedisSeatLock(
      redis,
      configWith({ LOCK_STRATEGY: 'redis', REDIS_URL: getTestRedisUrl() }),
    );
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  it('takes free seats and reports nothing lost', async () => {
    const owner = randomUUID();
    const seats = [randomUUID(), randomUUID()];

    await expect(lock.acquire(showtime, seats, owner)).resolves.toEqual([]);
    await expect(redis.get(seatKey(showtime, seats[0]!))).resolves.toBe(owner);
  });

  it('gives the key the hold TTL, so a leaked lock heals itself', async () => {
    const seat = randomUUID();
    await lock.acquire(showtime, [seat], randomUUID());

    const ttl = await redis.ttl(seatKey(showtime, seat));
    // 600 is RESERVATION_TTL_SECONDS' default: the key lives exactly as long as
    // the hold it stands for, never longer (spec §5).
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('reports the seat a second caller could not take', async () => {
    const seat = randomUUID();
    await lock.acquire(showtime, [seat], randomUUID());

    await expect(lock.acquire(showtime, [seat], randomUUID())).resolves.toEqual([seat]);
  });

  // Two of three is not a hold. Leaving the two we won would block seats nobody
  // is holding for ten minutes, on behalf of a request that has already failed.
  it('rolls back a partial acquisition', async () => {
    const [taken, free, alsoFree] = [randomUUID(), randomUUID(), randomUUID()];
    await lock.acquire(showtime, [taken], randomUUID());

    const lost = await lock.acquire(showtime, [free, taken, alsoFree], randomUUID());

    expect(lost).toEqual([taken]);
    await expect(redis.exists(seatKey(showtime, free), seatKey(showtime, alsoFree))).resolves.toBe(
      0,
    );
  });

  it('releases its own locks', async () => {
    const owner = randomUUID();
    const seat = randomUUID();
    await lock.acquire(showtime, [seat], owner);

    await lock.release(showtime, [seat], owner);

    await expect(redis.exists(seatKey(showtime, seat))).resolves.toBe(0);
  });

  // The reason release is Lua and not GET-then-DEL: between the two the key can
  // expire and be re-taken, and we would delete a lock we do not own.
  it('refuses to release another reservation lock', async () => {
    const owner = randomUUID();
    const seat = randomUUID();
    await lock.acquire(showtime, [seat], owner);

    await lock.release(showtime, [seat], randomUUID());

    await expect(redis.get(seatKey(showtime, seat))).resolves.toBe(owner);
  });

  it('is idempotent: releasing twice is not an error', async () => {
    const owner = randomUUID();
    const seat = randomUUID();
    await lock.acquire(showtime, [seat], owner);

    await lock.release(showtime, [seat], owner);
    await expect(lock.release(showtime, [seat], owner)).resolves.toBeUndefined();
  });

  it('retains its own locks until the given moment', async () => {
    const owner = randomUUID();
    const seat = randomUUID();
    await lock.acquire(showtime, [seat], owner);

    await lock.retain(showtime, [seat], owner, new Date(Date.now() + 3_600_000));

    const ttl = await redis.ttl(seatKey(showtime, seat));
    expect(ttl).toBeGreaterThan(3_500);
  });

  it('refuses to retain another reservation lock', async () => {
    const owner = randomUUID();
    const seat = randomUUID();
    await lock.acquire(showtime, [seat], owner);

    await lock.retain(showtime, [seat], randomUUID(), new Date(Date.now() + 3_600_000));

    expect(await redis.ttl(seatKey(showtime, seat))).toBeLessThanOrEqual(600);
  });

  // The showtime has begun; holds are refused past that point anyway, so there
  // is nothing left for the key to defend.
  it('does not extend a lock past a moment that has already passed', async () => {
    const owner = randomUUID();
    const seat = randomUUID();
    await lock.acquire(showtime, [seat], owner);

    await lock.retain(showtime, [seat], owner, new Date(Date.now() - 1_000));

    expect(await redis.ttl(seatKey(showtime, seat))).toBeLessThanOrEqual(600);
  });

  it('lets an expired lock be taken again', async () => {
    const seat = randomUUID();
    const brief = new RedisSeatLock(
      redis,
      configWith({
        LOCK_STRATEGY: 'redis',
        REDIS_URL: getTestRedisUrl(),
        RESERVATION_TTL_SECONDS: '1',
      }),
    );
    await brief.acquire(showtime, [seat], randomUUID());

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    await expect(brief.acquire(showtime, [seat], randomUUID())).resolves.toEqual([]);
  });

  // Correctness never depended on Redis, so an unreachable Redis costs
  // throughput and nothing else. The alternative -- failing the request -- makes
  // an optional subsystem load-bearing (spec §5, ADR 0018).
  describe('when redis is unreachable', () => {
    let dead: Redis;
    let failing: RedisSeatLock;

    beforeAll(() => {
      // Port 1 is reserved and never listening: a connection refused on every
      // attempt, which is the failure this must survive.
      dead = createRedisClient('redis://127.0.0.1:1', 50, () => {});
      failing = new RedisSeatLock(
        dead,
        configWith({ LOCK_STRATEGY: 'redis', REDIS_URL: 'redis://127.0.0.1:1' }),
      );
    });

    afterAll(() => {
      dead.disconnect();
    });

    it('loses no seats, and counts the failure', async () => {
      const before = failing.failureCount;

      await expect(failing.acquire(showtime, [randomUUID()], randomUUID())).resolves.toEqual([]);

      expect(failing.failureCount).toBeGreaterThan(before);
    });

    it('does not throw on release or retain', async () => {
      await expect(
        failing.release(showtime, [randomUUID()], randomUUID()),
      ).resolves.toBeUndefined();
      await expect(
        failing.retain(showtime, [randomUUID()], randomUUID(), new Date(Date.now() + 60_000)),
      ).resolves.toBeUndefined();
    });
  });
});
