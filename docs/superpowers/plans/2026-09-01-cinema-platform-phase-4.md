# Cinema Booking Platform — Phase 4 (RabbitMQ, the expiry worker, retry and DLQ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the expiry of a seat hold a delivered message instead of a side effect of someone else's request, and prove by failure injection that the delivery path survives duplicates, handler failures, poison bodies and a dead broker — without ever becoming necessary for a seat to be freed.

**Architecture:** One durable direct exchange, `cinema.commands`, and six queues. `create()` publishes `{ reservationId }` after the commit into `reservation.expire.wait`, a queue with no consumer whose `x-message-ttl` is the length of a hold; when the message lapses the broker dead-letters it into `reservation.expire`, where a separate worker process consumes it and calls a new idempotent `ReservationService.settleExpired`. A failing handler is republished into one of three fixed-TTL retry tiers and finally into a DLQ. Lazy expiry (ADR 0011) is untouched and stays authoritative, so a broker that is down costs nothing but a warning.

**Tech Stack:** Phase 3's stack — NestJS 12 on Fastify, Drizzle + PostgreSQL 18, Zod 4 contracts, Jest 30 + Testcontainers, ioredis 6, React 19 — plus exactly one addition: `amqplib` 2 (runtime). The broker is the stock `rabbitmq:4-management-alpine` image.

**Spec:** `docs/superpowers/specs/2026-09-01-cinema-platform-phase-4-design.md`

## Global Constraints

Rules that apply to every task:

- **`amqplib` is the only new runtime dependency.** Nothing else is installed into `apps/api`. Not `amqp-connection-manager` — connection recovery is a library feature since amqplib 1.1.0 and the plan uses it. Not `@nestjs/microservices` — it would hide ack, nack, prefetch and requeue, which are the things spec §10 exists to learn. If a task seems to need a second dependency, stop and ask.
- **`@types/amqplib` must NOT be installed.** amqplib bundles its own type definitions (`index.d.ts`) as of 1.2.0. Installing the DefinitelyTyped package alongside them produces two competing declarations for the same module.
- **The correctness invariant never moves.** Lazy expiry (`releaseStaleHolds`) stays exactly as it is and stays authoritative. No task may delete it, weaken it, or make any code path depend on a message having been delivered. A worker that changed any answer phase 2 or phase 3 proved would be a worker that had quietly become load-bearing.
- **The subsystem does not switch itself on.** `RESERVATION_EXPIRY_MODE` defaults to `lazy`, and on `lazy` the API opens no connection, publishes nothing, and declares no queue — exactly as `LOCK_STRATEGY=db` opens no Redis connection (ADR 0017). Phase 3's measured baseline must stay reproducible on this commit.
- **Nothing polls.** The worker has no timer, no cron and no `setInterval`, and never queries for due reservations. It acts only on a message the broker hands it. The one `setTimeout` this plan introduces is a shutdown drain loop, not a schedule.
- **Out of scope, each with its own sub-project:** the transactional outbox, `Idempotency-Key`, circuit breakers, rate limiting, Prometheus/Grafana, Kafka, payments, authentication, the `bookings`/`payments`/`tickets` tables, and every message other than `reservation.expire`.
- **The frontend does not change.** No file under `apps/web/src` is modified by this plan, and neither is `apps/web/nginx.conf`.
- **Money is `integer` in minor units** (`*_cents`), single currency UAH. **Timestamps are `timestamptz` in UTC.** **JSON field names are camelCase.**
- **Time comparisons against the database use the database's `now()`**, never the Node process clock. The broker's TTL is deliberately a different clock, which is why "not yet due" is a legal outcome the handler must tolerate rather than an error.
- **`@cinema/contracts` must be rebuilt (`npm run build -w @cinema/contracts`) before `apps/api` or `apps/web` are typechecked or tested** after any change to it. This plan changes no contract, but the build is still the first step of `npm test`.
- **Commit after every task** using the message given in that task's final step.

## Existing code this plan builds on

Read these before starting — the plan assumes their shapes and does not repeat them:

| File                                               | What it gives you                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/api/src/config/env.ts`                       | `parseEnv`, `AppConfig`, and the Zod object plus `.refine` chain every new variable joins                   |
| `apps/api/src/locking/redis.module.ts`             | The exact shape `rabbit.module.ts` mirrors: a symbol token, a factory returning `null` when off, shutdown   |
| `apps/api/src/locking/redis-seat-lock.ts`          | The fail-open register: a `failures` counter, a `warn` naming the operation, and the request continuing     |
| `apps/api/src/reservations/reservation.service.ts` | `create`, `confirm`, `cancel`, and the private `expire` / `releaseLocks` / `releaseSeatsOf` this plan reuses |
| `apps/api/src/db/drizzle.module.ts`                | `DRIZZLE`, `Database`, `Executor`, and `onApplicationShutdown` draining the pool                            |
| `apps/api/src/observability/request-context.ts`    | `currentRequestId()` — the value that becomes the message's `correlationId`                                 |
| `apps/api/test/harness.ts`                         | `startTestDatabase` / `startTestRedis` and their URL getters; the broker container is added beside them     |
| `apps/api/test/global-setup.ts`                    | Starts containers concurrently and writes their URLs to files `setup-after-env.ts` reads                    |
| `apps/api/test/reservation-harness.ts`             | `startReservationHarness()`; its env-override-then-compile-then-restore pattern is copied by the worker harness |
| `apps/api/test/truncate.ts`                        | `truncateReservations(db, redis)` — the between-test reset the new suites also need                         |
| `docker-compose.yml`                               | The stack Task 9 extends; note `migrate` and `seed` are already one-shot services off the same image        |

## File Structure

```
apps/api/src/
├── messaging/
│   ├── messages.ts                 # NEW: exchange/queue/key names, the Zod body schema, the attempt header
│   ├── messages.test.ts            # NEW: name stability and body parsing
│   ├── topology.ts                 # NEW: assertTopology() — the ONLY place a queue is declared
│   ├── retry.ts                    # NEW: nextHop()/attemptOf() — pure, no broker
│   ├── retry.test.ts               # NEW: the ladder and its end
│   ├── rabbit.module.ts            # NEW: RABBIT token, recovering connection, shutdown
│   └── expire.publisher.ts         # NEW: confirm channel, mandatory, fail open, counter
├── worker/
│   ├── worker.module.ts            # NEW: the worker's DI graph — no controllers
│   ├── expire.consumer.ts          # NEW: prefetch, the decision table, forward-then-ack
│   └── main.ts                     # NEW: Nest application context, no HTTP; exits on `lazy`
├── reservations/
│   ├── reservation.service.ts      # MODIFY: settleExpired(), and one publish at the end of create()
│   └── reservation.module.ts       # MODIFY: imports MessagingModule, exports ReservationService
├── config/
│   ├── env.ts                      # MODIFY: five variables and one refine
│   └── env.test.ts                 # MODIFY: six new cases
└── app.module.ts                   # MODIFY: imports MessagingModule

apps/api/test/
├── harness.ts                      # MODIFY: startTestRabbit / getTestRabbitUrl
├── global-setup.ts                 # MODIFY: third container, third URL file
├── global-teardown.ts              # MODIFY: stop it
├── setup-after-env.ts              # MODIFY: RABBITMQ_URL into the environment
├── rabbit-harness.ts               # NEW: topology reset, worker context, queue inspection
├── topology.e2e.spec.ts            # NEW: declaration and idempotence
├── expire-publisher.e2e.spec.ts    # NEW: what create() publishes, and fail open
├── settle-expired.e2e.spec.ts      # NEW: the decision table, at the service level
├── expire-consumer.e2e.spec.ts     # NEW: the decision table, through a real broker
├── expire-retry.e2e.spec.ts        # NEW: the ladder, the DLQ, the poison body
└── expire-resilience.e2e.spec.ts   # NEW: reconnect, shutdown, competing consumers, lazy mode

docker-compose.yml                  # MODIFY: rabbitmq and worker services
docker-compose.single-api.yml       # MODIFY: publish the management UI for development
.env.example                        # MODIFY: the five new variables, documented
docs/adr/0024..0032-*.md            # NEW: nine decision records
README.md                           # MODIFY: phase 4's paragraph, section and bullets
```

---

## Task 1: Configuration and the message vocabulary

Nothing connects to anything in this task. It establishes the five environment variables, the names every later task imports, and the one schema that decides whether a body is a message at all.

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/config/env.test.ts`
- Create: `apps/api/src/messaging/messages.ts`
- Create: `apps/api/src/messaging/messages.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Consumes: `parseEnv`, `AppConfig` from `config/env.ts`.
- Produces: `AppConfig.reservationExpiryMode: 'lazy' | 'queue'`, `.rabbitmqUrl: string | undefined`, `.rabbitmqPrefetch: number`, `.rabbitmqPublishTimeoutMs: number`, `.rabbitmqRetryDelaysMs: number[]`; and from `messaging/messages.ts` the constants `COMMANDS_EXCHANGE`, `EXPIRE_WAIT_QUEUE`, `EXPIRE_QUEUE`, `EXPIRE_DLQ`, `EXPIRE_WAIT_KEY`, `EXPIRE_KEY`, `EXPIRE_DEAD_KEY`, `ATTEMPT_HEADER`, the functions `retryQueue(tier: number): string` and `retryKey(tier: number): string`, the schema `expireMessageSchema` and the type `ExpireMessage`.

- [ ] **Step 1: Install amqplib**

```bash
npm install amqplib@^2.0.1 -w @cinema/api
```

Then confirm no DefinitelyTyped package came with it, and that the bundled types are present:

```bash
# NOT `node -e "require('amqplib/package.json')"` — amqplib's exports map does
# not expose ./package.json, so Node refuses it with ERR_PACKAGE_PATH_NOT_EXPORTED.
grep '"types"' node_modules/amqplib/package.json    # expect "types": "./index.d.ts"
ls node_modules/amqplib/index.d.ts                  # expect the file to exist
grep -c '@types/amqplib' apps/api/package.json package-lock.json   # expect 0 for both
```

If `@types/amqplib` appears anywhere, remove it: amqplib ships its own declarations and the two conflict.

- [ ] **Step 2: Write the failing config tests**

Add these cases to `apps/api/src/config/env.test.ts`. The first two extend the existing `parses a valid environment` and `applies defaults` expectations rather than replacing them — add the five new keys to the object those tests already assert on:

```ts
// In `parses a valid environment into typed config`, add to the expected object:
reservationExpiryMode: 'lazy',
rabbitmqUrl: undefined,
rabbitmqPrefetch: 20,
rabbitmqPublishTimeoutMs: 200,
rabbitmqRetryDelaysMs: [5_000, 30_000, 120_000],

// In `applies defaults for everything except DATABASE_URL`, add:
expect(config.reservationExpiryMode).toBe('lazy');
expect(config.rabbitmqUrl).toBeUndefined();
expect(config.rabbitmqPrefetch).toBe(20);
expect(config.rabbitmqPublishTimeoutMs).toBe(200);
expect(config.rabbitmqRetryDelaysMs).toEqual([5_000, 30_000, 120_000]);
```

Then add these six cases at the end of the `describe`:

```ts
it('accepts queue mode when a broker url is supplied', () => {
  const config = parseEnv({
    ...valid,
    RESERVATION_EXPIRY_MODE: 'queue',
    RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  });
  expect(config.reservationExpiryMode).toBe('queue');
  expect(config.rabbitmqUrl).toBe('amqp://guest:guest@localhost:5672');
});

it('refuses queue mode without a broker url', () => {
  // The same rule as LOCK_STRATEGY/REDIS_URL: a default would make this
  // unreachable, so RABBITMQ_URL deliberately has none (spec §7).
  expect(() => parseEnv({ ...valid, RESERVATION_EXPIRY_MODE: 'queue' })).toThrow(/RABBITMQ_URL/);
});

it('rejects a broker url that is not amqp', () => {
  expect(() =>
    parseEnv({ ...valid, RESERVATION_EXPIRY_MODE: 'queue', RABBITMQ_URL: 'http://localhost:5672' }),
  ).toThrow(/RABBITMQ_URL/);
});

it('parses the retry ladder into milliseconds', () => {
  const config = parseEnv({ ...valid, RABBITMQ_RETRY_DELAYS_MS: '100, 200,400' });
  expect(config.rabbitmqRetryDelaysMs).toEqual([100, 200, 400]);
});

it('rejects a retry ladder that is not positive integers', () => {
  expect(() => parseEnv({ ...valid, RABBITMQ_RETRY_DELAYS_MS: '100,nope' })).toThrow(
    /RABBITMQ_RETRY_DELAYS_MS/,
  );
});

it('rejects an empty retry ladder', () => {
  // Zero tiers would mean the first failure dead-letters, which is a decision
  // nobody made -- it must be spelled, not fallen into.
  expect(() => parseEnv({ ...valid, RABBITMQ_RETRY_DELAYS_MS: '' })).toThrow(
    /RABBITMQ_RETRY_DELAYS_MS/,
  );
});
```

- [ ] **Step 3: Run the config tests to verify they fail**

Run: `npm test -w @cinema/api -- env.test`
Expected: FAIL — the new keys are missing from the parsed config.

- [ ] **Step 4: Add the five variables to the schema**

In `apps/api/src/config/env.ts`, add to `envObject` after `REDIS_COMMAND_TIMEOUT_MS`:

```ts
  // `lazy` by default, deliberately: a new subsystem does not switch itself on,
  // and phase 3's measured baseline must stay reproducible on this commit
  // (the same argument as ADR 0017 for LOCK_STRATEGY).
  RESERVATION_EXPIRY_MODE: z.enum(['lazy', 'queue']).default('lazy'),
  // No default, for the reason REDIS_URL has none: a default makes the refine
  // below vacuous, and refusing to boot beats answering 500 to every request.
  RABBITMQ_URL: z.url({ protocol: /^amqps?$/ }).optional(),
  // Unacknowledged messages per channel. Bounds how much work one worker takes
  // on before it has finished any of it.
  RABBITMQ_PREFETCH: z.coerce.number().int().min(1).max(10_000).default(20),
  // Past this, a slow broker is treated as a dead one and the hold is answered
  // without a message. The hold is already committed; only the message is lost.
  RABBITMQ_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(200),
  // One queue per tier, each with a fixed TTL. The length of this list is the
  // number of retries; the values are the backoff (spec §3).
  RABBITMQ_RETRY_DELAYS_MS: z
    .string()
    .default('5000,30000,120000')
    .transform((value, ctx) => {
      const delays = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map(Number);

      if (delays.length === 0 || delays.some((ms) => !Number.isInteger(ms) || ms < 1)) {
        ctx.addIssue({
          code: 'custom',
          message: 'must be a comma-separated list of positive integers, e.g. 5000,30000,120000',
        });
        return z.NEVER;
      }
      return delays;
    }),
```

Add a second `.refine` to the chain, so it reads:

```ts
const envSchema = envObject
  .refine((env) => env.LOCK_STRATEGY !== 'redis' || env.REDIS_URL !== undefined, {
    path: ['REDIS_URL'],
    error: 'REDIS_URL is required when LOCK_STRATEGY is redis',
  })
  .refine((env) => env.RESERVATION_EXPIRY_MODE !== 'queue' || env.RABBITMQ_URL !== undefined, {
    path: ['RABBITMQ_URL'],
    error: 'RABBITMQ_URL is required when RESERVATION_EXPIRY_MODE is queue',
  });
```

Add to the `AppConfig` type:

```ts
  reservationExpiryMode: z.infer<typeof envObject>['RESERVATION_EXPIRY_MODE'];
  rabbitmqUrl: string | undefined;
  rabbitmqPrefetch: number;
  rabbitmqPublishTimeoutMs: number;
  rabbitmqRetryDelaysMs: number[];
```

And to the object `parseEnv` returns:

```ts
    reservationExpiryMode: env.RESERVATION_EXPIRY_MODE,
    rabbitmqUrl: env.RABBITMQ_URL,
    rabbitmqPrefetch: env.RABBITMQ_PREFETCH,
    rabbitmqPublishTimeoutMs: env.RABBITMQ_PUBLISH_TIMEOUT_MS,
    rabbitmqRetryDelaysMs: env.RABBITMQ_RETRY_DELAYS_MS,
```

- [ ] **Step 5: Run the config tests to verify they pass**

Run: `npm test -w @cinema/api -- env.test`
Expected: PASS, all cases.

- [ ] **Step 6: Write the failing vocabulary test**

Create `apps/api/src/messaging/messages.test.ts`:

```ts
import {
  ATTEMPT_HEADER,
  COMMANDS_EXCHANGE,
  EXPIRE_DEAD_KEY,
  EXPIRE_DLQ,
  EXPIRE_KEY,
  EXPIRE_QUEUE,
  EXPIRE_WAIT_KEY,
  EXPIRE_WAIT_QUEUE,
  expireMessageSchema,
  retryKey,
  retryQueue,
} from './messages';

describe('the reservation.expire vocabulary', () => {
  it('names the exchange, the queues and the keys', () => {
    // Written out rather than derived: these names are on the wire and in the
    // management UI, and a rename is a migration, not a refactor.
    expect(COMMANDS_EXCHANGE).toBe('cinema.commands');
    expect(EXPIRE_WAIT_QUEUE).toBe('reservation.expire.wait');
    expect(EXPIRE_QUEUE).toBe('reservation.expire');
    expect(EXPIRE_DLQ).toBe('reservation.expire.dlq');
    expect(EXPIRE_WAIT_KEY).toBe('reservation.expire.wait');
    expect(EXPIRE_KEY).toBe('reservation.expire');
    expect(EXPIRE_DEAD_KEY).toBe('reservation.expire.dead');
    expect(ATTEMPT_HEADER).toBe('x-attempt');
  });

  it('numbers retry tiers from one', () => {
    expect(retryQueue(1)).toBe('reservation.expire.retry.1');
    expect(retryKey(3)).toBe('reservation.expire.retry.3');
  });

  it('accepts a body carrying only a reservation id', () => {
    const id = '019316b8-1f9c-7000-8000-000000000000';
    expect(expireMessageSchema.parse({ reservationId: id })).toEqual({ reservationId: id });
  });

  it('rejects a body whose id is not a uuid', () => {
    expect(() => expireMessageSchema.parse({ reservationId: 'nope' })).toThrow();
  });

  it('ignores extra fields rather than trusting them', () => {
    // The point of an id-only body is that a stale message carries no stale
    // facts. Anything else that arrives is not read (spec §4).
    const id = '019316b8-1f9c-7000-8000-000000000000';
    expect(expireMessageSchema.parse({ reservationId: id, seatIds: ['x'] })).toEqual({
      reservationId: id,
    });
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npm test -w @cinema/api -- messages.test`
Expected: FAIL — `Cannot find module './messages'`.

- [ ] **Step 8: Write the vocabulary**

Create `apps/api/src/messaging/messages.ts`:

```ts
import { z } from 'zod';

/**
 * The one exchange. Direct, not topic: the keys below are exact names, not
 * patterns. A wildcard would be a promise to a second consumer that does not
 * exist yet -- when one does, it can be widened then (spec §3).
 */
export const COMMANDS_EXCHANGE = 'cinema.commands';

export const EXPIRE_WAIT_QUEUE = 'reservation.expire.wait';
export const EXPIRE_QUEUE = 'reservation.expire';
export const EXPIRE_DLQ = 'reservation.expire.dlq';

export const EXPIRE_WAIT_KEY = 'reservation.expire.wait';
export const EXPIRE_KEY = 'reservation.expire';
export const EXPIRE_DEAD_KEY = 'reservation.expire.dead';

/** Tiers are 1-based: tier 1 is the first backoff, not the first attempt. */
export function retryQueue(tier: number): string {
  return `reservation.expire.retry.${String(tier)}`;
}

export function retryKey(tier: number): string {
  return `reservation.expire.retry.${String(tier)}`;
}

/**
 * The number of failed handlings so far. Ours, not the broker's: RabbitMQ's
 * `x-death` collapses entries by (queue, reason) and stores a count in each, so
 * reconstructing an attempt number from it means knowing which queues are tiers
 * -- and knowing it again after every topology change (ADR 0026). `x-death` is
 * still forwarded and logged; it is history, not a control variable.
 */
export const ATTEMPT_HEADER = 'x-attempt';

/**
 * An identifier and nothing else. This is the whole idempotency mechanism: a
 * message that carries no facts cannot carry stale ones, so a delivery that
 * arrives after the hold was confirmed, cancelled or already expired is settled
 * by re-reading the row rather than by trusting the body (spec §4).
 */
export const expireMessageSchema = z.object({ reservationId: z.uuid() });

export type ExpireMessage = z.infer<typeof expireMessageSchema>;
```

- [ ] **Step 9: Run it to verify it passes**

Run: `npm test -w @cinema/api -- messages.test`
Expected: PASS, five cases.

- [ ] **Step 10: Document the variables in `.env.example`**

Append to `.env.example`:

```bash
# How a lapsed hold is settled. `lazy` is sub-project 2's behaviour: the next
# caller who wants the seats releases them. `queue` additionally publishes
# reservation.expire, so a worker settles the row without waiting for a caller.
# Lazy expiry stays authoritative in both modes -- the worker is a second path
# to the same result, never the only one.
RESERVATION_EXPIRY_MODE=lazy
# Required only when RESERVATION_EXPIRY_MODE=queue. Deliberately has no default
# in code: a missing URL must stop the process at boot, not surface per request.
RABBITMQ_URL=amqp://guest:guest@localhost:5672
# Unacknowledged messages per consumer channel.
RABBITMQ_PREFETCH=20
# Past this, a slow broker is treated as a dead one: the hold still succeeds and
# the message is dropped with a warning.
RABBITMQ_PUBLISH_TIMEOUT_MS=200
# The retry ladder. One queue per entry, each with that fixed TTL; the number of
# entries is the number of retries before a message is dead-lettered.
RABBITMQ_RETRY_DELAYS_MS=5000,30000,120000
```

- [ ] **Step 11: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test -w @cinema/api -- "(env|messages)\.test"`
Expected: all pass.

```bash
git add apps/api/package.json package-lock.json apps/api/src/config apps/api/src/messaging .env.example
git commit -m "feat(api): add the messaging configuration and the reservation.expire vocabulary"
```

---

## Task 2: The topology, and a broker to assert it against

`assertTopology` is the only function in the codebase permitted to declare a queue. This task writes it and stands up the test broker that every later task uses.

**Files:**

- Create: `apps/api/src/messaging/topology.ts`
- Modify: `apps/api/test/harness.ts`
- Modify: `apps/api/test/global-setup.ts`
- Modify: `apps/api/test/global-teardown.ts`
- Modify: `apps/api/test/setup-after-env.ts`
- Create: `apps/api/test/rabbit-harness.ts`
- Create: `apps/api/test/topology.e2e.spec.ts`

**Interfaces:**

- Consumes: the constants and `retryQueue`/`retryKey` from Task 1.
- Produces: `assertTopology(channel: Channel, options: TopologyOptions): Promise<void>` and `interface TopologyOptions { reservationTtlSeconds: number; retryDelaysMs: number[] }` from `messaging/topology.ts`; `startTestRabbit()` and `getTestRabbitUrl()` from `test/harness.ts`; and from `test/rabbit-harness.ts` the helpers `openInspection(url)`, `deleteTopology(channel, tiers)`, `queueDepth(channel, queue)` and `takeOne(channel, queue, timeoutMs)`.

- [ ] **Step 1: Add the broker container to the test harness**

In `apps/api/test/harness.ts`, extend the global declaration and add the two functions beside the Redis pair:

```ts
declare global {
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
  var __REDIS_CONTAINER__: StartedTestContainer | undefined;
  var __RABBIT_CONTAINER__: StartedTestContainer | undefined;
}

/**
 * The management image, matching the compose stack: the plugin costs a little
 * startup time and buys a UI to look at when a test fails in a way the
 * assertions do not explain. Waiting on the log line rather than the port
 * matters more here than for Redis -- the AMQP listener opens well before the
 * broker will accept a channel, and connecting into that window fails.
 */
export async function startTestRabbit(): Promise<StartedTestContainer> {
  return new GenericContainer('rabbitmq:4-management-alpine')
    .withExposedPorts(5672)
    .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
    .withStartupTimeout(180_000)
    .start();
}

export function getTestRabbitUrl(): string {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL is not set; global setup did not run');
  return url;
}
```

- [ ] **Step 2: Start it in global setup, stop it in teardown, export it to the suites**

In `apps/api/test/global-setup.ts`:

```ts
import { writeFileSync } from 'node:fs';

import { startTestDatabase, startTestRabbit, startTestRedis } from './harness';

export default async function globalSetup(): Promise<void> {
  // Concurrently: three image pulls in series is minutes of CI for no reason.
  const [postgres, redis, rabbit] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
    startTestRabbit(),
  ]);

  globalThis.__PG_CONTAINER__ = postgres;
  globalThis.__REDIS_CONTAINER__ = redis;
  globalThis.__RABBIT_CONTAINER__ = rabbit;

  writeFileSync(`${__dirname}/.database-url`, postgres.getConnectionUri(), 'utf8');
  writeFileSync(
    `${__dirname}/.redis-url`,
    `redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`,
    'utf8',
  );
  writeFileSync(
    `${__dirname}/.rabbit-url`,
    `amqp://guest:guest@${rabbit.getHost()}:${String(rabbit.getMappedPort(5672))}`,
    'utf8',
  );
}
```

In `apps/api/test/global-teardown.ts`:

```ts
export default async function globalTeardown(): Promise<void> {
  await Promise.all([
    globalThis.__PG_CONTAINER__?.stop(),
    globalThis.__REDIS_CONTAINER__?.stop(),
    globalThis.__RABBIT_CONTAINER__?.stop(),
  ]);
}
```

In `apps/api/test/setup-after-env.ts`, add one line after the Redis one:

```ts
process.env.RABBITMQ_URL = readFileSync(`${__dirname}/.rabbit-url`, 'utf8').trim();
```

Check that `apps/api/test/.rabbit-url` is covered by the existing ignore for `.database-url`/`.redis-url`:

```bash
git check-ignore -v apps/api/test/.rabbit-url
```

If it is not ignored, add `apps/api/test/.rabbit-url` to `.gitignore` next to its siblings.

- [ ] **Step 3: Write the failing topology test**

Create `apps/api/test/topology.e2e.spec.ts`:

```ts
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

    await expect(channel.checkQueue(retryQueue(1))).resolves.toMatchObject({ queue: retryQueue(1) });
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
```

- [ ] **Step 4: Write the inspection helpers**

Create `apps/api/test/rabbit-harness.ts`:

```ts
import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';

import {
  COMMANDS_EXCHANGE,
  EXPIRE_DLQ,
  EXPIRE_QUEUE,
  EXPIRE_WAIT_QUEUE,
  retryQueue,
} from '../src/messaging/messages';

/** A plain connection and channel for asserting on what the application wrote. */
export async function openInspection(
  url: string,
): Promise<{ connection: ChannelModel; channel: Channel }> {
  const connection = await connect(url);
  const channel = await connection.createChannel();
  return { connection, channel };
}

/**
 * Queue arguments are part of a queue's identity: re-declaring one with a
 * different `x-message-ttl` is PRECONDITION_FAILED (406) and kills the channel.
 * Suites use different TTLs on purpose -- milliseconds where production uses
 * minutes -- so each one removes the previous suite's queues before declaring
 * its own. In production the same fact is a migration note, not a helper.
 */
export async function deleteTopology(connection: ChannelModel, tiers: number): Promise<void> {
  const queues = [EXPIRE_WAIT_QUEUE, EXPIRE_QUEUE, EXPIRE_DLQ];
  for (let tier = 1; tier <= tiers; tier += 1) queues.push(retryQueue(tier));

  // A disposable channel per deletion. Deleting a queue that is not there can
  // close the channel, and a closed channel would take every following
  // deletion down with it -- which would surface as an unrelated failure in
  // whichever suite happened to run first.
  for (const queue of queues) {
    const channel = await connection.createChannel();
    await channel.deleteQueue(queue).catch(() => {});
    await channel.close().catch(() => {});
  }

  const channel = await connection.createChannel();
  await channel.deleteExchange(COMMANDS_EXCHANGE).catch(() => {});
  await channel.close().catch(() => {});
}

/**
 * `checkQueue`, never `assertQueue`: the wait and retry queues carry an
 * `x-message-ttl` and a dead-letter exchange, so re-declaring them with plain
 * `{ durable: true }` would be PRECONDITION_FAILED (406) and would kill the
 * channel. A passive check reads the depth without touching the declaration.
 */
export async function queueDepth(channel: Channel, queue: string): Promise<number> {
  const { messageCount } = await channel.checkQueue(queue);
  return messageCount;
}

/**
 * Waits for one message on a queue and acks it. Rejects rather than hanging so
 * a failure names the queue that stayed empty instead of timing the suite out.
 */
export async function takeOne(
  channel: Channel,
  queue: string,
  timeoutMs: number,
): Promise<ConsumeMessage> {
  return new Promise<ConsumeMessage>((resolve, reject) => {
    let tag: string | undefined;

    const timer = setTimeout(() => {
      if (tag) void channel.cancel(tag);
      reject(new Error(`no message arrived on ${queue} within ${String(timeoutMs)}ms`));
    }, timeoutMs);

    void channel
      .consume(
        queue,
        (message) => {
          if (!message) return;
          clearTimeout(timer);
          channel.ack(message);
          if (tag) void channel.cancel(tag);
          resolve(message);
        },
        { noAck: false },
      )
      .then((reply) => {
        tag = reply.consumerTag;
      })
      .catch(reject);
  });
}
```

- [ ] **Step 5: Run the topology test to verify it fails**

Run: `npm test -w @cinema/api -- topology.e2e`
Expected: FAIL — `Cannot find module '../src/messaging/topology'`.

- [ ] **Step 6: Write the topology**

Create `apps/api/src/messaging/topology.ts`:

```ts
import type { Channel } from 'amqplib';

import {
  COMMANDS_EXCHANGE,
  EXPIRE_DEAD_KEY,
  EXPIRE_DLQ,
  EXPIRE_KEY,
  EXPIRE_QUEUE,
  EXPIRE_WAIT_KEY,
  EXPIRE_WAIT_QUEUE,
  retryKey,
  retryQueue,
} from './messages';

export interface TopologyOptions {
  /** The length of a hold. The wait queue's TTL is the same number. */
  reservationTtlSeconds: number;
  /** One queue per entry, each with that fixed TTL. */
  retryDelaysMs: number[];
}

/**
 * The only place in the codebase that declares a queue.
 *
 * Re-asserting a queue with different arguments returns PRECONDITION_FAILED
 * (406) and kills the channel, so both the boot path and the reconnect hook
 * must call this and nothing else, with the same options. The practical
 * consequence, recorded in the spec and in ADR 0024: changing
 * RESERVATION_TTL_SECONDS or the retry ladder on a live stack requires deleting
 * and recreating the affected queues.
 */
export async function assertTopology(channel: Channel, options: TopologyOptions): Promise<void> {
  await channel.assertExchange(COMMANDS_EXCHANGE, 'direct', { durable: true });

  // Nothing ever consumes from this one. The broker moves a message on when its
  // TTL lapses, which is what makes the ten-minute delay a property of the
  // broker rather than a timer in our process -- and is why no scheduler exists
  // anywhere in this codebase (ADR 0011, ADR 0024).
  //
  // A queue expires only its head, so this is correct precisely because every
  // hold shares one TTL and publication order is therefore expiry order. If a
  // later sub-project gives holds different lengths, this queue must be
  // replaced rather than reconfigured.
  await channel.assertQueue(EXPIRE_WAIT_QUEUE, {
    durable: true,
    messageTtl: options.reservationTtlSeconds * 1_000,
    deadLetterExchange: COMMANDS_EXCHANGE,
    deadLetterRoutingKey: EXPIRE_KEY,
  });
  await channel.bindQueue(EXPIRE_WAIT_QUEUE, COMMANDS_EXCHANGE, EXPIRE_WAIT_KEY);

  await channel.assertQueue(EXPIRE_QUEUE, { durable: true });
  await channel.bindQueue(EXPIRE_QUEUE, COMMANDS_EXCHANGE, EXPIRE_KEY);

  // One queue per tier rather than per-message TTL in a single queue: the
  // head-of-line rule above would otherwise be violated by our own retries, with
  // a 5s message waiting behind a 120s one (ADR 0025).
  for (const [index, delay] of options.retryDelaysMs.entries()) {
    const tier = index + 1;
    await channel.assertQueue(retryQueue(tier), {
      durable: true,
      messageTtl: delay,
      deadLetterExchange: COMMANDS_EXCHANGE,
      deadLetterRoutingKey: EXPIRE_KEY,
    });
    await channel.bindQueue(retryQueue(tier), COMMANDS_EXCHANGE, retryKey(tier));
  }

  // Terminal: no TTL and no dead-letter exchange, so a message that reaches it
  // stays until a human looks at it.
  await channel.assertQueue(EXPIRE_DLQ, { durable: true });
  await channel.bindQueue(EXPIRE_DLQ, COMMANDS_EXCHANGE, EXPIRE_DEAD_KEY);
}
```

- [ ] **Step 7: Run the topology test to verify it passes**

Run: `npm test -w @cinema/api -- topology.e2e`
Expected: PASS, four cases. The last one takes about a second of real TTL.

- [ ] **Step 8: Verify and commit**

Run: `npm run lint && npm run typecheck`
Expected: pass.

```bash
git add apps/api/src/messaging apps/api/test .gitignore
git commit -m "feat(api): declare the reservation.expire topology and add the test broker"
```

---

## Task 3: The connection

A recovering connection that exists only in `queue` mode, mirroring `RedisModule` exactly: a symbol token, a factory that returns `null` when the subsystem is off, and a shutdown hook.

**Files:**

- Create: `apps/api/src/messaging/rabbit.module.ts`

**Interfaces:**

- Consumes: `assertTopology`, `TopologyOptions` from Task 2; `ConfigService`.
- Produces: `RABBIT` (symbol token) and `type RabbitConnection = RecoveringChannelModel | null` from `messaging/rabbit.module.ts`, plus the exported factory `createRabbitConnection(url, options, onEvent)` the test harness reuses, and the class `RabbitModule`.

- [ ] **Step 1: Write the module**

Create `apps/api/src/messaging/rabbit.module.ts`:

```ts
import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { connect, type RecoveringChannelModel } from 'amqplib';

import { ConfigService } from '../config/config.service';
import { assertTopology, type TopologyOptions } from './topology';

export const RABBIT = Symbol('RABBIT');

/** `null` whenever RESERVATION_EXPIRY_MODE is `lazy`. Every consumer checks. */
export type RabbitConnection = RecoveringChannelModel | null;

/**
 * Recovery is a library feature as of amqplib 1.1.0, which is why this project
 * does not carry `amqp-connection-manager`. The `setup` hook runs after every
 * successful connection, including the first, and is the one place topology is
 * asserted -- with identical options each time, because different arguments
 * would be PRECONDITION_FAILED (ADR 0031).
 */
export async function createRabbitConnection(
  url: string,
  options: TopologyOptions,
  onEvent: (message: string) => void,
): Promise<RecoveringChannelModel> {
  // A plain connect first, purely as a reachability probe.
  //
  // This is not belt-and-braces. Verified against amqplib 2.0.1: `connect()`
  // WITH a recovery block never rejects on an unreachable broker -- it retries
  // for as long as `maxRetries` allows, and that defaults to Infinity, so
  // awaiting it would hang boot forever against a dead broker. Without recovery
  // it rejects in about two milliseconds. `maxRetries` does bound the initial
  // attempt (0 rejects at 2ms, 2 at 154ms), but any budget small enough to keep
  // boot fast is far too small to survive a real broker restart at runtime, and
  // one option set governs both. So: probe without recovery to decide whether
  // the broker is there, then open the connection that actually gets used with
  // an unbounded recovery budget.
  const probe = await connect(url);
  await probe.close();

  const connection = await connect(url, {
    // `heartbeat` is deliberately not passed. In amqplib 2.0.0 a zero disables
    // heartbeats outright rather than deferring to the server, so the way to
    // take the server's value is to omit the option.
    recovery: {
      initialDelay: 100,
      maxDelay: 5_000,
      factor: 2,
      jitter: 0.2,
      setup: async (model) => {
        const channel = await model.createChannel();
        await assertTopology(channel, options);
        await channel.close();
      },
    },
  });

  connection.on('disconnect', (error: Error) => onEvent(`broker disconnected: ${error.message}`));
  connection.on('reconnect-scheduled', (info: { attempt: number; delay: number }) =>
    onEvent(`reconnect attempt ${String(info.attempt)} in ${String(info.delay)}ms`),
  );
  connection.on('connect-failed', (error: Error) => onEvent(`reconnect failed: ${error.message}`));
  // An EventEmitter 'error' with no listener aborts the process -- the same trap
  // the pg pool and the ioredis client each have. A broker we can live without
  // must never take the process down.
  connection.on('error', (error: Error) => onEvent(`broker error: ${error.message}`));

  return connection;
}

@Global()
@Module({
  providers: [
    {
      provide: RABBIT,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService): Promise<RabbitConnection> => {
        const { reservationExpiryMode, rabbitmqUrl, reservationTtlSeconds, rabbitmqRetryDelaysMs } =
          configService.config;
        // Mode `lazy` opens no connection at all, declares no queue and logs
        // nothing. A client nobody uses would still reconnect and still log,
        // and would make phase 3's baseline run differ from phase 3 (ADR 0017).
        if (reservationExpiryMode !== 'queue' || !rabbitmqUrl) return null;

        const logger = new Logger(RabbitModule.name);
        try {
          return await createRabbitConnection(
            rabbitmqUrl,
            { reservationTtlSeconds, retryDelaysMs: rabbitmqRetryDelaysMs },
            (message) => logger.warn(message),
          );
        } catch (error) {
          // A broker that is down at boot must not stop the process: holds are
          // fully correct without it, and lazy expiry still settles them.
          logger.warn(`broker unreachable at startup, running without it: ${String(error)}`);
          return null;
        }
      },
    },
  ],
  exports: [RABBIT],
})
export class RabbitModule implements OnApplicationShutdown {
  constructor(@Inject(RABBIT) private readonly connection: RabbitConnection) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.connection) return;
    // close() also stops the recovery loop; without it a shutting-down process
    // keeps trying to reconnect to a broker it no longer needs.
    await this.connection.close().catch(() => {});
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck -w @cinema/api`
Expected: pass. If `connect` is reported as having no call signature accepting `recovery`, the installed amqplib is older than 1.1.0 — check `npm ls amqplib`.

- [ ] **Step 3: Verify a dead broker returns null instead of hanging**

This is the whole point of the probe, so prove it rather than assuming it. From the repo root:

```bash
cat > /tmp/rabbit-probe.js <<'JS'
const { createRabbitConnection } = require('./apps/api/dist/messaging/rabbit.module');
const started = Date.now();
const timer = setTimeout(() => {
  console.log('FAIL: still pending after 5s — boot would hang');
  process.exit(1);
}, 5_000);
createRabbitConnection('amqp://guest:guest@127.0.0.1:1', { reservationTtlSeconds: 600, retryDelaysMs: [1000] }, () => {})
  .then(() => { clearTimeout(timer); console.log('FAIL: resolved against a closed port'); process.exit(1); })
  .catch((error) => {
    clearTimeout(timer);
    console.log(`PASS: rejected in ${Date.now() - started}ms with ${error.code || error.message}`);
    process.exit(0);
  });
JS
npm run build -w @cinema/api && node /tmp/rabbit-probe.js
```

Expected: `PASS: rejected in <100ms with ECONNREFUSED`. A hang here means the probe was dropped or reordered after the recovering connect, and Task 4's fail-open suite would hang too.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/messaging/rabbit.module.ts
git commit -m "feat(api): add the recovering rabbitmq connection that reasserts topology"
```

---

## Task 4: The publisher, and the one line in `create()`

**Files:**

- Create: `apps/api/src/messaging/expire.publisher.ts`
- Create: `apps/api/src/messaging/messaging.module.ts`
- Modify: `apps/api/src/reservations/reservation.service.ts`
- Modify: `apps/api/src/reservations/reservation.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/test/reservation-harness.ts`
- Create: `apps/api/test/expire-publisher.e2e.spec.ts`

**Interfaces:**

- Consumes: `RABBIT`, `RabbitConnection` (Task 3); `COMMANDS_EXCHANGE`, `EXPIRE_WAIT_KEY`, `ATTEMPT_HEADER` (Task 1); `currentRequestId` from `observability/request-context`.
- Produces: class `ExpirePublisher` with `publishExpire(reservationId: string): Promise<void>` and `get failureCount(): number`; `MessagingModule` exporting `ExpirePublisher`; and on the harness, `HarnessOptions.expiryMode?: 'lazy' | 'queue'`, `HarnessOptions.rabbitmqUrl?: string`, `ReservationHarness.publisher: ExpirePublisher`.

- [ ] **Step 1: Write the failing publisher test**

Create `apps/api/test/expire-publisher.e2e.spec.ts`:

```ts
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
```

- [ ] **Step 2: Teach the harness the new options**

In `apps/api/test/reservation-harness.ts`, add to `HarnessOptions`:

```ts
  /** Which expiry path the application under test uses. */
  expiryMode?: 'lazy' | 'queue';
  /** Overrides RABBITMQ_URL. Pointing it at a closed port is how fail open is proved. */
  rabbitmqUrl?: string;
  /**
   * Overrides the retry ladder. Queue arguments are part of a queue's identity,
   * so a suite that runs this harness beside a worker harness MUST give both the
   * same ladder -- otherwise the second one to declare the retry queues gets
   * PRECONDITION_FAILED (406) and loses its channel.
   */
  retryDelaysMs?: number[];
```

Add to the `overrides` record, beside the existing entries:

```ts
    RESERVATION_EXPIRY_MODE: options.expiryMode,
    RABBITMQ_URL: options.rabbitmqUrl,
    RABBITMQ_RETRY_DELAYS_MS: options.retryDelaysMs?.join(','),
```

Add to `ReservationHarness`:

```ts
  /** The publisher the application bound, for reading its fail-open counter. */
  publisher: ExpirePublisher;
```

and to the returned object:

```ts
    publisher: app.get(ExpirePublisher),
```

with `import { ExpirePublisher } from '../src/messaging/expire.publisher';` at the top.

- [ ] **Step 3: Run the publisher test to verify it fails**

Run: `npm test -w @cinema/api -- expire-publisher`
Expected: FAIL — `Cannot find module '../src/messaging/expire.publisher'`.

- [ ] **Step 4: Write the publisher**

Create `apps/api/src/messaging/expire.publisher.ts`:

```ts
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfirmChannel } from 'amqplib';

import { ConfigService } from '../config/config.service';
import { currentRequestId } from '../observability/request-context';
import { ATTEMPT_HEADER, COMMANDS_EXCHANGE, EXPIRE_WAIT_KEY } from './messages';
import { RABBIT, type RabbitConnection } from './rabbit.module';

@Injectable()
export class ExpirePublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExpirePublisher.name);
  private channel: ConfirmChannel | null = null;
  /**
   * Failed publications since boot. Section 22 will scrape this; today it is
   * what the degradation test asserts on and what a log line quotes, so a reader
   * can tell one bad second from a broker that has been down all afternoon.
   */
  private failures = 0;

  constructor(
    @Inject(RABBIT) private readonly connection: RabbitConnection,
    private readonly configService: ConfigService,
  ) {}

  get failureCount(): number {
    return this.failures;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.connection) return;
    // A channel does not survive its connection, so it is reopened on every
    // successful (re)connection rather than held for the life of the process.
    this.connection.on('connect', () => void this.open());
    await this.open();
  }

  async onApplicationShutdown(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    if (channel) await channel.close().catch(() => {});
  }

  private async open(): Promise<void> {
    if (!this.connection) return;
    try {
      const channel = await this.connection.createConfirmChannel();
      // `mandatory` publishes come back here when nothing was bound to route
      // them. Silence would otherwise be the only symptom of a broken binding.
      channel.on('return', (message) =>
        this.warn(`message returned unroutable: ${String(message.properties.messageId)}`),
      );
      channel.on('error', (error: Error) => this.warn(`publish channel error: ${error.message}`));
      this.channel = channel;
    } catch (error) {
      this.warn(`could not open a publish channel: ${String(error)}`);
    }
  }

  /**
   * Called at the very end of a successful hold, after the commit and after the
   * seat locks settle. Never throws: the seats are already held and the row is
   * already committed, so a broker problem must cost a warning and nothing else.
   * Lazy expiry (ADR 0011) is what makes that affordable -- it, not this
   * message, is what guarantees the seat comes back.
   */
  async publishExpire(reservationId: string): Promise<void> {
    const channel = this.channel;
    if (!channel) return;

    const body = Buffer.from(JSON.stringify({ reservationId }), 'utf8');
    const options = {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId: reservationId,
      correlationId: currentRequestId(),
      timestamp: Date.now(),
      headers: { [ATTEMPT_HEADER]: 0 },
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('publish confirmation timed out')),
          this.configService.config.rabbitmqPublishTimeoutMs,
        );

        channel.publish(COMMANDS_EXCHANGE, EXPIRE_WAIT_KEY, body, options, (error) => {
          clearTimeout(timer);
          if (error) reject(error instanceof Error ? error : new Error(String(error)));
          else resolve();
        });
      });
    } catch (error) {
      this.warn(`publishing reservation.expire for ${reservationId} failed: ${String(error)}`);
    }
  }

  private warn(message: string): void {
    this.failures += 1;
    this.logger.warn(`${message} (${String(this.failures)} since boot); lazy expiry still applies`);
  }
}
```

- [ ] **Step 5: Wire the module**

Create `apps/api/src/messaging/messaging.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { ExpirePublisher } from './expire.publisher';
import { RabbitModule } from './rabbit.module';

@Module({
  imports: [RabbitModule],
  providers: [ExpirePublisher],
  exports: [ExpirePublisher],
})
export class MessagingModule {}
```

In `apps/api/src/reservations/reservation.module.ts`, add `MessagingModule` to `imports` and export the service so the worker can reuse it:

```ts
import { MessagingModule } from '../messaging/messaging.module';
// ...
@Module({
  imports: [CatalogModule, LockingModule, MessagingModule],
  controllers: [ReservationController],
  providers: [ReservationService],
  exports: [ReservationService],
})
export class ReservationModule {}
```

In `apps/api/src/app.module.ts`, add `MessagingModule` to the `imports` array (alphabetically, after `LockingModule`) and the matching import line.

- [ ] **Step 6: Publish from `create()`**

In `apps/api/src/reservations/reservation.service.ts`, inject the publisher — as a **value** import, not `import type`, because Nest resolves constructor dependencies from `design:paramtypes` and a type-only import is elided:

```ts
import { ExpirePublisher } from '../messaging/expire.publisher';
```

Add the parameter to the constructor, after `geometry`:

```ts
    private readonly expiry: ExpirePublisher,
```

Then at the end of `create()`, replace:

```ts
    await this.releaseLocks(outcome.released);
    return outcome.reservation;
```

with:

```ts
    await this.releaseLocks(outcome.released);

    // After the commit and after the locks settle, and never inside the
    // transaction: a transaction can roll back, a published message cannot be
    // un-published. A failure here is a warning, not an error -- the hold is
    // already the caller's, and lazy expiry will settle it either way.
    await this.expiry.publishExpire(outcome.reservation.id);
    return outcome.reservation;
```

- [ ] **Step 7: Run the publisher test to verify it passes**

Run: `npm test -w @cinema/api -- expire-publisher`
Expected: PASS, five cases.

- [ ] **Step 8: Prove nothing regressed**

Run: `npm test -w @cinema/api`
Expected: every existing suite still passes. They run without `RESERVATION_EXPIRY_MODE`, so the mode is `lazy`, no connection is opened and `publishExpire` returns immediately.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): publish reservation.expire after the hold commits, failing open"
```

---

## Task 5: `settleExpired`

The handler's whole decision table, at the service level, where it can be tested without a broker.

**Files:**

- Modify: `apps/api/src/reservations/reservation.service.ts`
- Create: `apps/api/test/settle-expired.e2e.spec.ts`

**Interfaces:**

- Consumes: the private `expire`, `releaseLocks` and `releaseSeatsOf` already on `ReservationService`.
- Produces: `ReservationService.settleExpired(reservationId: string): Promise<SettleOutcome>` where `export type SettleOutcome = 'expired' | 'not-found' | 'terminal' | 'not-due'`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/settle-expired.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { seatKey } from '../src/locking/seat-lock';
import { ReservationService } from '../src/reservations/reservation.service';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('settleExpired', () => {
  let h: ReservationHarness;
  let service: ReservationService;

  beforeAll(async () => {
    h = await startReservationHarness({ lockStrategy: 'redis', ttlSeconds: 1 });
    service = h.app.get(ReservationService);
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await truncateReservations(h.db, h.redis);
  });

  const activeSeats = async (reservationId: string): Promise<number> => {
    const rows = await h.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM reservation_seats
      WHERE reservation_id = ${reservationId} AND released_at IS NULL
    `);
    return Number(rows.rows[0]!.count);
  };

  it('expires a pending hold whose time has passed and frees its seats', async () => {
    const reservation = await h.holdOne(h.seatIds[0]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    await expect(service.settleExpired(reservation.id)).resolves.toBe('expired');

    const [row] = await h.db.execute<{ status: string }>(
      sql`SELECT status FROM reservations WHERE id = ${reservation.id}`,
    ).then((result) => result.rows);
    expect(row!.status).toBe('EXPIRED');
    await expect(activeSeats(reservation.id)).resolves.toBe(0);
  });

  it('drops the seat lock so the next caller does not pay a wasted transaction', async () => {
    const reservation = await h.holdOne(h.seatIds[1]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    await service.settleExpired(reservation.id);

    await expect(h.redis!.exists(seatKey(h.showtimeId, h.seatIds[1]!))).resolves.toBe(0);
  });

  it('does nothing for a reservation that does not exist', async () => {
    // A message can outlive its row: TRUNCATE in a test, a purge in production.
    await expect(service.settleExpired(randomUUID())).resolves.toBe('not-found');
  });

  it('does nothing for a confirmed reservation', async () => {
    const session = randomUUID();
    const reservation = await h.holdOne(h.seatIds[2]!, session);
    await h.act('POST', `/${reservation.id}/confirm`, session);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // The message for this hold is already in flight when the user confirms.
    // It must find a terminal row and stop -- this is the single most important
    // case in the sub-project, because getting it wrong un-sells a sold seat.
    await expect(service.settleExpired(reservation.id)).resolves.toBe('terminal');
    await expect(activeSeats(reservation.id)).resolves.toBe(1);
  });

  it('does nothing for a cancelled reservation', async () => {
    const session = randomUUID();
    const reservation = await h.holdOne(h.seatIds[3]!, session);
    await h.act('DELETE', `/${reservation.id}`, session);

    await expect(service.settleExpired(reservation.id)).resolves.toBe('terminal');
  });

  it('does nothing for a hold that is not due yet', async () => {
    const longer = await startReservationHarness({ ttlSeconds: 600 });
    try {
      const reservation = await longer.holdOne(longer.seatIds[4]!);
      // The broker's TTL and the database's expires_at are two different
      // clocks, so an early delivery is legal and must be a no-op, not an error.
      await expect(
        longer.app.get(ReservationService).settleExpired(reservation.id),
      ).resolves.toBe('not-due');
    } finally {
      await longer.close();
    }
  });

  it('is idempotent: settling twice expires once', async () => {
    const reservation = await h.holdOne(h.seatIds[5]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    await expect(service.settleExpired(reservation.id)).resolves.toBe('expired');
    // The second delivery of an at-least-once message. Structural idempotence:
    // the first call made the row terminal, so the second finds nothing to do.
    await expect(service.settleExpired(reservation.id)).resolves.toBe('terminal');
    await expect(activeSeats(reservation.id)).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @cinema/api -- settle-expired`
Expected: FAIL — `service.settleExpired is not a function`.

- [ ] **Step 3: Implement `settleExpired`**

In `apps/api/src/reservations/reservation.service.ts`, add the exported type near the top, after the `ReleasedSeat` interface:

```ts
/** What a delivered reservation.expire message turned out to mean. */
export type SettleOutcome = 'expired' | 'not-found' | 'terminal' | 'not-due';
```

Add the method after `cancel`:

```ts
  /**
   * The worker's entire job. Idempotent by construction: the terminal check
   * below is what makes at-least-once delivery safe without a dedupe table --
   * a second delivery finds a row that is no longer PENDING and does nothing.
   *
   * `lockOwned` is not reused because it filters by session, and the worker acts
   * for the system rather than for a caller. The row lock is the same one.
   */
  async settleExpired(reservationId: string): Promise<SettleOutcome> {
    const outcome = await this.db.transaction(
      async (tx): Promise<{ result: SettleOutcome; released: ReleasedSeat[] }> => {
        const [row] = await tx
          .select({
            status: reservations.status,
            // The database's clock, never the broker's: the TTL that delivered
            // this message was measured somewhere else entirely.
            due: sql<boolean>`${reservations.expiresAt} <= now()`,
          })
          .from(reservations)
          .where(eq(reservations.id, reservationId))
          .limit(1)
          .for('update');

        if (!row) return { result: 'not-found', released: [] };
        if (row.status !== 'PENDING') return { result: 'terminal', released: [] };
        if (!row.due) return { result: 'not-due', released: [] };

        return { result: 'expired', released: await this.expire(tx, reservationId) };
      },
    );

    // After the commit, like every other release in this service.
    await this.releaseLocks(outcome.released);
    return outcome.result;
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w @cinema/api -- settle-expired`
Expected: PASS, seven cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/reservations/reservation.service.ts apps/api/test/settle-expired.e2e.spec.ts
git commit -m "feat(api): settle an expired hold idempotently from a reservation id alone"
```

---

## Task 6: The retry ladder

Pure functions, no broker, no database. Written separately because the ladder's arithmetic is exactly the kind of thing that is wrong by one and invisible for months.

**Files:**

- Create: `apps/api/src/messaging/retry.ts`
- Create: `apps/api/src/messaging/retry.test.ts`

**Interfaces:**

- Consumes: `ATTEMPT_HEADER`, `EXPIRE_DEAD_KEY`, `retryKey` from Task 1.
- Produces: `nextHop(attempt: number, retryDelaysMs: number[]): NextHop` with `interface NextHop { routingKey: string; attempt: number; dead: boolean }`, and `attemptOf(headers: Record<string, unknown> | undefined): number`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/messaging/retry.test.ts`:

```ts
import { attemptOf, nextHop } from './retry';

const ladder = [5_000, 30_000, 120_000];

describe('nextHop', () => {
  it('sends a first failure to the first tier', () => {
    // x-attempt counts failures so far, so a message the producer published
    // (attempt 0) that has now failed once goes to tier 1 carrying 1.
    expect(nextHop(0, ladder)).toEqual({
      routingKey: 'reservation.expire.retry.1',
      attempt: 1,
      dead: false,
    });
  });

  it('walks the ladder one tier at a time', () => {
    expect(nextHop(1, ladder).routingKey).toBe('reservation.expire.retry.2');
    expect(nextHop(2, ladder).routingKey).toBe('reservation.expire.retry.3');
  });

  it('dead-letters once the tiers are exhausted', () => {
    // Three tiers means the handler runs at most four times: the original
    // delivery plus one per tier.
    expect(nextHop(3, ladder)).toEqual({
      routingKey: 'reservation.expire.dead',
      attempt: 4,
      dead: true,
    });
  });

  it('dead-letters immediately when the ladder has one rung', () => {
    expect(nextHop(1, [100]).dead).toBe(true);
  });
});

describe('attemptOf', () => {
  it('reads the header', () => {
    expect(attemptOf({ 'x-attempt': 2 })).toBe(2);
  });

  it('treats a missing header as a first delivery', () => {
    // A message published by hand, or by an older build, must not crash the
    // consumer -- it starts at the beginning of the ladder.
    expect(attemptOf(undefined)).toBe(0);
    expect(attemptOf({})).toBe(0);
  });

  it('ignores a header that is not a whole non-negative number', () => {
    expect(attemptOf({ 'x-attempt': 'two' })).toBe(0);
    expect(attemptOf({ 'x-attempt': -1 })).toBe(0);
    expect(attemptOf({ 'x-attempt': 1.5 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @cinema/api -- retry.test`
Expected: FAIL — `Cannot find module './retry'`.

- [ ] **Step 3: Write the ladder**

Create `apps/api/src/messaging/retry.ts`:

```ts
import { ATTEMPT_HEADER, EXPIRE_DEAD_KEY, retryKey } from './messages';

export interface NextHop {
  /** Where to republish. */
  routingKey: string;
  /** The value to stamp into `x-attempt` on the republished message. */
  attempt: number;
  /** True when the tiers are exhausted and this hop is the dead-letter queue. */
  dead: boolean;
}

/**
 * `x-attempt` is the number of failed handlings *so far*: the producer publishes
 * 0, and a handler that fails on n republishes with n + 1 into tier n + 1. With
 * three tiers the handler runs at most four times (spec §3).
 */
export function nextHop(attempt: number, retryDelaysMs: number[]): NextHop {
  const next = attempt + 1;

  if (next > retryDelaysMs.length) {
    return { routingKey: EXPIRE_DEAD_KEY, attempt: next, dead: true };
  }
  return { routingKey: retryKey(next), attempt: next, dead: false };
}

/**
 * Tolerates a message published without the header, or with a nonsense value:
 * such a message starts at the beginning of the ladder rather than crashing the
 * consumer that received it.
 */
export function attemptOf(headers: Record<string, unknown> | undefined): number {
  const raw = headers?.[ATTEMPT_HEADER];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w @cinema/api -- retry.test`
Expected: PASS, seven cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/messaging/retry.ts apps/api/src/messaging/retry.test.ts
git commit -m "feat(api): add the retry ladder that ends in the dead-letter queue"
```

---
## Task 7: The consumer and the worker process

**Files:**

- Create: `apps/api/src/worker/expire.consumer.ts`
- Create: `apps/api/src/worker/worker.module.ts`
- Create: `apps/api/src/worker/main.ts`
- Modify: `apps/api/test/rabbit-harness.ts`
- Create: `apps/api/test/expire-consumer.e2e.spec.ts`

**Interfaces:**

- Consumes: `RABBIT`/`RabbitConnection` (Task 3), `ReservationService.settleExpired` (Task 5), `nextHop`/`attemptOf` (Task 6), `assertTopology` (Task 2), the vocabulary (Task 1).
- Produces: class `ExpireConsumer` with `subscribe(): Promise<void>` and `get handledCount(): number`; `WorkerModule`; and from `test/rabbit-harness.ts` the function `startWorkerHarness(options?: WorkerHarnessOptions): Promise<WorkerHarness>`.

- [ ] **Step 1: Write the failing consumer test**

Create `apps/api/test/expire-consumer.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import type { Channel, ChannelModel } from 'amqplib';
import { sql } from 'drizzle-orm';

import { COMMANDS_EXCHANGE, EXPIRE_KEY, EXPIRE_QUEUE } from '../src/messaging/messages';
import { getTestRabbitUrl } from './harness';
import { deleteTopology, openInspection, queueDepth, startWorkerHarness, type WorkerHarness } from './rabbit-harness';
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

/** Polls a condition rather than sleeping a fixed time, so the suite is not paced by its slowest machine. */
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
```

- [ ] **Step 2: Add the worker harness**

Append to `apps/api/test/rabbit-harness.ts`:

```ts
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../src/db/drizzle.module';
import { schema } from '../src/db/schema';
import { ReservationService, type SettleOutcome } from '../src/reservations/reservation.service';
import { ExpireConsumer } from '../src/worker/expire.consumer';
import { WorkerModule } from '../src/worker/worker.module';
import { getTestDatabaseUrl } from './harness';

export interface WorkerHarnessOptions {
  ttlSeconds?: number;
  retryDelaysMs?: number[];
  prefetch?: number;
  /**
   * Replaces settleExpired. Supplying one that rejects is how the retry ladder
   * is tested without inventing a database failure.
   */
  settle?: (reservationId: string) => Promise<SettleOutcome>;
  /** Defaults to `queue`; the lazy-mode suite passes `lazy`. */
  expiryMode?: 'lazy' | 'queue';
}

export interface WorkerHarness {
  context: INestApplicationContext;
  consumer: ExpireConsumer;
  db: Database;
  close(): Promise<void>;
}

export async function startWorkerHarness(
  options: WorkerHarnessOptions = {},
): Promise<WorkerHarness> {
  // Patched before the module compiles, because ConfigService parses the
  // environment in a field initialiser -- the same constraint the reservation
  // harness works around, and the same restore-rather-than-delete on close.
  const overrides: Record<string, string | undefined> = {
    RESERVATION_EXPIRY_MODE: options.expiryMode ?? 'queue',
    RESERVATION_TTL_SECONDS:
      options.ttlSeconds === undefined ? undefined : String(options.ttlSeconds),
    RABBITMQ_PREFETCH: options.prefetch === undefined ? undefined : String(options.prefetch),
    RABBITMQ_RETRY_DELAYS_MS: options.retryDelaysMs?.join(','),
  };
  const restore = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }

  const builder = Test.createTestingModule({ imports: [WorkerModule] });
  if (options.settle) {
    builder.overrideProvider(ReservationService).useValue({ settleExpired: options.settle });
  }

  const context = await builder.compile();
  // init() runs onApplicationBootstrap, which is where the consumer subscribes.
  await context.init();

  const pool = new Pool({ connectionString: getTestDatabaseUrl() });
  pool.on('error', () => {});

  return {
    context,
    consumer: context.get(ExpireConsumer),
    db: drizzle(pool, { schema }) as Database,
    close: async () => {
      // close() runs onApplicationShutdown, so this also exercises the drain.
      await context.close();
      await pool.end();
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
```

- [ ] **Step 3: Run the consumer test to verify it fails**

Run: `npm test -w @cinema/api -- expire-consumer`
Expected: FAIL — `Cannot find module '../src/worker/worker.module'`.

- [ ] **Step 4: Write the consumer**

Create `apps/api/src/worker/expire.consumer.ts`:

```ts
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';

import { ConfigService } from '../config/config.service';
import {
  ATTEMPT_HEADER,
  COMMANDS_EXCHANGE,
  EXPIRE_DEAD_KEY,
  EXPIRE_QUEUE,
  expireMessageSchema,
} from '../messaging/messages';
import { RABBIT, type RabbitConnection } from '../messaging/rabbit.module';
import { attemptOf, nextHop } from '../messaging/retry';
import { assertTopology } from '../messaging/topology';
import { ReservationService } from '../reservations/reservation.service';

@Injectable()
export class ExpireConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExpireConsumer.name);
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private inFlight = 0;
  private handled = 0;

  constructor(
    @Inject(RABBIT) private readonly connection: RabbitConnection,
    private readonly reservations: ReservationService,
    private readonly configService: ConfigService,
  ) {}

  /** Messages taken to a conclusion since boot, whatever that conclusion was. */
  get handledCount(): number {
    return this.handled;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.connection) return;
    // A channel dies with its connection, so the subscription is re-established
    // on every successful reconnection, not held for the life of the process.
    this.connection.on('connect', () => void this.subscribe());
    await this.subscribe();
  }

  async subscribe(): Promise<void> {
    if (!this.connection) return;

    const previous = this.channel;
    this.channel = null;
    if (previous) await previous.close().catch(() => {});

    const { reservationTtlSeconds, rabbitmqRetryDelaysMs, rabbitmqPrefetch } =
      this.configService.config;

    try {
      const channel = await this.connection.createChannel();
      // Idempotent, and asserted here as well as in the connection's setup hook:
      // whichever runs first, both see identical arguments (spec §3).
      await assertTopology(channel, {
        reservationTtlSeconds,
        retryDelaysMs: rabbitmqRetryDelaysMs,
      });
      await channel.prefetch(rabbitmqPrefetch);
      channel.on('error', (error: Error) => this.logger.warn(`consumer channel: ${error.message}`));

      const reply = await channel.consume(EXPIRE_QUEUE, (message) => {
        if (message) void this.handle(channel, message);
      });

      this.channel = channel;
      this.consumerTag = reply.consumerTag;
      this.logger.log(`consuming ${EXPIRE_QUEUE} with prefetch ${String(rabbitmqPrefetch)}`);
    } catch (error) {
      // Recovery will fire 'connect' again and bring us back through here.
      this.logger.warn(`could not subscribe: ${String(error)}`);
    }
  }

  private async handle(channel: Channel, message: ConsumeMessage): Promise<void> {
    this.inFlight += 1;
    try {
      const parsed = this.parse(message);
      if (!parsed) {
        // A body that does not parse will not parse in thirty seconds either, so
        // retrying it only delays the diagnosis. Straight to the DLQ, with its
        // original bytes and headers intact for whoever reads it (spec §5).
        this.forward(channel, message, EXPIRE_DEAD_KEY, attemptOf(message.properties.headers));
        channel.ack(message);
        return;
      }

      try {
        const outcome = await this.reservations.settleExpired(parsed);
        this.logger.log(`reservation.expire ${parsed}: ${outcome}`);
        channel.ack(message);
      } catch (error) {
        const attempt = attemptOf(message.properties.headers);
        const hop = nextHop(attempt, this.configService.config.rabbitmqRetryDelaysMs);

        this.logger.warn(
          hop.dead
            ? `reservation.expire ${parsed} failed ${String(hop.attempt)} times, dead-lettering: ${String(error)}`
            : `reservation.expire ${parsed} failed, retrying as attempt ${String(hop.attempt)}: ${String(error)}`,
        );

        // Publish first, ack second. The reverse order loses the message if the
        // process dies between the two; this order can deliver it twice
        // instead, and a duplicate is absorbed by settleExpired's terminal
        // check. Losing is worse than repeating (spec §5).
        this.forward(channel, message, hop.routingKey, hop.attempt);
        channel.ack(message);
      }
    } finally {
      this.handled += 1;
      this.inFlight -= 1;
    }
  }

  private parse(message: ConsumeMessage): string | null {
    try {
      const body: unknown = JSON.parse(message.content.toString('utf8'));
      return expireMessageSchema.parse(body).reservationId;
    } catch (error) {
      this.logger.error(`unparseable reservation.expire message: ${String(error)}`);
      return null;
    }
  }

  /** Republishes the original bytes, carrying `x-death` forward for forensics. */
  private forward(
    channel: Channel,
    message: ConsumeMessage,
    routingKey: string,
    attempt: number,
  ): void {
    channel.publish(COMMANDS_EXCHANGE, routingKey, message.content, {
      persistent: true,
      contentType: message.properties.contentType ?? 'application/json',
      messageId: message.properties.messageId,
      correlationId: message.properties.correlationId,
      headers: { ...message.properties.headers, [ATTEMPT_HEADER]: attempt },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    this.channel = null;

    // Cancelling stops new deliveries; it does not wait for the ones already
    // running. Closing the channel under a running handler would leave its
    // message unacked, which is safe -- the broker redelivers it -- but noisy.
    if (this.consumerTag) await channel.cancel(this.consumerTag).catch(() => {});
    while (this.inFlight > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await channel.close().catch(() => {});
  }
}
```

Note on the drain loop: this is the one `setTimeout` the plan introduces. It is a bounded wait for work already in progress, not a schedule — ADR 0011's ban is on polling for work that may not exist, and nothing here polls the database.

- [ ] **Step 5: Write the worker module and entry point**

Create `apps/api/src/worker/worker.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ConfigModule } from '../config/config.module';
import { DrizzleModule } from '../db/drizzle.module';
import { LockingModule } from '../locking/locking.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ReservationModule } from '../reservations/reservation.module';
import { ExpireConsumer } from './expire.consumer';

/**
 * The worker's whole graph. No controllers and no HTTP adapter: an application
 * context, not an application. It reuses ReservationService by plain import
 * rather than by extracting a package, which is why this sub-project adds no
 * build and no second Dockerfile (ADR 0028).
 */
@Module({
  imports: [
    ConfigModule,
    DrizzleModule,
    CatalogModule,
    LockingModule,
    MessagingModule,
    ReservationModule,
  ],
  providers: [ExpireConsumer],
})
export class WorkerModule {}
```

Create `apps/api/src/worker/main.ts`:

```ts
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { parseEnv } from '../config/env';
import { PinoLoggerService, createLogger } from '../observability/logger';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const config = parseEnv(process.env);
  const logger = createLogger(config);

  if (config.reservationExpiryMode !== 'queue') {
    // Exits cleanly rather than idling. The compose service stays declared so
    // the mode is one environment variable rather than an edit to the stack,
    // but a worker with nothing to consume should not hold a database pool
    // open or make an idle process look like a working one (spec §5).
    logger.info('RESERVATION_EXPIRY_MODE is lazy; the expiry worker has nothing to do');
    return;
  }

  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(new PinoLoggerService(logger));
  app.enableShutdownHooks();

  logger.info({ prefetch: config.rabbitmqPrefetch }, 'expiry worker started');
}

void bootstrap();
```

- [ ] **Step 6: Run the consumer test to verify it passes**

Run: `npm test -w @cinema/api -- expire-consumer`
Expected: PASS, five cases.

- [ ] **Step 7: Verify the worker exits on `lazy` and consumes on `queue`**

```bash
npm run build -w @cinema/api
RESERVATION_EXPIRY_MODE=lazy DATABASE_URL=postgres://cinema:cinema@localhost:5432/cinema \
  node apps/api/dist/worker/main.js
```

Expected: one log line naming `lazy`, then exit 0 (`echo $?` prints 0), within a second.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/worker apps/api/test
git commit -m "feat(api): consume reservation.expire in a worker process with prefetch and ack"
```

---

## Task 8: The failures — the ladder, the DLQ, the broker

The deliverable of the sub-project. Every case here is a failure someone else's system discovers in production.

**Files:**

- Modify: `apps/api/test/harness.ts`
- Modify: `apps/api/test/global-setup.ts`
- Modify: `apps/api/test/setup-after-env.ts`
- Modify: `apps/api/test/rabbit-harness.ts`
- Create: `apps/api/test/expire-retry.e2e.spec.ts`
- Create: `apps/api/test/expire-resilience.e2e.spec.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–7.
- Produces: `getTestRabbitManagementUrl()` from `test/harness.ts` and `killBrokerConnections(managementUrl)` from `test/rabbit-harness.ts`.

- [ ] **Step 1: Expose the broker's management port to the tests**

Forcing a reconnection needs a way to cut the connection from outside the process. Restarting the container would change its mapped port and invalidate every URL, so the management API's "close this connection" is used instead.

In `apps/api/test/harness.ts`, change the exposed ports and add the getter:

```ts
export async function startTestRabbit(): Promise<StartedTestContainer> {
  return new GenericContainer('rabbitmq:4-management-alpine')
    .withExposedPorts(5672, 15672)
    .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
    .withStartupTimeout(180_000)
    .start();
}

export function getTestRabbitManagementUrl(): string {
  const url = process.env.RABBITMQ_MANAGEMENT_URL;
  if (!url) throw new Error('RABBITMQ_MANAGEMENT_URL is not set; global setup did not run');
  return url;
}
```

In `apps/api/test/global-setup.ts`, write a fourth file:

```ts
  writeFileSync(
    `${__dirname}/.rabbit-management-url`,
    `http://guest:guest@${rabbit.getHost()}:${String(rabbit.getMappedPort(15672))}`,
    'utf8',
  );
```

In `apps/api/test/setup-after-env.ts`:

```ts
process.env.RABBITMQ_MANAGEMENT_URL = readFileSync(
  `${__dirname}/.rabbit-management-url`,
  'utf8',
).trim();
```

Add `apps/api/test/.rabbit-management-url` to `.gitignore` beside its siblings.

- [ ] **Step 2: Add the connection killer**

Append to `apps/api/test/rabbit-harness.ts`:

```ts
/**
 * Closes every client connection from the broker's side, the way a broker
 * restart or a network partition would. Restarting the container instead would
 * remap its ports and invalidate every URL the suite is holding.
 */
export async function killBrokerConnections(managementUrl: string): Promise<number> {
  const base = new URL(managementUrl);
  const auth = `Basic ${Buffer.from(`${base.username}:${base.password}`).toString('base64')}`;
  const origin = `${base.protocol}//${base.host}`;

  const listed = await fetch(`${origin}/api/connections`, { headers: { authorization: auth } });
  const connections = (await listed.json()) as { name: string }[];

  for (const { name } of connections) {
    await fetch(`${origin}/api/connections/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { authorization: auth },
    });
  }
  return connections.length;
}
```

- [ ] **Step 3: Write the retry and dead-letter suite**

Create `apps/api/test/expire-retry.e2e.spec.ts`:

```ts
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
```

- [ ] **Step 4: Write the resilience suite**

Create `apps/api/test/expire-resilience.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import type { Channel, ChannelModel } from 'amqplib';

import { COMMANDS_EXCHANGE, EXPIRE_KEY, EXPIRE_QUEUE, EXPIRE_WAIT_QUEUE } from '../src/messaging/messages';
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

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
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
```

- [ ] **Step 5: Run both suites**

Run: `npm test -w @cinema/api -- "expire-(retry|resilience)"`
Expected: PASS. The retry suite takes about fifteen seconds of real TTL; the resilience suite about twenty.

- [ ] **Step 6: Run everything, in both modes**

```bash
npm test
RESERVATION_EXPIRY_MODE=queue npm test -w @cinema/api
```

Expected: both pass. The second run is the regression that matters: every phase 2 and phase 3 guarantee — the fifty-clients-one-seat proof, the thousand-distinct-seats proof, both lock strategies — must still hold with the worker's subsystem switched on. If any of them changes its answer, the worker has become load-bearing and the cause must be found before continuing.

- [ ] **Step 7: Commit**

```bash
git add apps/api/test .gitignore
git commit -m "test(api): prove the retry ladder, the dlq, reconnection and lazy-mode parity"
```

---
## Task 9: The stack

**Files:**

- Modify: `docker-compose.yml`
- Modify: `docker-compose.single-api.yml`

**Interfaces:**

- Consumes: `apps/api/dist/worker/main.js`, produced by the existing `nest build` — the Dockerfile needs no change, because it already copies the whole of `apps/api/dist`.
- Produces: the `rabbitmq` and `worker` services.

- [ ] **Step 1: Confirm the worker entry point is in the image**

```bash
npm run build -w @cinema/api && ls apps/api/dist/worker/main.js
```

Expected: the file exists. If it does not, `nest build` is not compiling `src/worker` — check `apps/api/tsconfig.json`'s `include`, which should already cover `src/**/*.ts`.

- [ ] **Step 2: Add the broker to the stack**

In `docker-compose.yml`, add after the `redis` service:

```yaml
  # A volume, unlike redis: these messages are the record that a hold needs
  # settling, and a broker restart that lost them would leave rows for lazy
  # expiry to find by accident rather than by design.
  rabbitmq:
    image: rabbitmq:4-management-alpine
    environment:
      RABBITMQ_DEFAULT_USER: cinema
      RABBITMQ_DEFAULT_PASS: cinema
    healthcheck:
      test: ['CMD', 'rabbitmq-diagnostics', '-q', 'ping']
      interval: 5s
      timeout: 5s
      retries: 20
      # The broker takes longer to become useful than to open its port, and a
      # dependent that starts inside that window fails its first connection.
      start_period: 30s
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
```

And to the `volumes:` block at the bottom:

```yaml
  rabbitmq-data:
```

- [ ] **Step 3: Give the API the broker's address**

In the `api` service's `environment:` block, after `DATABASE_POOL_MAX`:

```yaml
      # Set unconditionally while the mode defaults to `lazy`, exactly as
      # REDIS_URL is: the variable is harmless when unused, and switching the
      # whole stack is then one environment variable rather than an edit.
      RESERVATION_EXPIRY_MODE: ${RESERVATION_EXPIRY_MODE:-lazy}
      RABBITMQ_URL: amqp://cinema:cinema@rabbitmq:5672
```

The `api` service's `depends_on` does **not** gain `rabbitmq`. The API is fully correct without the broker, and making it wait on one would contradict the fail-open design it is built around.

- [ ] **Step 4: Add the worker**

Add after the `api` service:

```yaml
  # The same image as the api, a different entry point. No published port and no
  # HTTP listener: this process consumes a queue and nothing else (ADR 0028).
  worker:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    command: ['node', 'apps/api/dist/worker/main.js']
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://cinema:cinema@postgres:5432/cinema
      LOG_LEVEL: info
      LOCK_STRATEGY: ${LOCK_STRATEGY:-db}
      REDIS_URL: redis://redis:6379
      RESERVATION_EXPIRY_MODE: ${RESERVATION_EXPIRY_MODE:-lazy}
      RABBITMQ_URL: amqp://cinema:cinema@rabbitmq:5672
      RABBITMQ_PREFETCH: ${RABBITMQ_PREFETCH:-20}
    deploy:
      replicas: ${WORKER_REPLICAS:-2}
    depends_on:
      seed:
        condition: service_completed_successfully
      rabbitmq:
        condition: service_healthy
    # In the default `lazy` mode this process logs one line and exits 0. That is
    # success, not a crash, so the restart policy must not treat it as one --
    # `on-failure` restarts a non-zero exit and leaves a clean one alone.
    restart: on-failure
    # Long enough for the drain in onApplicationShutdown to finish the message
    # the worker is holding.
    stop_grace_period: 30s
```

- [ ] **Step 5: Publish the management UI for development only**

In `docker-compose.single-api.yml`, add:

```yaml
  # Development only. The queue depths and the DLQ are the whole diagnostic
  # surface of this sub-project until Prometheus arrives, and being able to look
  # at them is worth a published port on a single-instance stack.
  rabbitmq:
    ports:
      - '5672:5672'
      - '15672:15672'
```

- [ ] **Step 6: Bring the stack up in each mode**

```bash
docker compose up -d --build
docker compose ps
docker compose logs worker --tail 20
```

Expected: `rabbitmq` healthy; each `worker` replica logs `RESERVATION_EXPIRY_MODE is lazy` and exits 0, and is not restarted.

```bash
RESERVATION_EXPIRY_MODE=queue docker compose up -d --build
docker compose logs worker --tail 20
```

Expected: each worker logs `expiry worker started` and `consuming reservation.expire with prefetch 20`, and stays up.

Then walk one hold through the real path:

```bash
curl -s -X POST http://localhost:8080/api/v1/reservations \
  -H 'content-type: application/json' -H "x-session-id: $(uuidgen)" \
  -d "{\"showtimeId\":\"$(curl -s 'http://localhost:8080/api/v1/showtimes?limit=1' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data[0].id')\",\"seatIds\":[]}" | head -c 400
```

That call is expected to fail validation on the empty seat list — it is here only to confirm the API answers through nginx. For the message itself, check the wait queue has a message after a successful hold made from the SPA at <http://localhost:8080>:

```bash
docker compose exec rabbitmq rabbitmqctl list_queues name messages
```

Expected: `reservation.expire.wait` holds one message per hold created, and `reservation.expire.dlq` holds zero.

- [ ] **Step 7: Tear down and commit**

```bash
docker compose down -v
git add docker-compose.yml docker-compose.single-api.yml
git commit -m "feat(infra): run the broker and the expiry worker beside the api replicas"
```

---

## Task 10: The record — decisions and the README

The sub-project is not finished when it runs; it is finished when someone else can read why it is shaped this way. Do this task last.

**Files:**

- Create: `docs/adr/0024-wait-queue-with-ttl-instead-of-a-delayed-message-plugin.md`
- Create: `docs/adr/0025-retry-tiers-with-fixed-ttl-instead-of-one-retry-queue.md`
- Create: `docs/adr/0026-x-attempt-header-instead-of-parsing-x-death.md`
- Create: `docs/adr/0027-id-only-message-and-structural-idempotence.md`
- Create: `docs/adr/0028-worker-as-a-second-entrypoint-of-the-same-image.md`
- Create: `docs/adr/0029-fail-open-on-broker-failure.md`
- Create: `docs/adr/0030-lazy-expiry-stays-authoritative.md`
- Create: `docs/adr/0031-amqplib-recovery-instead-of-a-connection-manager.md`
- Create: `docs/adr/0032-classic-queues-instead-of-quorum.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: nothing. Produces documentation only.

- [ ] **Step 1: Write the nine decision records**

Each follows the house format — `# N. Title`, `**Status:** accepted (2026-09-01)`, then `## Context`, `## Decision`, `## Alternatives considered`, `## Consequences`. Read `docs/adr/0016-redis-as-an-advisory-lock-in-front-of-the-invariant.md` first for the register: an alternative is **named and rejected with its reason**, not merely listed.

Write them with this content:

**0024 — A wait queue with a TTL, not a delayed-message plugin.** Context: RabbitMQ has no native scheduling, and a hold must be settled ten minutes after it is taken. Decision: publish into `reservation.expire.wait`, a durable queue with no consumer, `x-message-ttl` equal to the hold's length and a dead-letter exchange pointing at the work queue; the broker moves the message when it lapses. Alternatives: **`rabbitmq_delayed_message_exchange`** — needs a custom Dockerfile for the broker, and holds delayed messages outside any queue, so they are invisible as depth and survive a restart differently; convenience bought with a non-stock broker. **A polling worker with a due-check query** — reintroduces exactly the sweeper ADR 0011 rejected, and makes the queue a timer rather than a carrier of commands. Consequences: the stock `rabbitmq:4-management-alpine` image is enough; and the head-of-line rule (a queue expires only its head) becomes a **recorded precondition** — this is correct only while every hold shares one TTL, so a sub-project that gives holds different lengths must replace this queue rather than reconfigure it. Changing `RESERVATION_TTL_SECONDS` on a live stack means deleting and recreating the queue, because arguments are part of a queue's identity.

**0025 — Retry tiers with fixed TTLs, not one retry queue with per-message TTLs.** Context: a failing handler should back off, and backoff means different delays. Decision: one queue per rung of `RABBITMQ_RETRY_DELAYS_MS`, each with its own fixed `x-message-ttl` and all dead-lettering back to the work queue. Alternatives: **one retry queue with per-message `expiration`** — violates the very precondition ADR 0024 just accepted, since a 5-second message behind a 120-second one waits 120 seconds; the design would contradict itself two decisions apart. **A single fixed retry delay** — simpler, but then the backoff is not a backoff, and a handler failing against a slow dependency retries into the same slowness. Consequences: three extra queues in the management UI; the number of retries is the length of a list rather than a constant in code, which is what lets the tests run the ladder in milliseconds.

**0026 — `x-attempt`, not `x-death`, as the attempt counter.** Context: bounded retries need to know which attempt this is. Decision: a header we write ourselves, carrying the number of failed handlings so far; the producer publishes `0` and a failing handler republishes `n + 1`. Alternatives: **reading `x-death`** — RabbitMQ collapses its entries by `(queue, reason)` and stores a `count` in each, so an attempt number can only be reconstructed by knowing which queues are retry tiers, and re-derived every time the topology changes; a control variable that breaks when a queue is renamed. Consequences: `x-death` is still forwarded and logged, because as a record of where a message has been it is genuinely useful; it is history, not control. A message published by hand without the header starts at the beginning of the ladder rather than crashing the consumer.

**0027 — The message carries an identifier and nothing else.** Context: a `reservation.expire` message published at hold time is delivered ten minutes later, by which time the hold may have been confirmed, cancelled, or already expired by a caller. Decision: the body is `{ reservationId }`; the handler re-reads the row under the same `FOR UPDATE` that `confirm` and `cancel` take, and decides from what it finds. Alternatives: **carrying `seatIds` and `expiresAt`** — the message would then assert facts that were true when it was published, and acting on them means acting on a ten-minute-old view of the world; the confirm/expire race becomes a real bug rather than an impossible one. **Cancelling the in-flight message when a hold is confirmed** — AMQP has no such operation, and simulating one with a dedupe table is bookkeeping in place of a design. Consequences: idempotence is structural, so at-least-once delivery needs no dedupe table and no `Idempotency-Key` — that is an HTTP concern and stays in sub-project 5. `confirm` and `cancel` publish nothing and cancel nothing.

**0028 — The worker is a second entry point of the same image.** Context: the consumer must not share a crash domain or an event loop with request serving, and the project has one deployable image. Decision: `apps/api/src/worker/main.ts` boots a Nest **application context** — no HTTP adapter, no controllers — and Compose runs it from the same image with a different `command`. Alternatives: **a separate `apps/worker` package** — the shape spec §10's diagram draws, but the shared code (schema, Drizzle module, seat lock, config) would have to move into `packages/` to be importable: a monorepo refactor paid for before a second worker exists to justify it. **Consuming inside the API replicas** — no new container, and competing consumers for free, but a retry storm becomes API latency and phase 3's measurements stop being comparable. Consequences: no new build, no package extraction, and `ReservationService` is reused by plain import; the worker has its own connection pool and its own crash domain; in `lazy` mode the process logs one line and exits 0, so its Compose restart policy must be `on-failure` rather than `always`.

**0029 — Fail open when the broker fails, and `/ready` does not check it.** Context: an expiry message that can fail a hold would have made an optional subsystem load-bearing. Decision: publication errors, unroutable returns and confirmation timeouts (`RABBITMQ_PUBLISH_TIMEOUT_MS`, default 200 ms) are logged at `warn`, counted, and the `201` is returned unchanged; readiness still means "PostgreSQL answers". Also records the deviation from spec §7's table: `RABBITMQ_URL` has no default, because a default makes the "refuse to start without it" rule unreachable. Alternatives: **fail closed** — trades a guarantee we have (holds are correct without a broker) for one we do not need. **Adding the broker to `/ready`** — takes every replica out of rotation over a subsystem the service works without. Consequences: a hold created while the broker is down is settled by lazy expiry and nothing is lost; the API's `depends_on` deliberately omits `rabbitmq`; the cost of a dead broker is one timeout per hold, which is where sub-project 5's circuit breaker goes — it now has two subsystems with the same failure shape to abstract over.

**0030 — Lazy expiry stays authoritative (re-affirming ADR 0011 and ADR 0022).** Context: ADR 0011 predicted a queue would take expiry over; ADR 0022 already narrowed that once, ruling out the Redis TTL. Decision: it does not take over here either. `releaseStaleHolds` is untouched and remains the guarantee; the worker is a second route to the same result, and the test suite proves the system behaves identically with the broker stopped. Alternatives: **making the worker authoritative and deleting the lazy path** — the seat's return would then depend on a delivery, and the one thing this project exists to get right would rest on the least reliable component in it. **Keeping both but letting the worker skip the row lock, since "the worker is the only writer"** — it is not: a caller can expire the same hold at the same moment, which is precisely the race `FOR UPDATE` settles. Consequences: two paths write the same transition, which is deliberate duplication; both are idempotent, and whichever arrives first wins. This is also why no scheduler exists in the codebase — the worker never polls for work, it only acts on a message addressed to it.

**0031 — amqplib's own recovery, not `amqp-connection-manager` and not `@nestjs/microservices`.** Context: a long-lived consumer must survive a broker restart, and AMQP channels do not survive their connection. Decision: `connect(url, { recovery: … })`, added in amqplib 1.1.0, with backoff, jitter and a `setup` hook that re-asserts topology after every successful connection; the publisher and consumer reopen their channels on the `connect` event. Alternatives: **`amqp-connection-manager`** — the standard answer to a problem the library now solves itself, and a second dependency against a phase that admits one. **`@nestjs/microservices`' RMQ transport** — hides ack, nack, prefetch and requeue behind decorators, which are exactly the mechanics spec §10 exists to learn, and pulls in a transport layer to consume a single queue. Consequences: `amqplib` is the only new runtime dependency, and `@types/amqplib` must **not** be installed because the package has bundled its own declarations since 1.2.0. `heartbeat` is never passed as `0`: amqplib 2.0.0 made zero mean "disable" rather than "defer to the server".

**0032 — Classic queues, not quorum queues.** Context: RabbitMQ 4 offers quorum queues with `x-delivery-limit`, which would give bounded retries and dead-lettering without any retry tiers at all. Decision: classic queues and the tiers of ADR 0025. Alternatives: **a quorum work queue with `x-delivery-limit`** — a much smaller topology and no hop-counting code, but redelivery is immediate, so a handler failing on a two-second database blip burns its entire budget in milliseconds and dead-letters a message that would have succeeded on the next tier; the backoff is the point, and quorum queues do not provide one. Consequences: no replication, which costs nothing in a single-broker stack and would need revisiting the day the broker is clustered; the retry topology is ours to maintain, which is why `nextHop` is a pure function with its own tests.

- [ ] **Step 2: Update the README**

Four edits:

1. In the opening paragraph, replace the phase 3 sentence with a phase 4 one: the catalogue and seat map from phase 1, holds and the no-double-booking proof from phase 2, the advisory Redis lock and its measurement from phase 3, and now the expiry of a hold as a delivered message with the retry and dead-letter machinery that makes delivery survivable.

2. Replace "What phase 3 deliberately does not have" with a phase 4 version: still no authentication, no payments, no Kafka, no metrics — and say what phase 4 added and why (`amqplib`, because lazy expiry made "this hold has expired" a thing that happens to nobody in particular, and sub-project 5 needs it to be an event).

3. Add a section after "The experiment":

````markdown
## Expiry as a message

A hold lasts ten minutes. Since phase 4 that deadline is also a message:
`create()` publishes `reservation.expire` into a queue with no consumer whose
TTL is the length of the hold, and when it lapses the broker delivers it to a
worker that settles the row.

```bash
RESERVATION_EXPIRY_MODE=queue docker compose up --build
docker compose exec rabbitmq rabbitmqctl list_queues name messages
```

The mode defaults to `lazy`, which is phase 3's behaviour exactly: no
connection, no queues, nothing published. That is not a fallback but the
baseline — the whole suite runs in both modes, and a worker that changed any
answer phase 2 or phase 3 proved would be a worker that had quietly become
load-bearing.

Stop the broker and holds still expire. That is the design, not a consolation:
lazy expiry never stopped being authoritative (ADR 0030).
````

4. Add two "Notable details" bullets:

```markdown
- **A hold expires because a message was delivered, and also because someone
  wanted the seat.** Two paths write the same transition on purpose. Both take
  the same row lock, both are idempotent, and whichever arrives first wins —
  which is what lets a dead broker cost nothing but a warning.
- **The ten-minute delay is a queue, not a timer.** There is still no cron, no
  `setInterval` and no sweeper anywhere in the API: the wait queue's TTL is the
  clock, and the worker only ever acts on a message addressed to it. A sweeper
  scans for work that may not exist; this receives work that already does.
```

- [ ] **Step 3: Verify and commit**

Run: `npm run format:check`
Expected: pass. Run `npm run format` first if it does not — `docs/adr/` is formatted by prettier, unlike `docs/superpowers/`.

```bash
git add docs README.md
git commit -m "docs: record the phase 4 decisions and how expiry became a message"
```

---

## Definition of Done

- [ ] A lapsed hold becomes `EXPIRED` and returns its seats because a message was delivered, with no caller involved — proved by a test that touches the API only to create the hold.
- [ ] The same hold still expires with the broker stopped, and creating it answers `201` with a `warn` and an incremented counter rather than an error.
- [ ] A duplicate delivery has no second effect; a message that arrives for a `CONFIRMED` hold leaves it confirmed and its seats held.
- [ ] A failing handler walks every retry tier, waits each tier's delay, and lands in the DLQ carrying its original body; an unparseable body lands there immediately, having touched no tier.
- [ ] Killing every broker connection is recovered from without intervention: the topology is re-asserted and consumption resumes.
- [ ] A worker shutting down finishes the message it is holding; two workers on one queue deliver one message exactly once.
- [ ] `RESERVATION_EXPIRY_MODE=lazy` opens no connection, declares no queue and publishes nothing — and the whole phase 2 and phase 3 suite passes in **both** modes, including both lock strategies and the fifty-clients-one-seat proof.
- [ ] `npm run lint && npm run typecheck && npm test` pass, and the Playwright smoke test still walks from the movie list to a confirmed reservation through the balancer.
- [ ] The stack runs the broker and two worker replicas; in `lazy` mode the workers exit 0 and are not restarted.
- [ ] No outbox, no `Idempotency-Key`, no circuit breaker, no rate limiting, no Prometheus, no Kafka, no payments. `amqplib` is the only new runtime dependency, and `@types/amqplib` is **not** installed.
- [ ] No cron, no `setInterval` and no database polling anywhere in the API or the worker. The only `setTimeout` outside tests is the shutdown drain.
- [ ] Nine ADRs record the decisions, each naming the alternative it rejected and why, and the README says how to run the thing in both modes.

## Handover to sub-project 5

- **`cinema.commands` and `assertTopology` are where the next messages go.** `payment.requested`, `booking.created` and the rest bind to the same exchange; the tier and DLQ pattern is already there to copy.
- **The publisher is the outbox seam.** `publishExpire` runs after the commit with no guarantee that it ran at all. When a message starts costing money, that is the exact line a transactional outbox replaces — and `uuidv7()` is already available for outbox row ids.
- **TTL homogeneity is a recorded precondition, not an assumption.** If payment lengthens a hold, `reservation.expire.wait` must be replaced rather than reconfigured. ADR 0024 says why, and the spec says so twice.
- **Two subsystems now fail the same way.** Redis and the broker each cost a timeout per request while down, each fail open, and each are absent from `/ready`. Sub-project 5's circuit breaker has two real clients to abstract over rather than one hypothetical one.
- **The DLQ and the queue depths are the first metrics.** `reservation.expire.dlq` depth, `reservation.expire.wait` depth, the `x-attempt` distribution and `ExpirePublisher.failureCount` are all there for sub-project 10 to scrape on its first day.
- **`settleExpired` is a system action with no session.** It is the first code in the project that acts for nobody in particular, which is the shape every worker after it will have.
