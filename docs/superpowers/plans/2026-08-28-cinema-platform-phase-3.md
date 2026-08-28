# Cinema Booking Platform — Phase 3 (Redis, Distributed Locking & Measurement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an advisory Redis lock in front of the phase 2 transaction, keep every correctness guarantee phase 2 proved, and produce the numbers that say what each strategy costs — 10 000 attempts, 1 000 reservations, 0 double bookings, for both strategies, with a throughput/p95/p99 table beside them.

**Architecture:** A `SeatLock` port with two adapters. `NoopSeatLock` (strategy `db`) does nothing, so the phase 2 path survives byte-for-byte; `RedisSeatLock` (strategy `redis`) takes `SET key NX EX` in a pipeline **before** the transaction opens, so a loser answers 409 in one round-trip without taking a connection from the pool. The lock is advisory: the partial unique index `reservation_seats (showtime_id, seat_id) WHERE released_at IS NULL` remains the invariant, so a cold, flushed or dead Redis degrades into phase 2 rather than into a double booking. Locks are released with a Lua compare-and-delete that checks ownership, which means the reservation id must be minted by the application before the row exists. The stack grows to N API replicas behind nginx so the experiment measures a cluster, and k6 runs the correctness and performance scenarios against it.

**Tech Stack:** Phase 2's stack — NestJS 12 on Fastify, Drizzle + PostgreSQL 18, Zod 4 contracts, Jest 30 + Testcontainers, React 19 — plus exactly two additions: `ioredis` 6 (runtime) and the `grafana/k6` image (load generation, never imported by the app).

**Spec:** `docs/superpowers/specs/2026-08-28-cinema-platform-phase-3-design.md`

## Global Constraints

Rules that apply to every task:

- **`ioredis` is the only new runtime dependency.** Nothing else is installed into `apps/api`. If a task seems to need another, stop and ask. `k6` is a container image, not a package.
- **The invariant stays in the database.** Redis is advisory. No code path may treat "the key is absent" as "the seat is free" — absence means *Redis does not know*. Never delete the `reservation_seats_active_uq` index, never replace `INSERT ... ON CONFLICT DO NOTHING RETURNING`, and never add a `SELECT`-then-`INSERT` check.
- **The phase 2 path is not removed.** `LOCK_STRATEGY=db` must keep working, unchanged, on the same commit — an experiment you cannot re-run is an anecdote, not a result. `db` is the default; the new subsystem does not switch itself on.
- **Out of scope, each with its own sub-project:** RabbitMQ and `reservation.expire`, `Idempotency-Key`, circuit breakers, rate limiting, Prometheus/Grafana, Redis as a read cache for the seat map, payments, authentication, and the `bookings` / `payments` / `tickets` tables. Do not add a scheduler, cron job or `setInterval` sweeper — lazy expiry stays authoritative (spec §11).
- **The frontend does not change.** No file under `apps/web/src` is modified by this plan. `apps/web/nginx.conf` is configuration, not frontend code, and does change.
- **Money is `integer` in minor units** (`*_cents`), single currency UAH. **Timestamps are `timestamptz` in UTC.** **JSON field names are camelCase.**
- **Time comparisons against the database use the database's `now()`**, never the Node process clock. Redis TTLs are the one exception and are deliberately computed from a different clock — see spec §4; they are advisory, so the drift is affordable.
- **`@cinema/contracts` must be rebuilt (`npm run build -w @cinema/contracts`) before `apps/api` or `apps/web` are typechecked or tested** after any change to it. This plan changes no contract, but the build is still the first step of `npm test`.
- **Commit after every task** using the message given in that task's final step.

## Existing code this plan builds on

Read these before starting — the plan assumes their shapes and does not repeat them:

| File                                              | What it gives you                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/api/src/config/env.ts`                      | `parseEnv`, the `AppConfig` type, and the Zod schema every new variable is added to                 |
| `apps/api/src/db/drizzle.module.ts`               | The exact shape `redis.module.ts` mirrors: a symbol token, a factory, `onApplicationShutdown`       |
| `apps/api/src/reservations/reservation.service.ts` | The whole of phase 2's `create`, `confirm`, `cancel` and `releaseStaleHolds` — this plan edits them |
| `apps/api/src/http/errors.ts`                     | `SeatsUnavailableError(lost: { seatId, label }[])` — the fast path must build the same argument      |
| `apps/api/src/catalog/catalog.service.ts`         | `getShowtime(id, executor)`; the `seats`/`showtimes` query shapes the geometry cache copies          |
| `apps/api/src/observability/logger.ts`            | `registerCorrelation` — the one `onRequest` hook, where `X-Instance-Id` joins `X-Request-Id`         |
| `apps/api/test/harness.ts`                        | `startTestDatabase` / `getTestDatabaseUrl`; the Redis container is added beside them                 |
| `apps/api/test/reservation-harness.ts`            | `startReservationHarness()` — gains options, a Redis client, and env restoration in `close()`        |
| `apps/api/test/reservations-contention.e2e.spec.ts` | Phase 2's proof; Task 6 parameterises it by strategy rather than rewriting it                      |
| `docker-compose.yml`                              | The stack Task 7 scales; note `migrate` and `seed` are already separate one-shot services            |
| `apps/web/nginx.conf`                             | Already proxies `/api/`; Task 7 turns it into the load balancer                                     |

## File Structure

```
apps/api/src/
├── locking/
│   ├── seat-lock.ts                    # NEW: SeatLock interface, SEAT_LOCK token, seatKey()
│   ├── seat-lock.test.ts               # NEW: key format
│   ├── noop-seat-lock.ts               # NEW: strategy `db` — succeeds, does nothing
│   ├── redis.module.ts                 # NEW: REDIS token, ioredis client, Lua scripts, shutdown
│   ├── redis-seat-lock.ts              # NEW: pipelined SET NX EX, Lua release/retain, fail open
│   └── locking.module.ts               # NEW: binds SEAT_LOCK to an adapter from LOCK_STRATEGY
├── config/
│   ├── env.ts                          # MODIFY: LOCK_STRATEGY, REDIS_URL, REDIS_COMMAND_TIMEOUT_MS
│   └── env.test.ts                     # MODIFY: three new cases
├── db/
│   ├── uuid-v7.ts                      # NEW: application-side RFC 9562 v7 (the lock value)
│   └── uuid-v7.test.ts                 # NEW: version, variant, monotonicity
├── catalog/
│   ├── memoize.ts                      # NEW: single-flight promise memoiser
│   ├── memoize.test.ts                 # NEW: one load under N concurrent misses; rejection evicts
│   ├── seat-geometry.cache.ts          # NEW: seatId → label, per hall, for the fast 409 path
│   └── catalog.module.ts               # MODIFY: provide and export SeatGeometryCache
├── reservations/
│   ├── reservation.service.ts          # MODIFY: acquire before the transaction; release/retain after
│   └── reservation.module.ts           # MODIFY: import LockingModule
├── observability/
│   ├── instance.ts                     # NEW: INSTANCE_ID — the container's hostname
│   └── logger.ts                       # MODIFY: stamp X-Instance-Id in the onRequest hook
└── app.module.ts                       # MODIFY: import LockingModule

apps/api/test/
├── harness.ts                          # MODIFY: startTestRedis, getTestRedisUrl
├── global-setup.ts                     # MODIFY: start Redis, write .redis-url
├── global-teardown.ts                  # MODIFY: stop Redis
├── setup-after-env.ts                  # MODIFY: export REDIS_URL
├── truncate.ts                         # MODIFY: optional FLUSHALL alongside the TRUNCATE
├── reservation-harness.ts              # MODIFY: options, redis client, lock handle, env restore
├── seat-geometry.e2e.spec.ts           # NEW: labels are right and the second call queries nothing
├── redis-seat-lock.e2e.spec.ts         # NEW: the adapter alone — acquire, ownership, TTL, fail open
├── reservations-locking.e2e.spec.ts    # NEW: lifecycle and both directions of divergence over HTTP
├── reservations-contention.e2e.spec.ts # MODIFY: parameterised by strategy
└── correlation.e2e.spec.ts             # MODIFY: X-Instance-Id assertion

load/
├── lib/target.js                       # NEW: find the 1000-seat premiere showtime and its seats
├── lib/replicas.js                     # NEW: the balance probe both scenarios end with
├── correctness.js                      # NEW: 10 000 attempts → 1 000 × 201, 9 000 × 409, 0 × 5xx
├── performance.js                      # NEW: ramping-arrival-rate 100 → 500 → 1000 → 2000
├── reset.sh                            # NEW: TRUNCATE + FLUSHALL, the shared starting state
├── verify.sh                           # NEW: the SQL half of the correctness assertion
├── correctness.sh                      # NEW: reset → k6 → verify, for one strategy
└── performance.sh                      # NEW: reset → k6, for one strategy

docs/
├── adr/0016..0023-*.md                 # NEW: eight decision records
└── experiments/2026-08-28-db-vs-redis-locking.md  # NEW: prediction, conditions, results

docker-compose.yml                      # MODIFY: redis, API_REPLICAS, no published api port, k6 profile
docker-compose.single-api.yml           # NEW: override restoring one api on :3000 for development
apps/web/nginx.conf                     # MODIFY: runtime DNS resolution — the load balancer
apps/api/package.json                   # MODIFY: ioredis
package.json                            # MODIFY: load:* scripts
eslint.config.js                        # MODIFY: ignore load/** (k6 runtime, not Node)
.env.example                            # MODIFY: the three new variables
README.md                               # MODIFY: new topology, ports, and how to run the experiment
```

---

## Task 1: Configuration and the lock port

The port and the no-op adapter first. Nothing behaves differently at the end of this task — that is the point: `NoopSeatLock` is what makes strategy `db` *the same code* as strategy `redis` rather than a second branch, so the experiment in Task 8 measures the lock and not two implementations.

**Files:**

- Create: `apps/api/src/locking/seat-lock.ts`
- Create: `apps/api/src/locking/seat-lock.test.ts`
- Create: `apps/api/src/locking/noop-seat-lock.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/config/env.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Consumes: nothing.
- Produces: `SEAT_LOCK` (a `symbol` DI token), the `SeatLock` interface with `acquire`/`release`/`retain`, `seatKey(showtimeId, seatId): string`, and `NoopSeatLock`. Config gains `lockStrategy: 'db' | 'redis'`, `redisUrl: string | undefined`, `redisCommandTimeoutMs: number`. Tasks 2, 4 and 5 depend on every one of these names.

**A deliberate deviation from the spec, decide it here and do not re-litigate it later:** spec §7's table lists `REDIS_URL` with a default of `redis://localhost:6379`, and the paragraph under it requires that `LOCK_STRATEGY=redis` without `REDIS_URL` refuses to start. Both cannot be true — a default means the variable is never absent, and the refusal never fires. The refusal is the one with teeth, so `REDIS_URL` has **no schema default** and is `optional()`; `redis://localhost:6379` lives in `.env.example` where a developer can see it. ADR 0018 (Task 9) records this.

- [ ] **Step 1: Write the failing test for the key format**

Create `apps/api/src/locking/seat-lock.test.ts`:

```ts
import { seatKey } from './seat-lock';

describe('seatKey', () => {
  // Section 8 of spec.md gives this format verbatim. The load scripts and the
  // adapter must agree on it, which is why it exists exactly once in the code.
  it('is seat:{showtimeId}:{seatId}', () => {
    expect(seatKey('01936c7a-0000-7000-8000-000000000001', '01936c7a-0000-7000-8000-000000000002')).toBe(
      'seat:01936c7a-0000-7000-8000-000000000001:01936c7a-0000-7000-8000-000000000002',
    );
  });

  it('gives different seats of one showtime different keys', () => {
    expect(seatKey('show', 'a')).not.toBe(seatKey('show', 'b'));
  });

  it('gives the same seat under different showtimes different keys', () => {
    expect(seatKey('one', 'seat')).not.toBe(seatKey('two', 'seat'));
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- seat-lock`
Expected: FAIL — `Cannot find module './seat-lock'`.

- [ ] **Step 3: Write the port**

Create `apps/api/src/locking/seat-lock.ts`:

```ts
export const SEAT_LOCK = Symbol('SEAT_LOCK');

/**
 * An *advisory* lock taken before the transaction opens. Holding it does not
 * make a seat yours -- the partial unique index does that (ADR 0009). Not
 * holding it does not mean the seat is free; it means Redis does not know. That
 * asymmetry is the whole design: a cold, flushed or dead Redis degrades into
 * sub-project 2, never into a double booking.
 */
export interface SeatLock {
  /**
   * Take the seats. Returns the ids that could not be taken -- an empty array
   * means the caller may proceed to the transaction.
   */
  acquire(showtimeId: string, seatIds: string[], reservationId: string): Promise<string[]>;
  /** Drop our own locks. Never touches another reservation's. Idempotent. */
  release(showtimeId: string, seatIds: string[], reservationId: string): Promise<void>;
  /** Extend our locks to the end of the seats' occupancy -- a confirmed booking. */
  retain(
    showtimeId: string,
    seatIds: string[],
    reservationId: string,
    until: Date,
  ): Promise<void>;
}

/**
 * Section 8 of spec.md, verbatim. One definition so the adapter, the tests and
 * the k6 scripts cannot drift apart on what a seat key looks like.
 */
export function seatKey(showtimeId: string, seatId: string): string {
  return `seat:${showtimeId}:${seatId}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @cinema/api -- seat-lock`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the no-op adapter**

Create `apps/api/src/locking/noop-seat-lock.ts`:

```ts
import { Injectable } from '@nestjs/common';

import type { SeatLock } from './seat-lock';

/**
 * Strategy `db`: sub-project 2's behaviour, expressed as an adapter rather than
 * as an `if`. `acquire` losing nothing means every caller proceeds to the
 * transaction and the unique index settles the race, exactly as before.
 *
 * This class is what makes the section 25 comparison honest. If the two
 * strategies were two code paths, the experiment would be measuring the
 * difference between two implementations; because `db` is this class plugged
 * into the same `create()`, it measures the lock.
 */
@Injectable()
export class NoopSeatLock implements SeatLock {
  acquire(): Promise<string[]> {
    return Promise.resolve([]);
  }

  release(): Promise<void> {
    return Promise.resolve();
  }

  retain(): Promise<void> {
    return Promise.resolve();
  }
}
```

- [ ] **Step 6: Write the failing configuration tests**

Add these cases to `apps/api/src/config/env.test.ts`, and extend the two existing `toEqual` / defaults assertions with the three new fields (`lockStrategy: 'db'`, `redisUrl: undefined`, `redisCommandTimeoutMs: 200`):

```ts
  it('defaults to database locking, so the new subsystem never switches itself on', () => {
    const config = parseEnv({ DATABASE_URL: valid.DATABASE_URL });
    expect(config.lockStrategy).toBe('db');
    expect(config.redisUrl).toBeUndefined();
    expect(config.redisCommandTimeoutMs).toBe(200);
  });

  it('refuses to start with redis locking and no REDIS_URL', () => {
    // A 500 on every request would be the alternative, discovered in production
    // by a user rather than at boot by the process.
    expect(() => parseEnv({ ...valid, LOCK_STRATEGY: 'redis' })).toThrow(/REDIS_URL/);
  });

  it('accepts redis locking when the URL is present', () => {
    const config = parseEnv({
      ...valid,
      LOCK_STRATEGY: 'redis',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_COMMAND_TIMEOUT_MS: '50',
    });
    expect(config.lockStrategy).toBe('redis');
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.redisCommandTimeoutMs).toBe(50);
  });

  it('rejects a REDIS_URL that is not a redis URL', () => {
    expect(() =>
      parseEnv({ ...valid, LOCK_STRATEGY: 'redis', REDIS_URL: 'http://localhost:6379' }),
    ).toThrow(/REDIS_URL/);
  });

  it('rejects an unknown lock strategy', () => {
    expect(() => parseEnv({ ...valid, LOCK_STRATEGY: 'zookeeper' })).toThrow(/LOCK_STRATEGY/);
  });
```

- [ ] **Step 7: Run them to make sure they fail**

Run: `npm test -w @cinema/api -- config/env`
Expected: FAIL — `config.lockStrategy` is `undefined` and `parseEnv` does not throw for `LOCK_STRATEGY=redis`.

- [ ] **Step 8: Extend the environment schema**

In `apps/api/src/config/env.ts`, add these three entries to the object passed to `z.object({ ... })`, immediately after `DATABASE_POOL_MAX`:

```ts
  // `db` by default, deliberately: a new subsystem does not switch itself on,
  // and sub-project 2's path must stay the reproducible baseline of the
  // section 25 experiment (ADR 0017).
  LOCK_STRATEGY: z.enum(['db', 'redis']).default('db'),
  // No default. Spec §7 lists one, but a default makes the check below vacuous,
  // and refusing to boot beats answering 500 to every request (ADR 0018).
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
  // The threshold past which a slow Redis is treated as a dead one and the
  // request falls through to the database path.
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(200),
```

Then wrap the schema in the cross-field check. Replace `const envSchema = z.object({ ... });`'s closing `});` with:

```ts
}).refine((env) => env.LOCK_STRATEGY !== 'redis' || env.REDIS_URL !== undefined, {
  path: ['REDIS_URL'],
  error: 'REDIS_URL is required when LOCK_STRATEGY is redis',
});
```

Add the three fields to the `AppConfig` type:

```ts
  lockStrategy: z.infer<typeof envSchema>['LOCK_STRATEGY'];
  redisUrl: string | undefined;
  redisCommandTimeoutMs: number;
```

and to the object `parseEnv` returns:

```ts
    lockStrategy: env.LOCK_STRATEGY,
    redisUrl: env.REDIS_URL,
    redisCommandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
```

`z.infer` of a refined schema still resolves the field types, so the `AppConfig` lines above compile unchanged. If TypeScript disagrees, extract the object schema to `const envObject = z.object({...})` and refine into `const envSchema = envObject.refine(...)`, then take `z.infer<typeof envObject>` for the two `AppConfig` lines — do not widen the types to `string`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -w @cinema/api -- config/env`
Expected: PASS, 9 tests.

- [ ] **Step 10: Document the variables**

Append to `.env.example`:

```
# Seat locking: `db` is sub-project 2's path (the unique index alone), `redis`
# adds the advisory lock in front of it. Both live in the code at once so the
# section 25 comparison can be re-run on any commit.
LOCK_STRATEGY=db
# Required only when LOCK_STRATEGY=redis. Deliberately has no default in code:
# a missing URL must stop the process at boot, not surface as a 500 per request.
REDIS_URL=redis://localhost:6379
# Past this, a slow Redis is treated as a dead one and the request falls through
# to the database path.
REDIS_COMMAND_TIMEOUT_MS=200
```

- [ ] **Step 11: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test -w @cinema/api -- "(seat-lock|config/env)"`
Expected: all pass.

```bash
git add apps/api/src/locking apps/api/src/config/env.ts apps/api/src/config/env.test.ts .env.example
git commit -m "feat(api): add the seat-lock port, the no-op adapter and the locking configuration"
```

---

## Task 2: The Redis adapter

Read spec §4 and §5 in full before starting. This task builds the adapter and tests it directly, without HTTP or Nest — the wiring into `create()` is Task 4, and keeping the two apart means a failure here has exactly one possible cause.

**Files:**

- Modify: `apps/api/package.json`
- Create: `apps/api/src/locking/redis.module.ts`
- Create: `apps/api/src/locking/redis-seat-lock.ts`
- Create: `apps/api/src/locking/locking.module.ts`
- Modify: `apps/api/test/harness.ts`
- Modify: `apps/api/test/global-setup.ts`
- Modify: `apps/api/test/global-teardown.ts`
- Modify: `apps/api/test/setup-after-env.ts`
- Modify: `.gitignore`
- Create: `apps/api/test/redis-seat-lock.e2e.spec.ts`

**Interfaces:**

- Consumes: `SeatLock`, `SEAT_LOCK`, `seatKey`, `NoopSeatLock` (Task 1); `ConfigService`.
- Produces: `REDIS` (a `symbol` token resolving to `Redis | null`), `createRedisClient(url, commandTimeoutMs, onError): Redis`, `RedisModule`, `RedisSeatLock` (with a public `failureCount` getter), `LockingModule` (exports `SEAT_LOCK`). Test helpers: `startTestRedis()`, `getTestRedisUrl()`.

- [ ] **Step 1: Install the client**

Run: `npm install ioredis@^6.0.0 -w @cinema/api`

`ioredis` and not `node-redis`: pipelines with per-command replies, `defineCommand` for Lua with automatic `EVALSHA` caching and `NOSCRIPT` recovery, and a `commandTimeout` that behaves predictably — all three are load-bearing here.

Expected: `apps/api/package.json` gains `"ioredis": "^6.0.0"` under `dependencies`, and `package-lock.json` changes.

- [ ] **Step 2: Start a Redis container beside Postgres in the test setup**

Add to `apps/api/test/harness.ts`:

```ts
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

declare global {
  var __REDIS_CONTAINER__: StartedTestContainer | undefined;
}

/**
 * `redis:8-alpine`, the image the compose stack runs, so the tests and the
 * experiment exercise the same server. Waiting on the log line rather than on
 * the port avoids the window where the socket is open and the server is not yet
 * answering -- which shows up as one flaky first assertion per run.
 */
export async function startTestRedis(): Promise<StartedTestContainer> {
  return new GenericContainer('redis:8-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
}

export function getTestRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set; global setup did not run');
  return url;
}
```

Note the existing `declare global` block already declares `__PG_CONTAINER__`; add `__REDIS_CONTAINER__` to it rather than opening a second block.

In `apps/api/test/global-setup.ts`, start both containers concurrently and write the URL file the same way:

```ts
import { writeFileSync } from 'node:fs';

import { startTestDatabase, startTestRedis } from './harness';

export default async function globalSetup(): Promise<void> {
  // Concurrently: two image pulls in series is a minute of CI for no reason.
  const [postgres, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

  globalThis.__PG_CONTAINER__ = postgres;
  globalThis.__REDIS_CONTAINER__ = redis;

  writeFileSync(`${__dirname}/.database-url`, postgres.getConnectionUri(), 'utf8');
  writeFileSync(
    `${__dirname}/.redis-url`,
    `redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`,
    'utf8',
  );
}
```

In `apps/api/test/global-teardown.ts`:

```ts
export default async function globalTeardown(): Promise<void> {
  await Promise.all([globalThis.__PG_CONTAINER__?.stop(), globalThis.__REDIS_CONTAINER__?.stop()]);
}
```

In `apps/api/test/setup-after-env.ts`, add the line beside the database one:

```ts
process.env.REDIS_URL = readFileSync(`${__dirname}/.redis-url`, 'utf8').trim();
```

`REDIS_URL` is now set for every suite. That is harmless: `LOCK_STRATEGY` still defaults to `db`, so the client is never even constructed unless a suite asks for it.

Add to `.gitignore`, next to the existing `apps/api/test/.database-url`:

```
apps/api/test/.redis-url
```

- [ ] **Step 3: Write the failing adapter test**

Create `apps/api/test/redis-seat-lock.e2e.spec.ts`. This exercises the adapter alone — no Nest, no HTTP.

```ts
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
    await expect(redis.exists(seatKey(showtime, free), seatKey(showtime, alsoFree))).resolves.toBe(0);
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
      await expect(failing.release(showtime, [randomUUID()], randomUUID())).resolves.toBeUndefined();
      await expect(
        failing.retain(showtime, [randomUUID()], randomUUID(), new Date(Date.now() + 60_000)),
      ).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- redis-seat-lock`
Expected: FAIL — `Cannot find module '../src/locking/redis.module'`.

- [ ] **Step 5: Write the connection module**

Create `apps/api/src/locking/redis.module.ts`:

```ts
import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis, type Result } from 'ioredis';

import { ConfigService } from '../config/config.service';

export const REDIS = Symbol('REDIS');

/**
 * `defineCommand` installs these on the client at runtime; TypeScript learns
 * about them here. Both take the key count first because the number of seats
 * varies per request, so `numberOfKeys` cannot be fixed in the definition.
 */
declare module 'ioredis' {
  interface RedisCommander<Context> {
    releaseSeats(numKeys: number, ...args: (string | number)[]): Result<number, Context>;
    retainSeats(numKeys: number, ...args: (string | number)[]): Result<number, Context>;
  }
}

/**
 * Read, compare, delete -- as one server-side step. Three client commands would
 * be the same check-then-act race the database path exists to avoid: between the
 * GET and the DEL the key can lapse and be re-taken, and we would delete a lock
 * belonging to someone else.
 */
const RELEASE_LUA = `
local removed = 0
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then
    removed = removed + redis.call('DEL', KEYS[i])
  end
end
return removed
`;

/** The same ownership check, extending instead of deleting. */
const RETAIN_LUA = `
local kept = 0
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then
    redis.call('SET', KEYS[i], ARGV[1], 'EX', ARGV[2])
    kept = kept + 1
  end
end
return kept
`;

export function createRedisClient(
  url: string,
  commandTimeoutMs: number,
  onError: (error: Error) => void,
): Redis {
  const client = new Redis(url, {
    commandTimeout: commandTimeoutMs,
    // Fail open needs a fast, definite failure. The defaults queue commands
    // while the link is down and retry them twenty times, which turns an
    // unreachable Redis into a hung request rather than a degraded one.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // Nothing connects until connect() is called, so the error listener below
    // is guaranteed to be attached before the first connection attempt.
    lazyConnect: true,
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  });

  // ioredis emits 'error' on every failed reconnection attempt, and an
  // EventEmitter 'error' with no listener aborts the process -- the same trap
  // the pg pool has in DrizzleModule. A dead Redis must degrade, not crash.
  client.on('error', onError);

  client.defineCommand('releaseSeats', { lua: RELEASE_LUA });
  client.defineCommand('retainSeats', { lua: RETAIN_LUA });

  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis | null => {
        const { lockStrategy, redisUrl, redisCommandTimeoutMs } = configService.config;
        // Strategy `db` opens no connection at all. A client nobody uses would
        // still reconnect, still log, and still make the baseline run of the
        // experiment different from sub-project 2's.
        if (lockStrategy !== 'redis' || !redisUrl) return null;

        const logger = new Logger(RedisModule.name);
        return createRedisClient(redisUrl, redisCommandTimeoutMs, (error) => {
          logger.warn(`redis connection error: ${error.message}`);
        });
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  /**
   * Connecting here rather than lazily on the first command removes a startup
   * race: the first request would otherwise fail open while the socket is still
   * opening. A Redis that is down at boot must not stop the process -- the
   * database path is still fully correct without it.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.connect();
    } catch (error) {
      this.logger.warn(`redis unreachable at startup, running fail-open: ${String(error)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.redis) return;
    // quit() drains in-flight commands; if the link is already gone it rejects,
    // and there is nothing left to drain.
    await this.redis.quit().catch(() => this.redis?.disconnect());
  }
}
```

- [ ] **Step 6: Write the adapter**

Create `apps/api/src/locking/redis-seat-lock.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ConfigService } from '../config/config.service';
import { REDIS } from './redis.module';
import { seatKey, type SeatLock } from './seat-lock';

@Injectable()
export class RedisSeatLock implements SeatLock {
  private readonly logger = new Logger(RedisSeatLock.name);
  /**
   * Fail-open events since boot. Section 22 will scrape this; today it is what
   * the degradation test asserts on, and what a log line quotes so a reader can
   * tell one bad second from a Redis that has been dead all afternoon.
   */
  private failures = 0;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {}

  get failureCount(): number {
    return this.failures;
  }

  async acquire(showtimeId: string, seatIds: string[], reservationId: string): Promise<string[]> {
    if (seatIds.length === 0) return [];

    const ttl = this.configService.config.reservationTtlSeconds;
    // A pipeline, not MULTI: we need a reply per key to know which seats we
    // lost. MULTI would buy an atomicity we do not want -- the partial
    // acquisition is rolled back below, by us, deliberately.
    const pipeline = this.redis.pipeline();
    for (const seatId of seatIds) {
      pipeline.set(seatKey(showtimeId, seatId), reservationId, 'EX', ttl, 'NX');
    }
    // Keys are NOT sorted, and that is not an oversight. In the database the
    // order is mandatory: INSERT *waits* for the competing transaction, so
    // without a common order two requests deadlock (ADR 0010). SET NX does not
    // wait -- it fails immediately -- so no wait cycle exists to break.

    let replies: [Error | null, unknown][] | null;
    try {
      replies = await pipeline.exec();
    } catch (error) {
      this.failOpen('acquire', error);
      return [];
    }
    if (!replies) {
      this.failOpen('acquire', new Error('pipeline returned no replies'));
      return [];
    }

    const lost: string[] = [];
    const held: string[] = [];
    replies.forEach(([error, reply], index) => {
      const seatId = seatIds[index]!;
      if (error) {
        // A per-command failure is the same fail-open case as a dead socket. It
        // must not read as "this seat is taken": that would be Redis inventing
        // a conflict the database knows nothing about.
        this.failOpen('acquire', error);
        held.push(seatId);
        return;
      }
      if (reply === 'OK') held.push(seatId);
      else lost.push(seatId);
    });

    // Two of three is not a hold. Keeping the two we won would block seats
    // nobody is holding for the whole TTL, on behalf of a request that has
    // already failed.
    if (lost.length > 0 && held.length > 0) {
      await this.release(showtimeId, held, reservationId);
    }
    return lost;
  }

  async release(showtimeId: string, seatIds: string[], reservationId: string): Promise<void> {
    if (seatIds.length === 0) return;
    const keys = seatIds.map((seatId) => seatKey(showtimeId, seatId));

    try {
      await this.redis.releaseSeats(keys.length, ...keys, reservationId);
    } catch (error) {
      // Worse than a failed acquire: the key outlives the row and holds a seat
      // that is actually free. Bounded by the TTL, which is exactly why the TTL
      // is the length of a hold and not a day (spec §5).
      this.failOpen('release', error);
    }
  }

  async retain(
    showtimeId: string,
    seatIds: string[],
    reservationId: string,
    until: Date,
  ): Promise<void> {
    if (seatIds.length === 0) return;
    const seconds = Math.ceil((until.getTime() - Date.now()) / 1_000);
    // The moment has passed: holds are refused after a showtime starts, so the
    // key has nothing left to defend and may lapse on its own schedule.
    if (seconds <= 0) return;

    const keys = seatIds.map((seatId) => seatKey(showtimeId, seatId));
    try {
      await this.redis.retainSeats(keys.length, ...keys, reservationId, seconds);
    } catch (error) {
      this.failOpen('retain', error);
    }
  }

  private failOpen(operation: string, error: unknown): void {
    this.failures += 1;
    this.logger.warn(
      `redis ${operation} failed (${String(this.failures)} since boot), continuing on the database path: ${String(error)}`,
    );
  }
}
```

- [ ] **Step 7: Write the strategy factory**

Create `apps/api/src/locking/locking.module.ts`:

```ts
import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ConfigService } from '../config/config.service';
import { NoopSeatLock } from './noop-seat-lock';
import { RedisSeatLock } from './redis-seat-lock';
import { REDIS, RedisModule } from './redis.module';
import { SEAT_LOCK, type SeatLock } from './seat-lock';

@Module({
  imports: [RedisModule],
  providers: [
    {
      provide: SEAT_LOCK,
      inject: [ConfigService, REDIS],
      useFactory: (configService: ConfigService, redis: Redis | null): SeatLock =>
        // `redis &&` is not belt-and-braces: env.ts already refuses to boot with
        // strategy `redis` and no URL, and this keeps the two facts in one place
        // rather than trusting the reader to remember the other.
        configService.config.lockStrategy === 'redis' && redis
          ? new RedisSeatLock(redis, configService)
          : new NoopSeatLock(),
    },
  ],
  exports: [SEAT_LOCK],
})
export class LockingModule {}
```

- [ ] **Step 8: Run the adapter test to verify it passes**

Run: `npm test -w @cinema/api -- redis-seat-lock`
Expected: PASS, 14 tests. The first run pulls `redis:8-alpine`, so allow it a minute.

If the unreachable-Redis cases hang instead of failing fast, `enableOfflineQueue: false` did not make it into `createRedisClient` — that option, not `commandTimeout`, is what turns a down connection into an immediate rejection.

- [ ] **Step 9: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test -w @cinema/api -- "(seat-lock|redis-seat-lock)"`
Expected: all pass.

```bash
git add apps/api/package.json package-lock.json apps/api/src/locking apps/api/test .gitignore
git commit -m "feat(api): add the redis seat-lock adapter with lua ownership checks and fail-open"
```

---

## Task 3: The reservation id and the seat geometry cache

Two small units that Task 4 cannot do without, and that are much easier to get right on their own. Read spec §3's "Идентификатор брони генерируется приложением" and §5's "Метки мест на быстром пути" before starting.

**Files:**

- Create: `apps/api/src/db/uuid-v7.ts`
- Create: `apps/api/src/db/uuid-v7.test.ts`
- Create: `apps/api/src/catalog/memoize.ts`
- Create: `apps/api/src/catalog/memoize.test.ts`
- Create: `apps/api/src/catalog/seat-geometry.cache.ts`
- Modify: `apps/api/src/catalog/catalog.module.ts`
- Create: `apps/api/test/seat-geometry.e2e.spec.ts`

**Interfaces:**

- Consumes: `DRIZZLE`, `Database` (`apps/api/src/db/drizzle.module.ts`); `seats`, `showtimes` (`apps/api/src/db/schema.ts`); `ResourceNotFoundError`.
- Produces: `uuidv7(): string`; `singleFlight<K, V>(cache: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V>`; `SeatGeometryCache` with `labels(showtimeId: string, seatIds: string[]): Promise<{ seatId: string; label: string }[]>`, exported from `CatalogModule`.

**Why an id from the application at all:** the Lua release compares the key's value against the reservation id, so the value has to exist *before* the row does. `uuidv7()` here rather than the column default keeps ADR 0004's time-ordered keys intact; the schema default stays as the guarantee for any other write path. The obvious alternative, using `sessionId` as the lock value, breaks on an honest sequence: one session cancels an old reservation, the release deletes the key — and the key already belongs to that same session's *new* reservation for the same seat.

- [ ] **Step 1: Write the failing uuid test**

Create `apps/api/src/db/uuid-v7.test.ts`:

```ts
import { uuidv7 } from './uuid-v7';

describe('uuidv7', () => {
  it('looks like a UUID', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('declares version 7 and the RFC 9562 variant', () => {
    for (let i = 0; i < 100; i += 1) {
      const id = uuidv7();
      expect(id[14]).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
    }
  });

  it('carries the current time in its first 48 bits', () => {
    const before = Date.now();
    const millis = Number.parseInt(uuidv7().replaceAll('-', '').slice(0, 12), 16);

    expect(millis).toBeGreaterThanOrEqual(before - 1_000);
    expect(millis).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  // The reason for choosing v7 (ADR 0004): ids that sort by creation time keep
  // B-tree inserts local. A generator that is only *roughly* ordered gives that
  // away inside a single millisecond, which is where a burst of holds lands.
  it('is strictly increasing, including within one millisecond', () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7());
    const sorted = [...ids].sort();

    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- uuid-v7`
Expected: FAIL — `Cannot find module './uuid-v7'`.

- [ ] **Step 3: Write the generator**

Create `apps/api/src/db/uuid-v7.ts`:

```ts
import { randomFillSync } from 'node:crypto';

let lastMillis = 0;
let sequence = 0;

/**
 * RFC 9562 version 7: 48 bits of Unix milliseconds, a 12-bit counter, then 62
 * bits of randomness. PostgreSQL 18 generates these natively and the column
 * default still does (ADR 0004) -- but the seat lock's value must exist before
 * the row does, so a reservation's id is minted here and passed to the INSERT.
 *
 * Node has no v7 generator; `randomUUID()` is v4, which is unordered and would
 * cost exactly the B-tree locality ADR 0004 chose v7 for.
 */
export function uuidv7(): string {
  const now = Date.now();
  if (now > lastMillis) {
    lastMillis = now;
    sequence = 0;
  } else {
    sequence += 1;
    // 4096 ids inside one millisecond is four million a second. Borrowing from
    // the next millisecond keeps the ordering total instead of emitting a
    // duplicate sort key.
    if (sequence > 0xfff) {
      lastMillis += 1;
      sequence = 0;
    }
  }

  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(lastMillis, 0, 6);
  // Version 7 in the top nibble of byte 6; the counter fills the rest.
  bytes.writeUInt16BE(0x7000 | sequence, 6);
  randomFillSync(bytes, 8, 8);
  // Variant 10xx in the top two bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @cinema/api -- uuid-v7`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing memoiser test**

Create `apps/api/src/catalog/memoize.test.ts`:

```ts
import { singleFlight } from './memoize';

describe('singleFlight', () => {
  it('loads once and reuses the value', async () => {
    const cache = new Map<string, Promise<number>>();
    let loads = 0;
    const load = () => {
      loads += 1;
      return Promise.resolve(42);
    };

    await expect(singleFlight(cache, 'k', load)).resolves.toBe(42);
    await expect(singleFlight(cache, 'k', load)).resolves.toBe(42);
    expect(loads).toBe(1);
  });

  // The case this exists for: a thousand losers hitting a cold cache at once
  // must produce one query, not a thousand. Caching the promise rather than the
  // resolved value is the whole trick.
  it('loads once under concurrent misses', async () => {
    const cache = new Map<string, Promise<number>>();
    let loads = 0;
    const load = () => {
      loads += 1;
      return new Promise<number>((resolve) => setTimeout(() => resolve(1), 10));
    };

    await Promise.all(Array.from({ length: 1_000 }, () => singleFlight(cache, 'k', load)));

    expect(loads).toBe(1);
  });

  // A failed load must not be remembered as the answer, or one bad moment
  // poisons the key for the lifetime of the process.
  it('forgets a rejected load', async () => {
    const cache = new Map<string, Promise<number>>();
    let attempts = 0;
    const load = () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('nope')) : Promise.resolve(7);
    };

    await expect(singleFlight(cache, 'k', load)).rejects.toThrow('nope');
    await expect(singleFlight(cache, 'k', load)).resolves.toBe(7);
    expect(cache.size).toBe(1);
  });
});
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- memoize`
Expected: FAIL — `Cannot find module './memoize'`.

- [ ] **Step 7: Write the memoiser**

Create `apps/api/src/catalog/memoize.ts`:

```ts
/**
 * Caches the promise, not the value, so N concurrent misses share one load.
 * A rejection is evicted: a cache that remembers failures answers with them
 * forever.
 */
export function singleFlight<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  load: () => Promise<V>,
): Promise<V> {
  const cached = cache.get(key);
  if (cached) return cached;

  const loading = load();
  cache.set(key, loading);
  // Attached, not awaited, and swallowing nothing: the caller still sees the
  // rejection, this only stops it being served to the next caller.
  loading.catch(() => {
    if (cache.get(key) === loading) cache.delete(key);
  });

  return loading;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -w @cinema/api -- memoize`
Expected: PASS, 3 tests.

- [ ] **Step 9: Write the failing geometry cache test**

Create `apps/api/test/seat-geometry.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { SeatGeometryCache } from '../src/catalog/seat-geometry.cache';
import type { Database } from '../src/db/drizzle.module';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';

/** Counts how many statements the cache actually issues. */
function countingDb(db: Database, counter: { selects: number }): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'select') counter.selects += 1;
      const value = Reflect.get(target, property, receiver) as unknown;
      // Bound, because drizzle's builders are methods that need their receiver.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('SeatGeometryCache', () => {
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('labels seats the way the seat map does', async () => {
    const cache = new SeatGeometryCache(h.db);

    const [first] = await cache.labels(h.showtimeId, [h.seatIds[0]!]);

    const expected = await h.db.execute<{ label: string }>(
      sql`SELECT row_label || seat_number AS label FROM seats WHERE id = ${h.seatIds[0]!}`,
    );
    expect(first).toEqual({ seatId: h.seatIds[0]!, label: expected.rows[0]!.label });
  });

  // The point of the class. Nine thousand losers must not cost nine thousand
  // SELECTs -- that is the load Redis was added to remove, moved rather than
  // removed (spec §5).
  it('queries twice for a cold showtime and never again', async () => {
    const counter = { selects: 0 };
    const cache = new SeatGeometryCache(countingDb(h.db, counter));

    await cache.labels(h.showtimeId, [h.seatIds[0]!]);
    const afterFirst = counter.selects;
    await cache.labels(h.showtimeId, h.seatIds);

    expect(afterFirst).toBe(2);
    expect(counter.selects).toBe(2);
  });

  it('collapses a thousand concurrent cold lookups into the same two queries', async () => {
    const counter = { selects: 0 };
    const cache = new SeatGeometryCache(countingDb(h.db, counter));

    await Promise.all(
      Array.from({ length: 1_000 }, () => cache.labels(h.showtimeId, [h.seatIds[1]!])),
    );

    expect(counter.selects).toBe(2);
  });

  it('reports an unknown showtime rather than caching the absence', async () => {
    const cache = new SeatGeometryCache(h.db);

    await expect(cache.labels(randomUUID(), [h.seatIds[0]!])).rejects.toThrow(/does not exist/);
  });

  // Falling back to the id keeps a 409 honest instead of throwing while building
  // the error that explains the 409.
  it('falls back to the seat id for a seat outside the hall', async () => {
    const cache = new SeatGeometryCache(h.db);
    const stranger = randomUUID();

    await expect(cache.labels(h.showtimeId, [stranger])).resolves.toEqual([
      { seatId: stranger, label: stranger },
    ]);
  });
});
```

- [ ] **Step 10: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- seat-geometry`
Expected: FAIL — `Cannot find module '../src/catalog/seat-geometry.cache'`.

- [ ] **Step 11: Write the cache**

Create `apps/api/src/catalog/seat-geometry.cache.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../db/drizzle.module';
import { seats, showtimes } from '../db/schema';
import { ResourceNotFoundError } from '../http/errors';
import { singleFlight } from './memoize';

export interface SeatLabel {
  seatId: string;
  label: string;
}

/**
 * Seat labels for the fast 409 path, held in the process.
 *
 * `SeatsUnavailableError` names seats the way a user sees them ("C7"), and on
 * the fast path no seat row has been read yet. Fetching labels per loser would
 * put nine thousand SELECTs where nine thousand transactions used to be --
 * moving the load Redis was added to remove, not removing it.
 *
 * The catalogue is seeded once and never edited in this sub-project, so no
 * invalidation exists, and that is a recorded limitation rather than an
 * oversight (ADR 0023): when an admin screen starts editing seats, the eviction
 * hook goes here.
 */
@Injectable()
export class SeatGeometryCache {
  private readonly showtimeHalls = new Map<string, Promise<string>>();
  private readonly hallGeometry = new Map<string, Promise<Map<string, string>>>();

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async labels(showtimeId: string, seatIds: string[]): Promise<SeatLabel[]> {
    const hallId = await singleFlight(this.showtimeHalls, showtimeId, () =>
      this.loadHall(showtimeId),
    );
    const geometry = await singleFlight(this.hallGeometry, hallId, () => this.loadGeometry(hallId));

    // A seat that is not in the hall cannot reach this path -- the transaction
    // rejects it first -- but reporting the id beats throwing while building the
    // error that was going to explain the failure.
    return seatIds.map((seatId) => ({ seatId, label: geometry.get(seatId) ?? seatId }));
  }

  private async loadHall(showtimeId: string): Promise<string> {
    const [row] = await this.db
      .select({ hallId: showtimes.hallId })
      .from(showtimes)
      .where(eq(showtimes.id, showtimeId))
      .limit(1);

    if (!row) throw new ResourceNotFoundError('Showtime', showtimeId);
    return row.hallId;
  }

  private async loadGeometry(hallId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ id: seats.id, rowLabel: seats.rowLabel, seatNumber: seats.seatNumber })
      .from(seats)
      .where(eq(seats.hallId, hallId));

    return new Map(rows.map((row) => [row.id, `${row.rowLabel}${String(row.seatNumber)}`]));
  }
}
```

- [ ] **Step 12: Export it from the catalog module**

In `apps/api/src/catalog/catalog.module.ts`, add `SeatGeometryCache` to both `providers` and `exports`:

```ts
import { Module } from '@nestjs/common';

import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { SeatGeometryCache } from './seat-geometry.cache';

@Module({
  controllers: [CatalogController],
  providers: [CatalogService, SeatGeometryCache],
  exports: [CatalogService, SeatGeometryCache],
})
export class CatalogModule {}
```

- [ ] **Step 13: Run the test to verify it passes**

Run: `npm test -w @cinema/api -- seat-geometry`
Expected: PASS, 5 tests.

- [ ] **Step 14: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test -w @cinema/api -- "(uuid-v7|memoize|seat-geometry)"`
Expected: all pass.

```bash
git add apps/api/src/db/uuid-v7.ts apps/api/src/db/uuid-v7.test.ts apps/api/src/catalog apps/api/test/seat-geometry.e2e.spec.ts
git commit -m "feat(api): mint reservation ids in the application and cache seat geometry per hall"
```

---

## Task 4: The fast path — acquiring before the transaction

The task the sub-project exists for. Read spec §3's "Поток создания брони" before starting.

**Files:**

- Modify: `apps/api/test/reservation-harness.ts`
- Modify: `apps/api/test/truncate.ts`
- Modify: `apps/api/src/reservations/reservation.service.ts`
- Modify: `apps/api/src/reservations/reservation.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/reservations-locking.e2e.spec.ts`

**Interfaces:**

- Consumes: `SEAT_LOCK`, `SeatLock`, `seatKey` (Task 1); `LockingModule` (Task 2); `uuidv7`, `SeatGeometryCache` (Task 3).
- Produces: `startReservationHarness(options?: HarnessOptions)` with `HarnessOptions = { lockStrategy?: 'db' | 'redis'; redisUrl?: string; ttlSeconds?: number; poolMax?: number }`, and a harness carrying `redis: Redis | null` and `lock: SeatLock` alongside its existing fields. `truncateReservations(db, redis?)`. Tasks 5 and 6 build on all of it.

- [ ] **Step 1: Give the harness a strategy**

In `apps/api/test/reservation-harness.ts`, add these imports:

```ts
import { Redis } from 'ioredis';

import { createRedisClient } from '../src/locking/redis.module';
import { SEAT_LOCK, type SeatLock } from '../src/locking/seat-lock';
import { getTestDatabaseUrl, getTestRedisUrl } from './harness';
```

(the existing `getTestDatabaseUrl` import line is replaced by the last one), then the options type:

```ts
export interface HarnessOptions {
  /** Which adapter the application under test binds to SEAT_LOCK. */
  lockStrategy?: 'db' | 'redis';
  /** Overrides REDIS_URL. Pointing it at a closed port is how fail open is proved. */
  redisUrl?: string;
  /** Shortens the hold, and with it the key's TTL. */
  ttlSeconds?: number;
  /**
   * Raised above the client count by the contention suite. At the default of
   * ten, forty of fifty clients queue for a connection instead of racing for a
   * seat and the suite passes for the wrong reason (ADR 0015).
   */
  poolMax?: number;
}
```

Add two fields to the `ReservationHarness` interface:

```ts
  /**
   * A second connection, always to the real container even when the application
   * is pointed at a dead one, for asserting on keys the application wrote.
   * `null` unless the harness was started with `lockStrategy: 'redis'`.
   */
  redis: Redis | null;
  /** The adapter the application actually bound, for calling the port directly. */
  lock: SeatLock;
```

Change the signature to `export async function startReservationHarness(options: HarnessOptions = {}): Promise<ReservationHarness>` and open the body with the environment patch — **before** `Test.createTestingModule(...).compile()`, because `ConfigService` parses the environment once, in its field initialiser:

```ts
  const overrides: Record<string, string | undefined> = {
    LOCK_STRATEGY: options.lockStrategy,
    REDIS_URL: options.redisUrl,
    RESERVATION_TTL_SECONDS:
      options.ttlSeconds === undefined ? undefined : String(options.ttlSeconds),
    DATABASE_POOL_MAX: options.poolMax === undefined ? undefined : String(options.poolMax),
  };
  const restore = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }
```

After `await app.init()` and the adapter's `ready()`, create the inspection client:

```ts
  const redis =
    options.lockStrategy === 'redis'
      ? createRedisClient(getTestRedisUrl(), 200, () => {})
      : null;
  if (redis) await redis.connect();
```

Add `redis`, `lock: app.get<SeatLock>(SEAT_LOCK)` to the returned object, and extend `close`:

```ts
    close: async () => {
      await app.close();
      await pool.end();
      if (redis) await redis.quit();
      // Restoring rather than deleting: a suite that ran before this one may
      // have set the same variable, and leaking a strategy into the next file
      // is the kind of failure that only reproduces in full runs.
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
```

- [ ] **Step 2: Let the shared cleanup clear Redis too**

Rewrite `apps/api/test/truncate.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '../src/db/drizzle.module';

/**
 * Phase 1's suites only read, so re-seeding once per file was enough isolation.
 * Phase 2's suites write, and a hold left behind by one test silently changes
 * the answer of the next. The catalogue is deliberately untouched: it is seeded
 * once and only ever read.
 *
 * A leftover key is worse than a leftover row, because nothing in the database
 * shows it: the next test sees a seat that is free everywhere except in Redis.
 */
export async function truncateReservations(db: Database, redis?: Redis | null): Promise<void> {
  await db.execute(sql`TRUNCATE reservation_seats, reservations CASCADE`);
  if (redis) await redis.flushall();
}
```

Existing call sites pass one argument and keep working.

- [ ] **Step 3: Write the failing test**

Create `apps/api/test/reservations-locking.e2e.spec.ts`. Everything here runs over HTTP against the real application with `LOCK_STRATEGY=redis`.

```ts
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@cinema/contracts';
import { sql } from 'drizzle-orm';

import { seatKey } from '../src/locking/seat-lock';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('reservations with redis locking', () => {
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness({ lockStrategy: 'redis' });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db, h.redis);
  });

  it('takes a lock keyed on the showtime and seat when a hold succeeds', async () => {
    const reservation = await h.holdOne(h.seatIds[0]!);

    await expect(h.redis!.get(seatKey(h.showtimeId, h.seatIds[0]!))).resolves.toBe(reservation.id);
  });

  it('refuses the second caller and names the seat', async () => {
    await h.holdOne(h.seatIds[1]!);

    const response = await h.hold([h.seatIds[1]!]);

    expect(response.statusCode).toBe(409);
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.type).toMatch(/seats-unavailable$/);
    expect(problem.seatIds).toEqual([h.seatIds[1]!]);
    // The label comes from the in-process geometry cache, not from a query per
    // loser (spec §5). It still has to be the label a user recognises.
    expect(problem.detail).toMatch(/^Seats [A-Z]\d+ were taken/);
  });

  it('leaves no lock behind when the request fails inside the transaction', async () => {
    // A seat from another hall: the lock is taken before the hall is known, so
    // the release in the catch is the only thing that cleans it up.
    const foreign = await h.db.execute<{ id: string }>(sql`
      SELECT se.id FROM seats se
      WHERE se.hall_id <> (SELECT hall_id FROM showtimes WHERE id = ${h.showtimeId})
      LIMIT 1
    `);
    const seat = foreign.rows[0]!.id;

    const response = await h.hold([seat]);

    expect(response.statusCode).toBe(400);
    await expect(h.redis!.exists(seatKey(h.showtimeId, seat))).resolves.toBe(0);
  });

  it('leaves no lock behind when the showtime has already started', async () => {
    const response = await h.hold([h.pastSeatId], randomUUID(), h.pastShowtimeId);

    expect(response.statusCode).toBe(409);
    await expect(h.redis!.exists(seatKey(h.pastShowtimeId, h.pastSeatId))).resolves.toBe(0);
  });

  it('takes none of the seats when one of three is already locked', async () => {
    await h.holdOne(h.seatIds[3]!);

    const response = await h.hold([h.seatIds[2]!, h.seatIds[3]!, h.seatIds[4]!]);

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).seatIds).toEqual([h.seatIds[3]!]);
    await expect(
      h.redis!.exists(seatKey(h.showtimeId, h.seatIds[2]!), seatKey(h.showtimeId, h.seatIds[4]!)),
    ).resolves.toBe(0);
  });

  // Spec §5, the first row of the divergence table: the lock says taken, the
  // database says free. A false rejection, bounded by the TTL, and the price of
  // an advisory lock -- stated here so nobody later calls it a bug.
  it('rejects on a stale key even though the seat is free in the database', async () => {
    await h.redis!.set(seatKey(h.showtimeId, h.seatIds[5]!), randomUUID(), 'EX', 60);

    const response = await h.hold([h.seatIds[5]!]);

    expect(response.statusCode).toBe(409);
    const active = await h.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM reservation_seats WHERE released_at IS NULL`,
    );
    expect(active.rows[0]?.n).toBe('0');
  });

  // The second row, and the important one: the index is still the last word. A
  // flushed Redis costs a wasted transaction, never a double booking.
  it('still refuses a taken seat after the lock is flushed away', async () => {
    await h.holdOne(h.seatIds[6]!);
    await h.redis!.flushall();

    const response = await h.hold([h.seatIds[6]!]);

    expect(response.statusCode).toBe(409);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/seats-unavailable$/);
  });

  it('lets a lock lapse with its hold, so the seat comes back on its own', async () => {
    const brief = await startReservationHarness({ lockStrategy: 'redis', ttlSeconds: 1 });
    try {
      await truncateReservations(brief.db, brief.redis);
      await brief.holdOne(brief.seatIds[0]!);

      await new Promise((resolve) => setTimeout(resolve, 1_500));

      await expect(brief.redis!.exists(seatKey(brief.showtimeId, brief.seatIds[0]!))).resolves.toBe(0);
      const response = await brief.hold([brief.seatIds[0]!]);
      expect(response.statusCode).toBe(201);
    } finally {
      await brief.close();
    }
  });
});

// Correctness never depended on Redis, so losing it costs throughput and
// nothing else (spec §5, ADR 0018).
describe('reservations when redis is unreachable', () => {
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness({
      lockStrategy: 'redis',
      // Port 1 is reserved and never listening.
      redisUrl: 'redis://127.0.0.1:1',
    });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db);
  });

  it('still takes a hold, on the database path', async () => {
    const response = await h.hold([h.seatIds[0]!]);

    expect(response.statusCode).toBe(201);
  });

  it('still refuses a seat that is already held', async () => {
    await h.holdOne(h.seatIds[1]!);

    expect((await h.hold([h.seatIds[1]!])).statusCode).toBe(409);
  });

  it('keeps reporting itself ready: readiness means postgres, not redis', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- reservations-locking`
Expected: FAIL — the first case gets `null` from Redis, because nothing writes a key yet.

- [ ] **Step 5: Wire the lock into the service**

In `apps/api/src/reservations/reservation.service.ts`, extend the imports:

```ts
import { SeatGeometryCache } from '../catalog/seat-geometry.cache';
import { uuidv7 } from '../db/uuid-v7';
import { SEAT_LOCK, type SeatLock } from '../locking/seat-lock';
import { showtimes } from '../db/schema';
```

(`showtimes` joins the existing import from `../db/schema`; it is needed by Task 5.)

Add the two dependencies to the constructor:

```ts
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(SEAT_LOCK) private readonly seatLock: SeatLock,
    private readonly catalog: CatalogService,
    private readonly geometry: SeatGeometryCache,
    private readonly configService: ConfigService,
  ) {}
```

Add the released-row type next to the existing `SeatRow` interface:

```ts
/** A seat handed back to the pool by a transaction, and the hold it belonged to. */
interface ReleasedSeat {
  reservationId: string;
  showtimeId: string;
  seatId: string;
}
```

Replace `create` in full:

```ts
  async create(sessionId: string, input: CreateReservation): Promise<Reservation> {
    // Minted here, not by the column default: the lock's value has to exist
    // before the row does, or the release cannot check who owns the key.
    const reservationId = uuidv7();

    // Before the transaction, and this is the entire point of the sub-project.
    // A loser answers 409 in one round-trip without taking a connection from
    // the pool and without opening a transaction that would then block inside
    // ON CONFLICT until the winner commits.
    const lost = await this.seatLock.acquire(input.showtimeId, input.seatIds, reservationId);
    if (lost.length > 0) {
      throw new SeatsUnavailableError(await this.geometry.labels(input.showtimeId, lost));
    }

    let outcome: { reservation: Reservation; released: ReleasedSeat[] };
    try {
      outcome = await this.hold(sessionId, input, reservationId);
    } catch (error) {
      // The database refused, so we do not hold these seats and must not keep
      // their keys: a lock outliving the request it belongs to blocks a seat
      // nobody is holding, for the whole TTL. This also covers the seats the
      // lock took before the transaction knew they were in the wrong hall.
      await this.seatLock.release(input.showtimeId, input.seatIds, reservationId);
      throw error;
    }

    // The lazy expiry inside the transaction handed other people's seats back.
    // Their keys are theirs to lose; the ownership check in the Lua makes this
    // safe even for the seats we have just taken over, because those keys are
    // ours now and will not match.
    await this.releaseLocks(outcome.released);
    return outcome.reservation;
  }

  /** Sub-project 2's transaction, unchanged except for the supplied id. */
  private hold(
    sessionId: string,
    input: CreateReservation,
    reservationId: string,
  ): Promise<{ reservation: Reservation; released: ReleasedSeat[] }> {
    return this.db.transaction(async (tx) => {
      const showtime = await this.catalog.getShowtime(input.showtimeId, tx);

      // The database's clock, not the process's: two clocks that disagree
      // produce a bug that only appears under load.
      const clock = await tx.execute<{ started: boolean }>(
        sql`SELECT (${showtime.startsAt}::timestamptz <= now()) AS started`,
      );
      if (clock.rows[0]?.started) throw new ShowtimeAlreadyStartedError(showtime.id);

      const seatRows = await this.loadSeats(
        tx,
        showtime.hallId,
        showtime.basePriceCents,
        input.seatIds,
      );
      if (seatRows.length !== input.seatIds.length) {
        const found = new Set(seatRows.map((row) => row.id));
        throw new SeatsNotInHallError(input.seatIds.filter((id) => !found.has(id)));
      }

      const released = await this.releaseStaleHolds(tx, input.showtimeId, input.seatIds);

      const totalPriceCents = seatRows.reduce((sum, row) => sum + row.priceCents, 0);
      const ttl = this.configService.config.reservationTtlSeconds;

      const [reservation] = await tx
        .insert(reservations)
        .values({
          id: reservationId,
          showtimeId: input.showtimeId,
          sessionId,
          status: 'PENDING',
          totalPriceCents,
          expiresAt: sql`now() + make_interval(secs => ${ttl})`,
        })
        .returning({
          id: reservations.id,
          expiresAt: reservations.expiresAt,
          createdAt: reservations.createdAt,
        });

      // Sorted by seat id so every transaction takes its rows in the same
      // order. Without this, two overlapping requests can wait on each other
      // crosswise and Postgres kills one with a deadlock (40P01) -- a 500 where
      // the caller had earned an honest 409.
      const ordered = [...seatRows].sort((a, b) => (a.id < b.id ? -1 : 1));

      const won = await tx
        .insert(reservationSeats)
        .values(
          ordered.map((row) => ({
            reservationId: reservation!.id,
            seatId: row.id,
            showtimeId: input.showtimeId,
            priceCents: row.priceCents,
          })),
        )
        .onConflictDoNothing()
        .returning({ seatId: reservationSeats.seatId });

      if (won.length !== ordered.length) {
        const kept = new Set(won.map((row) => row.seatId));
        // The index had the last word: the lock was absent or stale, and this is
        // exactly the case that makes a flushed Redis cost a transaction rather
        // than a double booking. Rolling back discards the rows we did win, so
        // the loser leaves no partial hold behind.
        throw new SeatsUnavailableError(
          ordered
            .filter((row) => !kept.has(row.id))
            .map((row) => ({ seatId: row.id, label: `${row.rowLabel}${String(row.seatNumber)}` })),
        );
      }

      return {
        released,
        reservation: {
          id: reservation!.id,
          showtimeId: input.showtimeId,
          status: 'PENDING' as const,
          totalPriceCents,
          expiresAt: reservation!.expiresAt.toISOString(),
          createdAt: reservation!.createdAt.toISOString(),
          // `seatRows`, not the id-sorted `ordered`: insertion order exists to
          // avoid deadlocks, while the response is read by a human and must
          // match the row-then-number order `get` and `list` return.
          seats: seatRows.map((row) => ({
            seatId: row.id,
            rowLabel: row.rowLabel,
            seatNumber: row.seatNumber,
            category: row.category,
            priceCents: row.priceCents,
          })),
        },
      };
    });
  }

  /**
   * Locks are dropped after the commit, never inside the transaction. A
   * transaction can roll back; a released lock cannot be un-released, and
   * dropping one for a seat that is still held is how a double booking would
   * finally become possible.
   */
  private async releaseLocks(rows: ReleasedSeat[]): Promise<void> {
    if (rows.length === 0) return;

    // Grouped by owner because the Lua compares one value against every key, so
    // a batch may only ever carry a single reservation's seats.
    const groups = new Map<string, ReleasedSeat[]>();
    for (const row of rows) {
      const key = `${row.showtimeId}:${row.reservationId}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    await Promise.all(
      [...groups.values()].map((group) =>
        this.seatLock.release(
          group[0]!.showtimeId,
          group.map((row) => row.seatId),
          group[0]!.reservationId,
        ),
      ),
    );
  }
```

Then change `releaseStaleHolds` to report what it freed. Replace its final statement (the `update(reservationSeats)` call) and its return type:

```ts
  private async releaseStaleHolds(
    executor: Executor,
    showtimeId: string,
    seatIds: string[],
  ): Promise<ReleasedSeat[]> {
```

```ts
    if (stale.length === 0) return [];
```

```ts
    return executor
      .update(reservationSeats)
      .set({ releasedAt: sql`now()` })
      .where(and(inArray(reservationSeats.reservationId, ids), isNull(reservationSeats.releasedAt)))
      .returning({
        reservationId: reservationSeats.reservationId,
        showtimeId: reservationSeats.showtimeId,
        seatId: reservationSeats.seatId,
      });
```

Everything else in the method — the `selectDistinct` and the `reservations` update to `EXPIRED` — is untouched.

- [ ] **Step 6: Import the locking module**

In `apps/api/src/reservations/reservation.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { LockingModule } from '../locking/locking.module';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';

@Module({
  imports: [CatalogModule, LockingModule],
  controllers: [ReservationController],
  providers: [ReservationService],
})
export class ReservationModule {}
```

In `apps/api/src/app.module.ts`, add `LockingModule` to `imports` (alphabetically, after `HealthModule`) and its import line. Listing it at the top level is not required for DI — `ReservationModule` imports it — but the module map should name every subsystem the process runs.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -w @cinema/api -- reservations-locking`
Expected: PASS, 11 tests.

- [ ] **Step 8: Verify nothing on the database path moved**

Run: `npm test -w @cinema/api -- reservations`
Expected: PASS — `reservations.e2e.spec.ts` and `seat-occupancy.e2e.spec.ts` still pass unchanged, with `LOCK_STRATEGY` at its default. If they do not, the refactor changed behaviour rather than adding a lock in front of it, and the comparison in Task 8 is already invalid.

- [ ] **Step 9: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test -w @cinema/api`
Expected: all suites pass.

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): take the seat lock before the transaction and drop it when the hold fails"
```

---

## Task 5: The rest of the lifecycle — retaining and releasing

A lock that is only ever taken is a lock that leaks. Read spec §3's last paragraph and the `retain` bullet in §3 before starting.

**Files:**

- Modify: `apps/api/src/reservations/reservation.service.ts`
- Modify: `apps/api/test/reservations-locking.e2e.spec.ts`

**Interfaces:**

- Consumes: everything from Task 4; `showtimes` from `../db/schema`.
- Produces: no new exports. `confirm` now calls `retain`, `cancel` and the expiry path call `release`, and all three do it after their transaction has committed.

**Why `retain` and not `release` on confirm:** a confirmed seat is never free again. Deleting the key would let the next request take the lock, reach the transaction and be refused by the index — correct, and precisely the work the lock exists to avoid. The new TTL runs to the showtime's start, because holds are refused after that (`ShowtimeAlreadyStartedError`), so there is nothing for the key to defend beyond it.

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to `apps/api/test/reservations-locking.e2e.spec.ts`, inside the existing `describe('reservations with redis locking', ...)` — it reuses that block's `h` and its `beforeEach`:

```ts
  describe('the rest of the lifecycle', () => {
    it('keeps the lock after a confirmation, extended to the start of the showtime', async () => {
      const reservation = await h.holdOne(h.seatIds[7]!);
      const session = await h.db.execute<{ session_id: string }>(
        sql`SELECT session_id FROM reservations WHERE id = ${reservation.id}`,
      );

      const confirmed = await h.act(
        'POST',
        `/${reservation.id}/confirm`,
        session.rows[0]!.session_id,
      );

      expect(confirmed.statusCode).toBe(200);
      const key = seatKey(h.showtimeId, h.seatIds[7]!);
      await expect(h.redis!.get(key)).resolves.toBe(reservation.id);

      const starts = await h.db.execute<{ seconds: number }>(
        sql`SELECT EXTRACT(EPOCH FROM (starts_at - now()))::int AS seconds
            FROM showtimes WHERE id = ${h.showtimeId}`,
      );
      const ttl = await h.redis!.ttl(key);
      // Ten minutes was the hold; the seat is sold now, so the key must outlive
      // the hold and stop at the showtime.
      expect(ttl).toBeGreaterThan(600);
      expect(ttl).toBeLessThanOrEqual(starts.rows[0]!.seconds + 1);
    });

    it('drops the lock when the reservation is cancelled', async () => {
      const reservation = await h.holdOne(h.seatIds[8]!);
      const session = await h.db.execute<{ session_id: string }>(
        sql`SELECT session_id FROM reservations WHERE id = ${reservation.id}`,
      );

      const cancelled = await h.act('DELETE', `/${reservation.id}`, session.rows[0]!.session_id);

      expect(cancelled.statusCode).toBe(204);
      await expect(h.redis!.exists(seatKey(h.showtimeId, h.seatIds[8]!))).resolves.toBe(0);
    });

    // The one case where a request releases somebody else's lock. It is safe
    // only because the Lua compares the owner first.
    it('drops the lock of a hold that lapsed, when the next caller sweeps it', async () => {
      const stale = await h.holdOne(h.seatIds[9]!);
      await h.db.execute(
        sql`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${stale.id}`,
      );
      // The key is still live: sub-project 2's expiry is a database fact, and
      // Redis has not been told. This is the seam ADR 0022 is about.
      await expect(h.redis!.get(seatKey(h.showtimeId, h.seatIds[9]!))).resolves.toBe(stale.id);
      await h.redis!.del(seatKey(h.showtimeId, h.seatIds[9]!));

      const response = await h.hold([h.seatIds[9]!]);

      expect(response.statusCode).toBe(201);
      // The new owner's key survived the sweep of the old owner's.
      const winner = reservationSchema.parse(response.json());
      await expect(h.redis!.get(seatKey(h.showtimeId, h.seatIds[9]!))).resolves.toBe(winner.id);
      const superseded = await h.db.execute<{ status: string }>(
        sql`SELECT status FROM reservations WHERE id = ${stale.id}`,
      );
      expect(superseded.rows[0]?.status).toBe('EXPIRED');
    });

    it('drops the lock when confirming a hold that has already lapsed', async () => {
      const stale = await h.holdOne(h.seatIds[10]!);
      const session = await h.db.execute<{ session_id: string }>(
        sql`SELECT session_id FROM reservations WHERE id = ${stale.id}`,
      );
      await h.db.execute(
        sql`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${stale.id}`,
      );

      const response = await h.act('POST', `/${stale.id}/confirm`, session.rows[0]!.session_id);

      expect(response.statusCode).toBe(409);
      expect(problemDetailsSchema.parse(response.json()).type).toMatch(/reservation-expired$/);
      await expect(h.redis!.exists(seatKey(h.showtimeId, h.seatIds[10]!))).resolves.toBe(0);
    });

    it('lets the seat be taken again immediately after a cancellation', async () => {
      const reservation = await h.holdOne(h.seatIds[11]!);
      const session = await h.db.execute<{ session_id: string }>(
        sql`SELECT session_id FROM reservations WHERE id = ${reservation.id}`,
      );
      await h.act('DELETE', `/${reservation.id}`, session.rows[0]!.session_id);

      expect((await h.hold([h.seatIds[11]!])).statusCode).toBe(201);
    });
  });
```

Add `reservationSchema` to the `@cinema/contracts` import at the top of the file.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test -w @cinema/api -- reservations-locking`
Expected: FAIL — the confirmation case reads a TTL of at most 600 (the key was never extended), and the cancellation case still finds the key.

- [ ] **Step 3: Retain on confirmation**

In `apps/api/src/reservations/reservation.service.ts`, replace `confirm` in full:

```ts
  async confirm(sessionId: string, id: string): Promise<Reservation> {
    /**
     * The expiry is reported *after* the transaction, never thrown from inside
     * it: throwing rolls back, which would discard the very EXPIRED row this
     * call just wrote and leave the seats held by a hold nobody can confirm.
     * Whoever discovers the expiry records it, then answers 409.
     */
    const outcome = await this.db.transaction(async (tx) => {
      const row = await this.lockOwned(tx, sessionId, id);

      if (row.status === 'PENDING' && row.expired) {
        return { expired: true as const, released: await this.expire(tx, id) };
      }
      if (!canTransition(row.status, 'CONFIRMED')) {
        throw new InvalidStateTransitionError(row.status, 'CONFIRMED');
      }

      await tx
        .update(reservations)
        .set({ status: 'CONFIRMED', confirmedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(reservations.id, id));

      const reservation = await this.get(sessionId, id, tx);
      // Read inside the transaction so the extension cannot be computed from a
      // showtime that was rescheduled between the commit and the retain.
      const [showtime] = await tx
        .select({ startsAt: showtimes.startsAt })
        .from(showtimes)
        .where(eq(showtimes.id, reservation.showtimeId))
        .limit(1);

      return { expired: false as const, reservation, startsAt: showtime!.startsAt };
    });

    if (outcome.expired) {
      // The seats went back to the pool inside the transaction; their keys have
      // to follow, or they block seats nobody holds until the TTL runs out.
      await this.releaseLocks(outcome.released);
      throw new ReservationExpiredError(id);
    }

    // Not release: a confirmed seat is never free again, and dropping the key
    // would invite the next request to take the lock, open a transaction and be
    // refused by the index -- exactly the work the lock exists to avoid.
    await this.seatLock.retain(
      outcome.reservation.showtimeId,
      outcome.reservation.seats.map((seat) => seat.seatId),
      id,
      outcome.startsAt,
    );
    return outcome.reservation;
  }
```

- [ ] **Step 4: Release on cancellation and on expiry**

Replace `cancel`:

```ts
  async cancel(sessionId: string, id: string): Promise<void> {
    const released = await this.db.transaction(async (tx) => {
      const row = await this.lockOwned(tx, sessionId, id);

      // Cancelling is idempotent. The caller asked for the seats to be released;
      // for a reservation that already ended, they are.
      if (row.status === 'CANCELLED' || row.status === 'EXPIRED') return [];
      if (row.status === 'PENDING' && row.expired) return this.expire(tx, id);
      if (!canTransition(row.status, 'CANCELLED')) {
        throw new InvalidStateTransitionError(row.status, 'CANCELLED');
      }

      await tx
        .update(reservations)
        .set({ status: 'CANCELLED', cancelledAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(reservations.id, id));
      return this.releaseSeatsOf(tx, id);
    });

    await this.releaseLocks(released);
  }
```

and make the two private helpers report what they freed:

```ts
  private async expire(executor: Executor, id: string): Promise<ReleasedSeat[]> {
    await executor
      .update(reservations)
      .set({ status: 'EXPIRED', updatedAt: sql`now()` })
      .where(eq(reservations.id, id));
    return this.releaseSeatsOf(executor, id);
  }

  private releaseSeatsOf(executor: Executor, reservationId: string): Promise<ReleasedSeat[]> {
    return executor
      .update(reservationSeats)
      .set({ releasedAt: sql`now()` })
      .where(
        and(eq(reservationSeats.reservationId, reservationId), isNull(reservationSeats.releasedAt)),
      )
      .returning({
        reservationId: reservationSeats.reservationId,
        showtimeId: reservationSeats.showtimeId,
        seatId: reservationSeats.seatId,
      });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @cinema/api -- reservations-locking`
Expected: PASS, 16 tests.

- [ ] **Step 6: Verify the database path is still untouched**

Run: `npm test -w @cinema/api`
Expected: every suite passes. `reservations.e2e.spec.ts` covers confirm, cancel and lazy expiry on the `db` strategy and must not have moved.

- [ ] **Step 7: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test -w @cinema/api`
Expected: all pass.

```bash
git add apps/api/src/reservations/reservation.service.ts apps/api/test/reservations-locking.e2e.spec.ts
git commit -m "feat(api): retain seat locks on confirmation and drop them on cancel and expiry"
```

---

## Task 6: Proving the guarantees again, for the new path

Sub-project 2's guarantees are not inherited by the Redis path — they are re-proved on it. Read spec §8's table before starting.

**Files:**

- Modify: `apps/api/test/reservations-contention.e2e.spec.ts`

**Interfaces:**

- Consumes: `startReservationHarness(options)` and `truncateReservations(db, redis)` (Task 4).
- Produces: nothing. This task adds evidence, not API.

- [ ] **Step 1: Parameterise the suite by strategy**

Rewrite `apps/api/test/reservations-contention.e2e.spec.ts`. The body of the tests is phase 2's, unchanged; what changes is that it runs twice.

```ts
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

/**
 * Section 7 of spec.md, stated as a test:
 *
 *   N users, one seat  ->  successful reservations = 1
 *
 * Run once per locking strategy. The Redis path does not inherit sub-project
 * 2's guarantees, it re-earns them: an advisory lock that changed any of these
 * answers would be a lock that had quietly become authoritative.
 *
 * The pool is raised above the client count on purpose. At the default of ten
 * connections, forty of fifty clients would be queuing for a connection rather
 * than racing for a seat, and the test would pass for the wrong reason
 * (ADR 0015).
 */
describe.each(['db', 'redis'] as const)('reservations under contention (%s)', (lockStrategy) => {
  const CLIENTS = 50;
  let h: ReservationHarness;

  beforeAll(async () => {
    h = await startReservationHarness({ lockStrategy, poolMax: CLIENTS + 10 });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db, h.redis);
  });

  const race = (seats: string[], clients: number) =>
    Promise.all(Array.from({ length: clients }, () => h.hold(seats, randomUUID())));

  it('lets exactly one of fifty clients hold the same seat', async () => {
    const responses = await race([h.seatIds[0]!], CLIENTS);

    const created = responses.filter((response) => response.statusCode === 201);
    const conflicted = responses.filter((response) => response.statusCode === 409);

    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(CLIENTS - 1);
    // Nothing else: a 500 here would mean a deadlock or an unmapped constraint
    // violation escaped as an internal error.
    expect(created.length + conflicted.length).toBe(CLIENTS);
  });

  it('leaves exactly one active row in the database', async () => {
    await race([h.seatIds[0]!], CLIENTS);

    const active = await h.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM reservation_seats
      WHERE seat_id = ${h.seatIds[0]!} AND showtime_id = ${h.showtimeId} AND released_at IS NULL
    `);

    expect(active.rows[0]?.n).toBe('1');
  });

  it('leaves no partial holds behind when clients ask for overlapping pairs', async () => {
    // Every client wants the same two seats. A loser must hold neither.
    const responses = await race([h.seatIds[1]!, h.seatIds[2]!], CLIENTS);

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const active = await h.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM reservation_seats WHERE released_at IS NULL`,
    );
    expect(active.rows[0]?.n).toBe('2');
  });

  // Different seats must not serialise against each other. If this is slow or
  // fails, the invariant is locking more than the row it needs to.
  it('lets a thousand clients hold a thousand distinct seats', async () => {
    const premiere = await h.db.execute<{ showtime_id: string }>(sql`
      SELECT sh.id AS showtime_id FROM showtimes sh
      JOIN halls h ON h.id = sh.hall_id
      WHERE (SELECT count(*) FROM seats WHERE hall_id = h.id) = 1000
        AND sh.starts_at > now() + interval '1 day'
      ORDER BY sh.starts_at LIMIT 1
    `);
    const target = premiere.rows[0]!.showtime_id;

    const all = await h.db.execute<{ id: string }>(sql`
      SELECT se.id FROM seats se
      JOIN showtimes sh ON sh.hall_id = se.hall_id
      WHERE sh.id = ${target}
    `);
    expect(all.rows).toHaveLength(1000);

    const responses = await Promise.all(
      all.rows.map((seat) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/reservations',
          headers: { 'x-session-id': randomUUID() },
          payload: { showtimeId: target, seatIds: [seat.id] },
        }),
      ),
    );

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1000);
    expect(responses.filter((r) => r.statusCode !== 201)).toHaveLength(0);
  }, 120_000);

  // Ten clients per seat over a thousand seats: the shape of the section 25
  // experiment, in miniature and in-process, so a regression is caught here
  // rather than three tasks later in a two-minute k6 run.
  it('sells a thousand seats exactly once each when ten clients want each of them', async () => {
    const premiere = await h.db.execute<{ showtime_id: string }>(sql`
      SELECT sh.id AS showtime_id FROM showtimes sh
      JOIN halls h ON h.id = sh.hall_id
      WHERE (SELECT count(*) FROM seats WHERE hall_id = h.id) = 1000
        AND sh.starts_at > now() + interval '1 day'
      ORDER BY sh.starts_at LIMIT 1
    `);
    const target = premiere.rows[0]!.showtime_id;
    const all = await h.db.execute<{ id: string }>(
      sql`SELECT se.id FROM seats se JOIN showtimes sh ON sh.hall_id = se.hall_id WHERE sh.id = ${target}`,
    );

    const attempts = all.rows.flatMap((seat) =>
      Array.from({ length: 10 }, () =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/reservations',
          headers: { 'x-session-id': randomUUID() },
          payload: { showtimeId: target, seatIds: [seat.id] },
        }),
      ),
    );
    const responses = await Promise.all(attempts);

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1000);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(9000);
    expect(responses.filter((r) => r.statusCode >= 500)).toHaveLength(0);

    const duplicates = await h.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM (
        SELECT showtime_id, seat_id FROM reservation_seats WHERE released_at IS NULL
        GROUP BY showtime_id, seat_id HAVING count(*) > 1
      ) d
    `);
    expect(duplicates.rows[0]?.n).toBe('0');
  }, 300_000);
});
```

- [ ] **Step 2: Run it**

Run: `npm test -w @cinema/api -- reservations-contention`
Expected: PASS, 10 tests — five on `db`, five on `redis`. The 10 000-attempt case is slow in-process; the 300 s timeout is deliberate.

If the `redis` run reports fewer than 1000 successes in the last case, a lock is being leaked: a loser's `release` did not run, and its key is holding a seat that no row holds. Do not raise the expectation — find the path that skipped the release.

- [ ] **Step 3: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test -w @cinema/api`
Expected: all pass.

```bash
git add apps/api/test/reservations-contention.e2e.spec.ts
git commit -m "test(api): prove the contention guarantees again on the redis locking path"
```

---

## Task 7: The topology — three replicas behind nginx

Read spec §6 in full before starting. The warning in it is not decoration: getting the resolver wrong produces a stack that *looks* balanced, measures a single container, and yields beautiful meaningless numbers. That is the most likely way to get a fake result out of this sub-project, so this task ends with a probe that fails loudly when it happens.

**Files:**

- Create: `apps/api/src/observability/instance.ts`
- Modify: `apps/api/src/observability/logger.ts`
- Modify: `apps/api/test/correlation.e2e.spec.ts`
- Modify: `apps/web/nginx.conf`
- Modify: `docker-compose.yml`
- Create: `docker-compose.single-api.yml`
- Modify: `README.md`

**Interfaces:**

- Consumes: `registerCorrelation` (`apps/api/src/observability/logger.ts`).
- Produces: `INSTANCE_ID: string`, and an `X-Instance-Id` response header on every response. Task 8's k6 scripts read that header and nothing else.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/correlation.e2e.spec.ts`:

```ts
  // Which replica answered. Without this the load experiment cannot tell a
  // balanced stack from one nginx resolved once at startup (spec §6).
  it('names the instance that served the request', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-instance-id']).toEqual(expect.any(String));
    expect(String(response.headers['x-instance-id']).length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @cinema/api -- correlation`
Expected: FAIL — `x-instance-id` is `undefined`.

- [ ] **Step 3: Stamp the instance id**

Create `apps/api/src/observability/instance.ts`:

```ts
import { hostname } from 'node:os';

/**
 * Which replica answered. In Compose and Kubernetes the hostname is the
 * container's name, which is exactly the granularity the section 25 experiment
 * needs: a run where one replica served every request is not a measurement of a
 * cluster, and the load scripts check for it rather than trusting the topology.
 *
 * Read once: the hostname cannot change under a running process.
 */
export const INSTANCE_ID = hostname();
```

In `apps/api/src/observability/logger.ts`, import it and add one line to the existing `onRequest` hook in `registerCorrelation`:

```ts
  instance.addHook('onRequest', (request: FastifyRequest, reply, done) => {
    void reply.header('x-request-id', request.id);
    void reply.header('x-instance-id', INSTANCE_ID);
    requestContext.run({ requestId: String(request.id) }, done);
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @cinema/api -- correlation`
Expected: PASS, 3 tests.

- [ ] **Step 5: Turn nginx into a load balancer**

Replace `apps/web/nginx.conf`:

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  # Docker's embedded DNS server. Without this line nginx resolves `api` exactly
  # once, at startup, and sends every request to whichever replica answered
  # first -- for the whole life of the container. The stack looks balanced, the
  # experiment measures one container, and the numbers are meaningless. The
  # resolver plus a proxy_pass through a variable is what forces nginx to
  # re-resolve, and `valid=10s` is how quickly it notices a replica coming or
  # going. The API stamps X-Instance-Id so the load scripts can prove this
  # actually works rather than assume it (spec §6).
  resolver 127.0.0.11 valid=10s ipv6=off;

  # The SPA owns its routes; nginx must not 404 on a deep link.
  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    # A variable, so the name is resolved per request. Note there is no URI part
    # after the port: nginx then forwards the client's original URI unchanged,
    # which is what the previous literal proxy_pass did.
    set $api_upstream http://api:3000;
    proxy_pass $api_upstream;
    proxy_set_header Host $host;
    proxy_set_header X-Request-Id $request_id;
  }
}
```

- [ ] **Step 6: Scale the stack**

In `docker-compose.yml`, add the Redis service after `postgres`:

```yaml
  redis:
    image: redis:8-alpine
    ports:
      - '6379:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 2s
      timeout: 2s
      retries: 20
```

No volume, deliberately: the locks are advisory and the whole design says a cold Redis must be survivable, so persisting them would preserve state that is by definition disposable.

Replace the `api` service's `ports` and `depends_on` blocks and add the new environment:

```yaml
  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    environment:
      NODE_ENV: production
      PORT: '3000'
      DATABASE_URL: postgres://cinema:cinema@postgres:5432/cinema
      LOG_LEVEL: info
      LOCK_STRATEGY: ${LOCK_STRATEGY:-db}
      REDIS_URL: redis://redis:6379
      DATABASE_POOL_MAX: ${DATABASE_POOL_MAX:-10}
    # No published port: Compose will not map a fixed host port onto a scaled
    # service. Reach the API through nginx at http://localhost:8080/api/, or use
    # docker-compose.single-api.yml for the one-instance shape.
    deploy:
      replicas: ${API_REPLICAS:-3}
    depends_on:
      seed:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    healthcheck:
      test:
        [
          'CMD',
          'node',
          '-e',
          "fetch('http://localhost:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 5s
      timeout: 3s
      retries: 10
```

`REDIS_URL` is set unconditionally while `LOCK_STRATEGY` defaults to `db`: the variable is harmless when unused, and switching the whole stack to the other strategy is then one environment variable rather than an edit.

- [ ] **Step 7: Keep the one-instance shape for development**

Create `docker-compose.single-api.yml`:

```yaml
# The pre-phase-3 shape: one API on a published port, for day-to-day work where
# a fixed http://localhost:3000 and readable logs beat a balanced cluster.
#
#   docker compose -f docker-compose.yml -f docker-compose.single-api.yml up
#
# The scaled stack in docker-compose.yml is what the section 25 experiment runs
# against; this override exists so nobody is tempted to edit that file back.
services:
  api:
    deploy:
      replicas: 1
    ports:
      - '3000:3000'
```

- [ ] **Step 8: Bring the stack up and check the balance by hand**

Run:

```bash
docker compose up -d --build
docker compose ps
for i in $(seq 1 30); do
  curl -s -o /dev/null -D - 'http://localhost:8080/api/v1/movies?limit=1' | grep -i '^x-instance-id'
done | sort | uniq -c
```

Expected: three `api` containers running, and three distinct instance ids in the tally, each with roughly ten of the thirty requests.

If one id takes all thirty, the resolver is not in effect — check that `proxy_pass` names the variable and not the literal, and that the image was rebuilt (`docker compose up -d --build web`), since `nginx.conf` is baked into it.

- [ ] **Step 9: Check the smoke test still passes through the balancer**

Run: `npm run e2e -w @cinema/web`
Expected: PASS. Playwright already targets `http://localhost:8080`, so the SPA path is unchanged; what this proves is that a session spread across three replicas still completes a booking — which it must, because the only state in the API is the anonymous session id the client carries in a header.

- [ ] **Step 10: Update the README's running instructions**

In `README.md`, replace the `## Running` block's bullet list and add the note:

````markdown
- SPA: <http://localhost:8080>
- API: <http://localhost:8080/api/v1/movies>
- OpenAPI: <http://localhost:8080/api/docs>

The API runs as three replicas behind the same nginx that serves the SPA
(`API_REPLICAS` changes the count), so it has no published port of its own. For
day-to-day work, one instance on the familiar port:

```bash
docker compose -f docker-compose.yml -f docker-compose.single-api.yml up
```

Migrations and the seed run as their own one-shot compose services before the
API starts.
````

- [ ] **Step 11: Verify and commit**

Run: `npm run lint && npm run typecheck && npm run format:check && npm test -w @cinema/api -- correlation`
Expected: all pass.

`.github/workflows/ci.yml` needs no change: the `e2e` job already runs `docker compose up -d --build`, which now builds a Redis container and three API replicas instead of one. Nothing in CI runs k6 — a two-minute load test does not belong between a developer and a merge (spec §8), and the correctness scenario's guarantees are already asserted in-process by `reservations-contention.e2e.spec.ts`.

```bash
docker compose down -v
git add apps/api/src/observability apps/api/test/correlation.e2e.spec.ts apps/web/nginx.conf docker-compose.yml docker-compose.single-api.yml README.md
git commit -m "feat(infra): run three api replicas behind nginx with runtime dns resolution"
```

---

## Task 8: The experiment

Read spec §9 in full before starting. Two scenarios: one that passes or fails, and one that produces numbers. Keep them apart — a correctness assertion that depends on how fast the machine is proves nothing, and a throughput measurement that aborts on the first 5xx cannot find a knee.

**Files:**

- Create: `load/lib/uuid.js`
- Create: `load/lib/target.js`
- Create: `load/lib/replicas.js`
- Create: `load/correctness.js`
- Create: `load/performance.js`
- Create: `load/reset.sh`
- Create: `load/verify.sh`
- Create: `load/correctness.sh`
- Create: `load/performance.sh`
- Modify: `docker-compose.yml`
- Modify: `package.json`
- Modify: `eslint.config.js`

**Interfaces:**

- Consumes: the running compose stack from Task 7 and the `X-Instance-Id` header.
- Produces: `npm run load:correctness` and `npm run load:performance`, both taking `LOCK_STRATEGY` from the environment, both writing a transcript under `load/results/`.

- [ ] **Step 1: Keep the k6 scripts out of the Node lint pass**

In `eslint.config.js`, add to the `ignores` array:

```js
      // k6 scripts run in k6's own runtime (`k6/http`, `__ENV`), not in Node.
      // Linting them as Node modules reports globals that genuinely exist.
      'load/**',
```

- [ ] **Step 2: Write the helpers**

Create `load/lib/uuid.js`:

```js
/**
 * k6 has no crypto.randomUUID. The API validates X-Session-Id with z.uuid(),
 * so this has to be a real v4 -- version nibble and variant bits included.
 */
export function uuid() {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[8 + ((Math.random() * 4) | 0)];
    else out += hex[(Math.random() * 16) | 0];
  }
  return out;
}
```

Create `load/lib/target.js`:

```js
import http from 'k6/http';

/**
 * The stage of the section 25 experiment: the 1000-seat Premiere hall.
 *
 * Discovered through the public API rather than passed in, so the run needs no
 * knowledge of seed internals and fails with a sentence a human can act on when
 * the catalogue is missing or has aged out of its window.
 */
export function findPremiereShowtime(baseUrl) {
  const listed = http.get(`${baseUrl}/api/v1/showtimes?limit=100`);
  if (listed.status !== 200) {
    throw new Error(`could not list showtimes: ${listed.status} ${listed.body}`);
  }

  const now = Date.now();
  for (const showtime of listed.json('data')) {
    // A started showtime refuses every hold, which would look like a total
    // failure of the locking rather than a stale seed.
    if (Date.parse(showtime.startsAt) <= now) continue;

    const seats = http.get(`${baseUrl}/api/v1/showtimes/${showtime.id}/seats`);
    if (seats.status !== 200) continue;

    const seatIds = seats.json('seats').map((seat) => seat.seatId);
    if (seatIds.length === 1000) return { showtimeId: showtime.id, seatIds };
  }

  throw new Error(
    'no future 1000-seat showtime in the first 100 -- run `docker compose up seed` and check the seed window has not passed',
  );
}
```

Create `load/lib/replicas.js`:

```js
import http from 'k6/http';
import { check } from 'k6';

function headerValue(response, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(response.headers)) {
    if (key.toLowerCase() === wanted) return response.headers[key];
  }
  return null;
}

/**
 * The single most likely way to get a fake result out of this sub-project is an
 * nginx that resolved `api` once at startup and sent everything to one replica:
 * the stack looks balanced and the experiment measures one container (spec §6).
 *
 * So the run ends by asking. Twenty sequential probes per expected replica, and
 * every replica must serve at least half of its equal share. Sequential and
 * separate from the load phase on purpose -- this is a question about routing,
 * and answering it under saturation would only measure queueing.
 */
export function checkReplicaBalance(baseUrl, replicas) {
  const probes = replicas * 20;
  const served = {};

  for (let i = 0; i < probes; i += 1) {
    const response = http.get(`${baseUrl}/api/v1/movies?limit=1`);
    const id = headerValue(response, 'x-instance-id') || 'unknown';
    served[id] = (served[id] || 0) + 1;
  }

  const floor = Math.floor(probes / replicas / 2);
  console.log(`replica distribution over ${probes} probes: ${JSON.stringify(served)}`);

  check(served, {
    [`all ${replicas} replicas answered`]: (s) => Object.keys(s).length === replicas,
    [`every replica served at least ${floor} probes`]: (s) =>
      Object.keys(s).every((id) => s[id] >= floor),
  });
}
```

- [ ] **Step 3: Write the correctness scenario**

Create `load/correctness.js`:

```js
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

import { uuid } from './lib/uuid.js';
import { findPremiereShowtime } from './lib/target.js';
import { checkReplicaBalance } from './lib/replicas.js';

const BASE_URL = __ENV.BASE_URL || 'http://web';
const REPLICAS = Number(__ENV.API_REPLICAS || '3');

const created = new Counter('reservations_created');
const conflicted = new Counter('reservations_conflicted');
const unexpected = new Counter('reservations_unexpected');

export const options = {
  scenarios: {
    correctness: {
      executor: 'shared-iterations',
      vus: 100,
      iterations: 10_000,
      maxDuration: '10m',
    },
  },
  /**
   * The result of the sub-project, as a pass/fail that does not depend on how
   * fast the machine is (spec §9):
   *
   *   10 000 attempts -> 1 000 reservations -> 0 double bookings
   *
   * These hold for BOTH strategies. If the Redis run produces 999, a lock is
   * being leaked somewhere; if it produces 1001, the advisory lock has been
   * allowed to overrule the index, which is the one thing it must never do.
   */
  thresholds: {
    reservations_created: ['count==1000'],
    reservations_conflicted: ['count==9000'],
    reservations_unexpected: ['count==0'],
    checks: ['rate==1.00'],
  },
};

export function setup() {
  return findPremiereShowtime(BASE_URL);
}

export default function correctness(target) {
  // Deterministic, not random: attempt n takes seat n mod 1000, so exactly ten
  // clients fight over each seat. Random choice would leave 0.05 seats untaken
  // on average -- the coupon collector with 10 000 draws into 1000 bins -- and
  // the run would fail once in twenty for a reason that has nothing to do with
  // locking (ADR 0021).
  const seatId = target.seatIds[exec.scenario.iterationInTest % target.seatIds.length];

  const response = http.post(
    `${BASE_URL}/api/v1/reservations`,
    JSON.stringify({ showtimeId: target.showtimeId, seatIds: [seatId] }),
    {
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': uuid() },
      tags: { name: 'POST /reservations' },
    },
  );

  if (response.status === 201) created.add(1);
  else if (response.status === 409) conflicted.add(1);
  else {
    unexpected.add(1);
    console.error(`unexpected ${response.status}: ${response.body}`);
  }
}

export function teardown() {
  checkReplicaBalance(BASE_URL, REPLICAS);
}
```

- [ ] **Step 4: Write the performance scenario**

Create `load/performance.js`:

```js
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

import { uuid } from './lib/uuid.js';
import { findPremiereShowtime } from './lib/target.js';
import { checkReplicaBalance } from './lib/replicas.js';

const BASE_URL = __ENV.BASE_URL || 'http://web';
const REPLICAS = Number(__ENV.API_REPLICAS || '3');

const created = new Counter('reservations_created');
const conflicted = new Counter('reservations_conflicted');
const failed = new Counter('reservations_failed');

export const options = {
  scenarios: {
    ramp: {
      /**
       * Arrival rate, not a fixed number of VUs (spec §9). With fixed VUs a
       * system that slows down lowers its own offered load and keeps looking
       * healthy; at a fixed arrival rate the overload shows up honestly, as a
       * growing queue.
       */
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 3_000,
      // Ramp to each step, then hold it: the numbers of interest are from the
      // plateaus, not from the climbs. Section 24's ladder is 100/500/1000/2000.
      stages: [
        { target: 100, duration: '10s' },
        { target: 100, duration: '30s' },
        { target: 500, duration: '10s' },
        { target: 500, duration: '30s' },
        { target: 1_000, duration: '10s' },
        { target: 1_000, duration: '30s' },
        { target: 2_000, duration: '10s' },
        { target: 2_000, duration: '30s' },
      ],
    },
  },
  /**
   * Only the replica-balance probe is a check, and only it is a threshold. A
   * red run therefore means "the topology is wrong", never "the system was
   * slow" -- 5xx and latency at 2000 RPS are the finding this run exists to
   * produce, and a threshold that aborted on them would hide the knee.
   */
  thresholds: { checks: ['rate==1.00'] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  return findPremiereShowtime(BASE_URL);
}

export default function performance(target) {
  const seatId = target.seatIds[exec.scenario.iterationInTest % target.seatIds.length];

  const response = http.post(
    `${BASE_URL}/api/v1/reservations`,
    JSON.stringify({ showtimeId: target.showtimeId, seatIds: [seatId] }),
    {
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': uuid() },
      tags: { name: 'POST /reservations' },
    },
  );

  if (response.status === 201) created.add(1);
  else if (response.status === 409) conflicted.add(1);
  else failed.add(1);
}

export function teardown() {
  checkReplicaBalance(BASE_URL, REPLICAS);
}
```

- [ ] **Step 5: Add the load generator to the stack**

In `docker-compose.yml`, add:

```yaml
  # Inside the stack's network, and pointed at nginx: a generator on the host
  # loopback would compete with the browser and the dev server for the same
  # sockets, and would measure the port mapping as well as the API.
  k6:
    image: grafana/k6:latest
    profiles: ['load']
    volumes:
      - ./load:/scripts:ro
    environment:
      BASE_URL: http://web
      API_REPLICAS: ${API_REPLICAS:-3}
    depends_on:
      api:
        condition: service_healthy
```

- [ ] **Step 6: Write the shell drivers**

Create `load/reset.sh`:

```bash
#!/usr/bin/env bash
# The shared starting state. Both strategies must begin from the same empty
# hall, or the comparison is between two different experiments.
set -euo pipefail

docker compose exec -T postgres psql -U cinema -d cinema \
  -c 'TRUNCATE reservation_seats, reservations CASCADE'
docker compose exec -T redis redis-cli FLUSHALL
echo 'reset: reservations truncated, redis flushed'
```

Create `load/verify.sh`:

```bash
#!/usr/bin/env bash
# The half of the correctness assertion k6 cannot make: what is actually in the
# database. k6 counting 1000 successes and the database holding 1001 active rows
# would be the exact failure this sub-project exists to rule out.
set -euo pipefail

read -r active duplicates <<EOF
$(docker compose exec -T postgres psql -U cinema -d cinema -At -F' ' -c "
  SELECT
    (SELECT count(*) FROM reservation_seats WHERE released_at IS NULL),
    (SELECT count(*) FROM (
       SELECT showtime_id, seat_id FROM reservation_seats WHERE released_at IS NULL
       GROUP BY showtime_id, seat_id HAVING count(*) > 1
     ) d)
")
EOF

echo "active reservation_seats rows: ${active}"
echo "double-booked (showtime, seat) pairs: ${duplicates}"

if [ "${active}" != '1000' ] || [ "${duplicates}" != '0' ]; then
  echo 'FAIL: expected exactly 1000 active rows and 0 duplicates' >&2
  exit 1
fi
echo 'PASS: 1000 seats sold, each exactly once'
```

Create `load/correctness.sh`:

```bash
#!/usr/bin/env bash
# Usage: LOCK_STRATEGY=redis bash load/correctness.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
strategy="${LOCK_STRATEGY:-db}"
export LOCK_STRATEGY="$strategy"
mkdir -p "$here/results"

docker compose up -d --build
# The API reads LOCK_STRATEGY once, at startup, so switching strategies means
# replacing the containers -- not just exporting a variable.
docker compose up -d --force-recreate --no-deps api

# Through nginx, because that is the path the run takes: this waits for the
# replicas AND for the balancer to resolve them.
for _ in $(seq 1 60); do
  curl -sf 'http://localhost:8080/api/v1/movies?limit=1' >/dev/null && break
  sleep 2
done

bash "$here/reset.sh"
docker compose run --rm k6 run /scripts/correctness.js 2>&1 |
  tee "$here/results/${strategy}-correctness.txt"
bash "$here/verify.sh" 2>&1 | tee -a "$here/results/${strategy}-correctness.txt"
```

Create `load/performance.sh`:

```bash
#!/usr/bin/env bash
# Usage: LOCK_STRATEGY=redis DATABASE_POOL_MAX=20 bash load/performance.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
strategy="${LOCK_STRATEGY:-db}"
export LOCK_STRATEGY="$strategy"
mkdir -p "$here/results"

docker compose up -d --build
docker compose up -d --force-recreate --no-deps api

for _ in $(seq 1 60); do
  curl -sf 'http://localhost:8080/api/v1/movies?limit=1' >/dev/null && break
  sleep 2
done

bash "$here/reset.sh"
docker compose run --rm k6 run /scripts/performance.js 2>&1 |
  tee "$here/results/${strategy}-performance.txt"
```

Then make them executable: `chmod +x load/*.sh`.

Add `load/results/` to `.gitignore` — a transcript per machine is noise in the history; the numbers that matter are transcribed into the report in Task 9.

- [ ] **Step 7: Wire the npm scripts**

In the root `package.json`, add to `scripts`:

```json
    "load:reset": "bash load/reset.sh",
    "load:correctness": "bash load/correctness.sh",
    "load:performance": "bash load/performance.sh",
```

- [ ] **Step 8: Run the correctness scenario on both strategies**

Run:

```bash
LOCK_STRATEGY=db npm run load:correctness
LOCK_STRATEGY=redis npm run load:correctness
```

Expected, twice: k6 reports `reservations_created` 1000, `reservations_conflicted` 9000, `reservations_unexpected` 0, all checks passing, and `verify.sh` printing `PASS: 1000 seats sold, each exactly once`.

If the balance check fails, stop and fix Task 7's nginx before running anything else — every number after it would be a measurement of one container.

If `reservations_conflicted` is short and `reservations_unexpected` is not zero, read the logged status: a 400 means the seed window has passed, a 5xx means something escaped as an internal error and must be fixed rather than tolerated.

- [ ] **Step 9: Run the performance scenario on both strategies**

Run:

```bash
LOCK_STRATEGY=db npm run load:performance
LOCK_STRATEGY=redis npm run load:performance
```

Expected: two transcripts under `load/results/`, each carrying `http_reqs` (throughput), `http_req_duration` with `p(95)` and `p(99)`, the three reservation counters, and the replica tally. Nothing is asserted here; the numbers are the deliverable.

Keep both transcripts open for Task 9 — they are the source for the report's table, and the report must quote what happened rather than what was expected.

- [ ] **Step 10: Verify and commit**

Run: `npm run lint && npm run format:check`
Expected: pass. (`load/**` is lint-ignored but prettier still formats it; run `npm run format` if the check complains.)

```bash
git add load package.json eslint.config.js docker-compose.yml .gitignore
git commit -m "test(load): add the k6 correctness and performance scenarios and their drivers"
```

---

## Task 9: The record — decisions, the report, and the README

The experiment is not finished when it runs; it is finished when someone else can read what it showed and why the design is what it is. Do this task **after** Task 8's runs, with the transcripts in hand.

**Files:**

- Create: `docs/adr/0016-redis-as-an-advisory-lock-in-front-of-the-invariant.md`
- Create: `docs/adr/0017-selectable-lock-strategy-instead-of-replacing-the-database-path.md`
- Create: `docs/adr/0018-fail-open-on-redis-failure.md`
- Create: `docs/adr/0019-key-lives-as-long-as-the-hold-released-by-owner-in-lua.md`
- Create: `docs/adr/0020-several-api-replicas-behind-nginx-with-runtime-dns.md`
- Create: `docs/adr/0021-deterministic-seat-choice-in-the-load-test.md`
- Create: `docs/adr/0022-redis-ttl-does-not-replace-lazy-expiry.md`
- Create: `docs/adr/0023-application-generated-reservation-id-and-in-process-seat-geometry.md`
- Create: `docs/experiments/2026-08-28-db-vs-redis-locking.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: the transcripts in `load/results/` from Task 8.
- Produces: documentation only.

- [ ] **Step 1: Write the eight decision records**

Each follows the existing house format — `# N. Title`, `**Status:** accepted (2026-08-28)`, then `## Context`, `## Decision`, `## Alternatives considered`, `## Consequences`. Read `docs/adr/0015-contention-tests-and-pool-size.md` first for the register: an alternative is named and rejected with the reason, not listed.

Write them with this content:

**0016 — Redis as an advisory lock in front of the invariant, not instead of it.** Context: sub-project 2's cost is that every loser pays a transaction; nine thousand of them hold nine thousand connections and block inside `ON CONFLICT` until the winner commits, so contention for a seat becomes a queue for a connection. Decision: `SET NX EX` before the transaction opens; the partial unique index stays the invariant. Alternatives: **Redis as the source of truth** — requires that `FLUSHALL` can never happen, and it can; a cold or restarted Redis would then permit double bookings, which is the one failure this project exists to prevent. **Row-level `SELECT ... FOR UPDATE` on the seat** — still a transaction and a connection per loser, so it moves the queue without shortening it. Consequences: the absence of a key never means "free", only "Redis does not know"; a dead Redis degrades to sub-project 2; and the false-rejection window in the other direction is bounded by the TTL and documented.

**0017 — A selectable strategy instead of replacing the database path.** Context: ADR 0008 deferred Redis so the comparison would have an honest baseline; the comparison has to stay re-runnable. Decision: `LOCK_STRATEGY=db|redis`, both adapters compiled into every build, `db` by default. Alternatives: **delete the database path once Redis works** — the baseline would then be an old tag built by a different compiler against different dependencies, so any difference measured would include the difference between two builds. **A build flag** — same problem in a smaller form, plus two artefacts to keep honest. Consequences: `NoopSeatLock` exists so `db` is the same `create()` with a do-nothing adapter rather than a second code path; the contention suite runs twice, once per strategy; the experiment can be reproduced on any commit after this one.

**0018 — Fail open when Redis fails, and `/ready` does not check Redis.** Context: an advisory lock that can fail the request has made an optional subsystem load-bearing. Decision: connection errors and command timeouts (`REDIS_COMMAND_TIMEOUT_MS`, default 200 ms) are logged at `warn`, counted, and the request continues on the database path; readiness still means "PostgreSQL answers". Also records the deviation from spec §7's table: `REDIS_URL` has no default, because a default makes the "refuse to start without it" rule unreachable. Alternatives: **fail closed** — trades a guarantee we have (correctness without Redis) for one we do not need. **Add Redis to `/ready`** — takes every replica out of rotation over a subsystem the service works without, turning a throughput problem into an outage. **Circuit breaker now** — the right next step, and sub-project 5 gives it a real client and one abstraction; writing it here means writing it twice. Consequences: each request pays the timeout while Redis is down; a failed `release` leaves a key holding a free seat until the TTL, which is exactly why the TTL is one hold long.

**0019 — The key lives as long as the hold, and is released by owner in Lua.** Context: the key's lifetime and the row's lifetime are two different clocks. Decision: `SET ... NX EX RESERVATION_TTL_SECONDS`; release and retain are Lua scripts that compare the value before acting. Alternatives: **`GET` then `DEL` from the client** — the same check-then-act race the database path was built to avoid: the key can lapse and be re-taken between the two commands, and we delete a lock we do not own. **A key that lives for a day** — every failed release then blocks a free seat until tomorrow. **`MULTI` instead of a pipeline** — buys an atomicity that is not wanted, since the partial acquisition is rolled back deliberately, and costs a server-wide block. Consequences: keys are not sorted before acquisition, because `SET NX` never waits and so no deadlock cycle can form (contrast ADR 0010); a repeated `release` is a no-op, which is the only idempotence this sub-project has — `Idempotency-Key` belongs to sub-project 5.

**0020 — Several API replicas behind nginx, with DNS resolved at runtime.** Context: locking across processes is meaningless in a stack with one process. Decision: `deploy: replicas: ${API_REPLICAS:-3}`, no published API port, and `apps/web/nginx.conf` gains `resolver 127.0.0.11 valid=10s` with `proxy_pass` through a variable. Alternatives: **leave the literal `proxy_pass http://api:3000`** — nginx resolves the name once at startup and pins every request to one replica; the stack looks balanced and the experiment measures a single container. This is the most likely way to get a fake result, so it is not merely rejected: the API stamps `X-Instance-Id` and the k6 run fails when any replica served less than half its equal share. **An explicit `upstream` block with three hostnames** — hardcodes the replica count into the image. Consequences: the API is reached at `http://localhost:8080/api/`; `docker-compose.single-api.yml` restores port 3000 for development.

**0021 — Deterministic seat choice in the load test.** Context: 10 000 attempts over 1000 seats must end with exactly 1000 reservations. Decision: attempt *n* takes seat *n mod 1000*, so exactly ten clients contend for each seat. Alternatives: **random choice** — the coupon-collector expectation leaves about 0.05 seats untaken per run, so the assertion `created == 1000` fails roughly once in twenty for a reason unrelated to locking, and a flaky correctness test is worse than none. Consequences: contention per seat is uniform rather than realistic, which is the right trade for a pass/fail assertion; a realistic popularity distribution belongs to the performance scenario if it is ever wanted.

**0022 — Redis TTL does not replace lazy expiry (amends ADR 0011).** Context: ADR 0011 expected sub-project 3's TTL to take over hold expiry. Decision: it does not. The key lapsing writes nothing to PostgreSQL, and PostgreSQL is the source of truth, so a lapsed key leaves a `PENDING` row past `expires_at` that only a caller can settle. Alternatives: **Redis keyspace notifications driving a listener that expires the row** — a background worker with no delivery guarantee, arriving before the sub-project that gives the project a real one. Consequences: `releaseStaleHolds` stays authoritative and now also drops the stale owner's key after the commit; the real replacement is `reservation.expire` over RabbitMQ in sub-project 4.

**0023 — The reservation id comes from the application, and seat geometry is cached in process.** Context: the lock's value must exist before the row does, and the fast 409 has to name seats ("C7") without reading the database. Decision: `uuidv7()` in `apps/api/src/db/uuid-v7.ts` mints the id, the column default stays as the guarantee for any other write path, and `SeatGeometryCache` memoises `seatId → label` per hall. Alternatives: **`sessionId` as the lock value** — breaks on an honest sequence: a session cancels an old reservation and the release deletes a key that already belongs to that same session's new reservation for the same seat. **Fetching labels per loser** — nine thousand SELECTs replacing nine thousand transactions, which moves the load Redis was added to remove rather than removing it. **Making `label` optional in the contract** — degrades the public response to accommodate an internal detail. Consequences: the cache has no invalidation because the catalogue is immutable in this sub-project, and that is a recorded limitation — an admin screen that edits seats adds the eviction hook to that class; the memoiser caches promises so a cold cache under a thousand concurrent misses issues one query.

- [ ] **Step 2: Write the experiment report**

Create `docs/experiments/2026-08-28-db-vs-redis-locking.md`, transcribing the real numbers from `load/results/`. Use this skeleton and fill every cell — leave nothing as a dash:

```markdown
# Database locking vs Redis locking under contention

**Date:** 2026-08-28
**Spec:** `docs/superpowers/specs/2026-08-28-cinema-platform-phase-3-design.md` §9
**Scripts:** `load/correctness.js`, `load/performance.js`

## Prediction, recorded before the run

The `db` path should degrade first. Each of the nine thousand losers takes a
connection from the pool and blocks inside `ON CONFLICT` until the winner
commits, so contention for a seat becomes a queue for a connection, and the knee
is expected near `DATABASE_POOL_MAX × replicas`. The `redis` path should turn
losers away in one round-trip without opening a transaction, and should run into
something else — the network, and Redis being single-threaded.

If the numbers say otherwise, this document says so. An experiment that can only
confirm its hypothesis is not an experiment, and "Redis is not needed here"
would be as legitimate a result of this sub-project as the opposite.

## Conditions

| | |
| --- | --- |
| Hardware | <cpu, cores, memory, host OS> |
| Images | `postgres:18-alpine`, `redis:8-alpine`, `grafana/k6:<tag>`, `node:24-alpine`, `nginx:1.29-alpine` |
| API replicas | 3 |
| `DATABASE_POOL_MAX` | 10 |
| `RESERVATION_TTL_SECONDS` | 600 |
| Hall | Premiere, 1000 seats |
| Starting state | `TRUNCATE reservation_seats, reservations CASCADE` + `FLUSHALL` before each run |

## Run 1 — correctness

| Strategy | 201 | 409 | 5xx | Active rows | Double bookings |
| --- | --- | --- | --- | --- | --- |
| `db` | | | | | |
| `redis` | | | | | |

## Run 2 — performance

| Strategy | Arrival rate | Throughput (req/s) | p95 | p99 | Error rate | 409 share |
| --- | --- | --- | --- | --- | --- | --- |
| `db` | 100 | | | | | |
| `db` | 500 | | | | | |
| `db` | 1000 | | | | | |
| `db` | 2000 | | | | | |
| `redis` | 100 | | | | | |
| `redis` | 500 | | | | | |
| `redis` | 1000 | | | | | |
| `redis` | 2000 | | | | | |

Replica distribution: <the tally each run printed>

## The knee

<Where each strategy stopped scaling, and what it hit. Name the resource.>

## What the numbers show

<Two or three paragraphs. Say whether the prediction held. If Redis did not pay
for itself at this scale, say that plainly and say at what scale it would.>

## What this does not measure

- One machine, containers sharing CPU with the load generator's network stack.
- One seat per request; multi-seat holds pay for a pipeline of N and are not measured here.
- No payment step, so a `PENDING` hold is never held for its full ten minutes.
- Redis never fails during a measured run; the fail-open cost is covered by tests, not by a number here.
```

- [ ] **Step 3: Update the README**

Three edits:

1. In the opening paragraph, replace "**Phase 2 — reservations and contention — is what exists today:**" with a sentence naming phase 3: the catalogue and seat map from phase 1, holds and the no-double-booking proof from phase 2, and now an advisory Redis lock in front of the transaction with the numbers that say what each strategy costs.

2. Replace the "What phase 2 deliberately does not have" section with a phase 3 version: still no authentication, no payments, no queues, no metrics — and say what phase 3 added and why (`ioredis`, because the database path had a measurable cost, and ADR 0008 required that cost be measured before the technology was allowed in).

3. Add a section after "Proving it":

````markdown
## The experiment

Sub-project 3's deliverable is a comparison, not an opinion. Both strategies run
the same two scenarios against the same stack:

```bash
LOCK_STRATEGY=db    npm run load:correctness   # 10 000 attempts -> 1000 sold, 0 twice
LOCK_STRATEGY=redis npm run load:correctness
LOCK_STRATEGY=db    npm run load:performance   # 100 -> 500 -> 1000 -> 2000 req/s
LOCK_STRATEGY=redis npm run load:performance
```

k6 runs inside the stack's network and goes through nginx, so it competes with
nothing on the host loopback. The correctness run is pass/fail and does not
depend on how fast the machine is; the performance run asserts nothing except
that all three replicas were actually serving traffic — a run where one replica
answered everything is a measurement of one container, not of a cluster.

Results: [`docs/experiments/2026-08-28-db-vs-redis-locking.md`](docs/experiments/2026-08-28-db-vs-redis-locking.md).
````

Add a "Notable details" bullet:

```markdown
- **The Redis lock is advisory, and the index still has the last word.** A key
  missing means Redis does not know, never that the seat is free. `FLUSHALL`
  against a running stack costs a wasted transaction per request and produces no
  double booking — there is a test that does exactly that.
```

- [ ] **Step 4: Verify and commit**

Run: `npm run format:check`
Expected: pass. Run `npm run format` first if it does not — `docs/adr/` and `docs/experiments/` are formatted by prettier, unlike `docs/superpowers/`.

```bash
git add docs README.md
git commit -m "docs: record the phase 3 decisions and the db-vs-redis measurement"
```

---

## Definition of Done

- [ ] 10 000 attempts against a 1000-seat hall produce exactly 1000 reservations, 9000 `409`s, zero 5xx and zero double-booked `(showtime_id, seat_id)` pairs — **for both strategies**, in k6 and in SQL.
- [ ] Fifty concurrent clients on one seat still produce exactly one `201` and forty-nine `409`s on both strategies; a thousand clients on a thousand distinct seats still all succeed.
- [ ] `LOCK_STRATEGY=db` on this commit behaves exactly as phase 2 did — every phase 2 suite passes untouched.
- [ ] Killing Redis mid-stack does not fail a request, does not make `/ready` go red, and is visible as a `warn` with a counter.
- [ ] Flushing Redis mid-stack produces no double booking; a stale key produces a `409` on a free seat, and that false rejection is documented rather than fixed.
- [ ] A lock is released on cancel, on lazy expiry and on a failed hold, retained on confirm, and never released by a reservation that does not own it.
- [ ] The stack runs three API replicas behind nginx, all three serve traffic, and the k6 run fails if they do not.
- [ ] `npm run lint && npm run typecheck && npm test` pass, and the Playwright smoke test still walks from the movie list to a confirmed reservation through the balancer.
- [ ] No RabbitMQ, no `Idempotency-Key`, no circuit breaker, no rate limiting, no Prometheus, no Redis read cache, no payments, no authentication. `ioredis` is the only new runtime dependency.
- [ ] Eight ADRs record the decisions, each naming the alternative it rejected, and the experiment report carries real numbers with a stated verdict — including the verdict "Redis did not pay for itself here", if that is what happened.

## Handover to sub-project 4

- **Lazy expiry is still authoritative** and now also drops the stale owner's key. `releaseStaleHolds` is the seam `reservation.expire` over RabbitMQ replaces — a key lapsing writes nothing to PostgreSQL, which is why the TTL could never be the replacement (ADR 0022).
- **`RedisSeatLock.failureCount`, the acquire/lose split and the replica tally** exist in logs and in k6 output. Section 22 has something to scrape on its first day.
- **Fail open is where the circuit breaker goes** (§20, sub-project 5): today every request pays the timeout while Redis is down.
- **The topology is the precondition for everything that follows.** Workers, consumers and idempotency only mean anything where there is more than one instance, and there now are three.
- **The numbers in `docs/experiments/`** are the baseline every later change is measured against: the RabbitMQ queue, ClickHouse batching, and the §12 optimisation.
- **`uuidv7()` in the application** is now available wherever an id must exist before its row does — which is every outbox row and every message correlation id sub-project 4 will write.
