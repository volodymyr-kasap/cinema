# Cinema Booking Platform — Phase 5 (Payment, idempotency and the circuit breaker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move money through the system as a message, and prove by failure injection that none of the provider's four behaviours — success, decline, 500, timeout — can produce a double charge, a confirmed booking nobody paid for, or seats stranded behind a payment that never finished.

**Architecture:** `POST /reservations/:id/confirm` stops being the end of the line. It locks the reservation, moves it `PENDING → PAYMENT_PENDING`, inserts a `payments` row, publishes `{ paymentId }` into `payment.requested` **inside the transaction**, and answers `202`. A second consumer in the existing worker process picks the message up, calls a real HTTP provider through a circuit breaker with `Idempotency-Key: <payments.id>`, and settles the reservation to `CONFIRMED` or `PAYMENT_FAILED`. Failures ride phase 4's retry ladder into a payment DLQ. The hold's clock stops at `PAYMENT_PENDING` — `expires_at` is never rewritten — so `reservation.expire.wait` keeps the single TTL ADR 0024 depends on, and a widened lazy sweep reaps any payment that never came back.

**Tech Stack:** Phase 4's stack — NestJS 12 on Fastify, Drizzle + PostgreSQL 18, Zod 4 contracts, Jest 30 + Testcontainers, ioredis 6, amqplib 2, React 19 — plus **no new runtime dependency at all**. The fake provider is Fastify, already in the lockfile via `@nestjs/platform-fastify`; the HTTP client is the global `fetch` Node 24 ships.

**Spec:** `docs/superpowers/specs/2026-09-03-cinema-platform-phase-5-design.md`

## Global Constraints

Rules that apply to every task:

- **No new npm dependency.** Not `axios` — `fetch` with `AbortSignal.timeout` is in Node 24 and does everything needed. Not `opossum` or any breaker library — the breaker is forty lines and the point of spec §20 is to write it. Not `nock` or `msw` — the provider is a real process on a real socket, which is the entire argument of ADR 0040. If a task seems to need a dependency, stop and ask.
- **A decline is not a failure.** `DECLINED` is a successful HTTP call carrying a business answer. It must never increment the breaker's failure count, never be retried, and never reach the DLQ. Only timeouts, 5xx and transport errors count. Getting this backwards disables payments exactly when the system is working correctly.
- **`Idempotency-Key` is `payments.id` and never changes between attempts.** It is generated once, by `uuidv7()` in the application, before the row is committed. A key derived per-attempt, or regenerated on retry, silently reintroduces the double charge this whole sub-project exists to prevent.
- **`reservations.expires_at` is never written after the row is created.** Not extended, not cleared, not refreshed. `reservation.expire.wait` is correct only because every hold shares one TTL (ADR 0024); moving a single row's deadline would require replacing that queue. `PAYMENT_PENDING` changes who owns the seats, not when the hold ends.
- **The correctness invariant never moves.** `reservation_seats_active_uq` stays the arbiter of double booking, and lazy release stays authoritative (ADR 0030). No path to returning a seat to the pool may depend on the broker or the provider being reachable.
- **The subsystem does not switch itself on.** `PAYMENT_MODE` defaults to `off`, and on `off` the API answers `200 CONFIRMED` exactly as it does today, writes no `payments` row and publishes no message. Every phase 1–4 test must pass unchanged with no environment variable set.
- **`state-machine.ts` takes no configuration.** It imports the status type and nothing else. `PENDING` lists both `PAYMENT_PENDING` and `CONFIRMED` as legal targets; `confirm` picks which edge to use. A transition table with two shapes depending on the environment stops being a statement about the domain.
- **Publish-then-ack in the consumer, publish-before-commit in the producer.** These are different rules for different reasons and both are deliberate; see Task 6 and Task 9. Do not "make them consistent".
- **Out of scope, each with its own sub-project:** refunds and voids, the transactional outbox, `bookings` and `tickets` tables, Kafka, rate limiting, Prometheus/Grafana, authentication, and any real payment integration.
- **Money is `integer` in minor units** (`*_cents`), single currency UAH. **Timestamps are `timestamptz` in UTC.** **JSON field names are camelCase.**
- **Time comparisons against the database use the database's `now()`**, never the Node process clock. The one exception is the circuit breaker, whose clock is injected precisely so tests can control it.
- **`@cinema/contracts` must be rebuilt (`npm run build -w @cinema/contracts`) before `apps/api`, `apps/web` or `apps/payment-provider` are typechecked or tested** after any change to it. This plan changes contracts in Task 1, so every later task depends on that build having happened; `npm test` does it first.
- **Node 24.9+ is required.** Jest 30 strips types from `jest.config.ts` natively and loads the pure-ESM Fastify adapter through `require(ESM)`. Under Node 22 the suite fails with a misleading `ts-node` error. `.nvmrc` pins `24`.
- **Commit after every task** using the message given in that task's final step.

## Existing code this plan builds on

Read these before starting — the plan assumes their shapes and does not repeat them:

| File                                               | What it gives you                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/config/env.ts`                       | `parseEnv`, `AppConfig`, and the Zod object plus `.refine` chain every new variable joins                       |
| `apps/api/src/messaging/messages.ts`               | `COMMANDS_EXCHANGE`, the expire names, `ATTEMPT_HEADER`, and `retryQueue`/`retryKey` the payment ladder mirrors |
| `apps/api/src/messaging/topology.ts`               | `assertTopology` — the only place a queue is declared, and the 406 rule that makes that necessary               |
| `apps/api/src/messaging/retry.ts`                  | `nextHop`/`attemptOf`; Task 5 generalises `nextHop` to take a ladder                                            |
| `apps/api/src/messaging/expire.publisher.ts`       | The confirm-channel, `mandatory`, fail-open publisher the payment publisher deliberately does **not** copy      |
| `apps/api/src/worker/expire.consumer.ts`           | The subscribe / decision-table / forward-then-ack shape `PaymentConsumer` follows exactly                       |
| `apps/api/src/reservations/reservation.service.ts` | `confirm`, `settleExpired`, and the private `expire` / `releaseLocks` / `releaseStaleHolds` this plan extends   |
| `apps/api/src/reservations/state-machine.ts`       | `TRANSITIONS`, `TERMINAL_STATUSES`, `canTransition`                                                             |
| `apps/api/src/http/errors.ts`                      | `DomainError` and its subclasses; two new ones join them in Task 6                                             |
| `apps/api/test/harness.ts`                         | `startTestDatabase` / `startTestRedis` / `startTestRabbit` and their URL getters                                |
| `apps/api/test/global-setup.ts`                    | Starts containers concurrently and writes URLs to files `setup-after-env.ts` reads; Task 3 adds the provider    |
| `apps/api/test/reservation-harness.ts`             | `startReservationHarness()` and its env-override-then-compile-then-restore pattern                             |
| `apps/api/test/rabbit-harness.ts`                  | `openInspection`, `deleteTopology`, `queueDepth`, `takeOne`, `startWorkerHarness`, `killBrokerConnections`      |
| `apps/api/test/truncate.ts`                        | `truncateReservations(db, redis)` — Task 4 extends it to `payments`                                            |
| `docker-compose.yml`                               | The stack Task 12 extends; `worker` already exists and only gains variables                                    |

## File Structure

```
packages/contracts/src/
├── payment.ts                      # NEW: the provider wire contract, shared by both sides
├── payment.test.ts                 # NEW: schema round-trips
├── reservation.ts                  # MODIFY: two statuses, payment summary on the reservation
└── index.ts                        # MODIFY: export ./payment.js

apps/payment-provider/              # NEW WORKSPACE — Fastify, no database, no Nest
├── package.json
├── tsconfig.json
├── Dockerfile
└── src/
    ├── scenario.ts                 # NEW: header wins, else weighted random — pure
    ├── scenario.test.ts            # NEW
    ├── store.ts                    # NEW: Map from Idempotency-Key to stored response
    ├── provider.ts                 # NEW: buildProvider() -> FastifyInstance
    ├── provider.test.ts            # NEW: via fastify.inject(), no socket needed
    └── main.ts                     # NEW: listen()

apps/api/src/
├── resilience/
│   ├── circuit-breaker.ts          # NEW: pure state machine, injected clock
│   └── circuit-breaker.test.ts     # NEW
├── payments/
│   ├── payment.module.ts           # NEW: worker-side only; AppModule does NOT import it
│   ├── payment-provider.client.ts  # NEW: fetch + AbortSignal.timeout, wrapped by the breaker
│   └── payment.service.ts          # NEW: claim -> charge -> settle, the worker's orchestrator
├── messaging/
│   ├── messages.ts                 # MODIFY: payment names, paymentMessageSchema, the two ladders
│   ├── topology.ts                 # MODIFY: the payment queues
│   ├── retry.ts                    # MODIFY: nextHop takes a Ladder
│   ├── payment.publisher.ts        # NEW: publishes on a caller-supplied channel, and DOES throw
│   └── messaging.module.ts         # MODIFY: provides PaymentPublisher
├── worker/
│   ├── payment.consumer.ts         # NEW: second subscription, own channel and prefetch
│   ├── worker.module.ts            # MODIFY: PaymentModule + PaymentConsumer
│   └── main.ts                     # MODIFY: runs when either subsystem is on
├── reservations/
│   ├── state-machine.ts            # MODIFY: two states, four edges
│   ├── reservation.service.ts      # MODIFY: confirm branches; claimPayment/settlePayment; the reaper
│   └── reservation.controller.ts   # MODIFY: 202 when a payment starts
├── db/
│   └── schema.ts                   # MODIFY: the payments table
├── config/
│   ├── env.ts                      # MODIFY: six variables and one refine
│   └── env.test.ts                 # MODIFY
└── http/errors.ts                  # MODIFY: PaymentInFlightError, PaymentUnavailableError

apps/api/drizzle/
└── 0003_payments.sql               # NEW

apps/api/test/
├── harness.ts                      # MODIFY: startTestProvider / getTestProviderUrl
├── global-setup.ts                 # MODIFY: boot the provider in-process on port 0
├── global-teardown.ts              # MODIFY: close it
├── setup-after-env.ts              # MODIFY: PAYMENT_PROVIDER_URL
├── truncate.ts                     # MODIFY: payments
├── payment-harness.ts              # NEW: payment topology reset, worker harness, row helpers
├── payment-begin.e2e.spec.ts       # NEW: confirm -> 202, one row, one message, 503 on publish failure
├── payment-settle.e2e.spec.ts      # NEW: the decision table at service level
├── payment-consumer.e2e.spec.ts    # NEW: the same table through a real broker
├── payment-resilience.e2e.spec.ts  # NEW: ladder, DLQ, breaker, dead provider, lost response
└── payment-expiry.e2e.spec.ts      # NEW: the expiry race and the reaper

apps/web/src/
├── shared/api/reservations.ts      # MODIFY: confirm may answer 202
├── shared/lib/use-reservation.ts   # NEW: the polling query
└── features/reservations/reservation-page.tsx   # MODIFY: the paying state
```

## Where this plan refines the spec

Two deliberate departures from the spec's §14 file list, both discovered while
working the design into code. The plan is authoritative on them.

- **`app.module.ts` is not modified.** The spec listed it as importing
  `PaymentModule`. It should not: the API never calls the provider. Its half of
  payment is `PaymentPublisher`, which lives in `MessagingModule` and is already
  imported through `ReservationModule`. `PaymentModule` is worker-side only, and
  keeping it out of the API image means a provider outage cannot affect a process
  that was never going to talk to it.
- **`PaymentService` does not own the database writes.** The spec implied a
  service owning the whole payment path. Written that way it needs
  `ReservationService` for seat release while `ReservationService` needs it for
  `confirm` — a cycle, and a `forwardRef`. The plan splits by direction instead:
  `ReservationService` keeps the reservation lifecycle and seat release
  (`claimPayment`, `settlePayment`), `PaymentService` is the provider-facing
  orchestrator, and the dependency runs one way only.

---

## Task 1: Configuration and the payment vocabulary

Every name this sub-project uses, and the environment that switches it on. Nothing here talks to a broker, a provider or a database, so it is all unit-testable.

**Files:**

- Create: `packages/contracts/src/payment.ts`
- Create: `packages/contracts/src/payment.test.ts`
- Modify: `packages/contracts/src/reservation.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/config/env.test.ts`
- Modify: `apps/api/src/messaging/messages.ts`
- Modify: `apps/api/src/messaging/messages.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `paymentScenarioSchema` / `PaymentScenario = 'success' | 'decline' | 'error' | 'timeout'`
  - `paymentStatusSchema` / `PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'DECLINED' | 'FAILED'`
  - `chargeRequestSchema` / `ChargeRequest = { amountCents: number; reference: string }`
  - `chargeResponseSchema` / `ChargeResponse` — a discriminated union on `status`
  - `IDEMPOTENCY_KEY_HEADER`, `PAYMENT_SCENARIO_HEADER`, `IDEMPOTENT_REPLAY_HEADER`
  - `reservationStatusSchema` extended with `PAYMENT_PENDING` and `PAYMENT_FAILED`
  - `AppConfig` fields `paymentMode`, `paymentProviderUrl`, `paymentTimeoutMs`, `paymentDeadlineSeconds`, `paymentBreakerFailureThreshold`, `paymentBreakerOpenMs`
  - `PAYMENT_QUEUE`, `PAYMENT_KEY`, `PAYMENT_DLQ`, `PAYMENT_DEAD_KEY`, `paymentRetryQueue(tier)`, `paymentRetryKey(tier)`, `paymentMessageSchema`, `EXPIRE_LADDER`, `PAYMENT_LADDER`, `type Ladder`

- [ ] **Step 1: Write the failing contract test**

Create `packages/contracts/src/payment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { chargeRequestSchema, chargeResponseSchema, paymentScenarioSchema } from './payment.js';
import { reservationStatusSchema } from './reservation.js';

describe('payment contracts', () => {
  it('names the four scenarios spec.md section 11 lists', () => {
    expect(paymentScenarioSchema.options).toEqual(['success', 'decline', 'error', 'timeout']);
  });

  it('accepts a charge request and rejects a non-uuid reference', () => {
    expect(
      chargeRequestSchema.parse({ amountCents: 4500, reference: '00000000-0000-7000-8000-000000000001' }),
    ).toEqual({ amountCents: 4500, reference: '00000000-0000-7000-8000-000000000001' });
    expect(chargeRequestSchema.safeParse({ amountCents: 4500, reference: 'nope' }).success).toBe(false);
  });

  it('discriminates the two successful outcomes on status', () => {
    const succeeded = chargeResponseSchema.parse({
      status: 'SUCCEEDED',
      providerRef: 'ch_abc',
      amountCents: 4500,
    });
    expect(succeeded.status).toBe('SUCCEEDED');

    const declined = chargeResponseSchema.parse({
      status: 'DECLINED',
      declineReason: 'insufficient-funds',
    });
    expect(declined.status).toBe('DECLINED');

    // A SUCCEEDED body without a providerRef is the shape a broken provider
    // would send, and it must not parse: the reference is what a refund would
    // one day be issued against.
    expect(chargeResponseSchema.safeParse({ status: 'SUCCEEDED', amountCents: 1 }).success).toBe(false);
  });

  it('carries the two new reservation states', () => {
    expect(reservationStatusSchema.options).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'CONFIRMED',
      'PAYMENT_FAILED',
      'CANCELLED',
      'EXPIRED',
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test -w @cinema/contracts
```

Expected: FAIL — `Cannot find module './payment.js'`.

- [ ] **Step 3: Write the payment contract**

Create `packages/contracts/src/payment.ts`:

```ts
import { z } from 'zod';

/**
 * How the fake provider is told what to do. The header wins; without it the
 * provider rolls its configured probabilities.
 *
 * This is not a test-only backdoor bolted onto production code: the provider is
 * a fake in its entirety, and a scenario is an ordinary input to it. What would
 * be a backdoor is the API branching on it, and the API never does — it copies
 * the value onto the payment row and forwards it unread.
 */
export const paymentScenarioSchema = z.enum(['success', 'decline', 'error', 'timeout']);
export type PaymentScenario = z.infer<typeof paymentScenarioSchema>;

/**
 * `DECLINED` is the provider's opinion; `FAILED` is ours. Both send the
 * reservation to PAYMENT_FAILED, but collapsing them would throw away the only
 * signal that distinguishes a broken downstream from a refused card.
 */
export const paymentStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED']);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const chargeRequestSchema = z.object({
  amountCents: z.int().positive(),
  /** The reservation this charge is for. Opaque to the provider; useful in its logs. */
  reference: z.uuid(),
});
export type ChargeRequest = z.infer<typeof chargeRequestSchema>;

/**
 * Only the two outcomes that arrive as `200`. A 5xx or a timeout is not a
 * response shape, it is the absence of one, and it is represented by the client
 * throwing rather than by a third variant here.
 */
export const chargeResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('SUCCEEDED'),
    providerRef: z.string().min(1),
    amountCents: z.int().positive(),
  }),
  z.object({
    status: z.literal('DECLINED'),
    declineReason: z.string().min(1),
  }),
]);
export type ChargeResponse = z.infer<typeof chargeResponseSchema>;

/** Lowercase: Node lowercases incoming header names, and both sides read them. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const PAYMENT_SCENARIO_HEADER = 'x-payment-scenario';
/** Set by the provider when it replayed a stored answer instead of charging. */
export const IDEMPOTENT_REPLAY_HEADER = 'x-idempotent-replay';
```

- [ ] **Step 4: Extend the reservation contract**

In `packages/contracts/src/reservation.ts`, replace the status enum and its comment:

```ts
/**
 * The whole state machine. `PENDING` and `PAYMENT_PENDING` are the only
 * non-terminal states: a hold either starts a payment, is given up, or runs out
 * of time; a payment either succeeds or does not.
 */
export const reservationStatusSchema = z.enum([
  'PENDING',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'CANCELLED',
  'EXPIRED',
]);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;
```

Then add the payment summary to `reservationSchema`, after `seats`:

```ts
export const reservationSchema = z.object({
  id: z.uuid(),
  showtimeId: z.uuid(),
  status: reservationStatusSchema,
  totalPriceCents: z.int().nonnegative(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  seats: z.array(reservationSeatSchema).min(1),
  /**
   * Present only once a payment has been started. Optional rather than
   * nullable so every response phases 1-4 produced still parses unchanged.
   */
  payment: z
    .object({
      status: paymentStatusSchema,
      amountCents: z.int().positive(),
      attempts: z.int().nonnegative(),
    })
    .optional(),
});
```

Add the import at the top of the file:

```ts
import { paymentStatusSchema } from './payment.js';
```

- [ ] **Step 5: Export it**

In `packages/contracts/src/index.ts`, add the line **before** `./reservation.js` so the payment schema is defined before the reservation schema that references it:

```ts
export * from './payment.js';
export * from './reservation.js';
```

- [ ] **Step 6: Run the contract tests**

```bash
npm run test -w @cinema/contracts
```

Expected: PASS, 4 new tests.

- [ ] **Step 7: Write the failing environment test**

In `apps/api/src/config/env.test.ts`, add inside the existing top-level `describe`:

```ts
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  };

  it('defaults PAYMENT_MODE to off and needs no provider url', () => {
    const config = parseEnv({ ...base } as NodeJS.ProcessEnv);
    expect(config.paymentMode).toBe('off');
    expect(config.paymentProviderUrl).toBeUndefined();
    expect(config.paymentTimeoutMs).toBe(2_000);
    expect(config.paymentDeadlineSeconds).toBe(300);
    expect(config.paymentBreakerFailureThreshold).toBe(5);
    expect(config.paymentBreakerOpenMs).toBe(30_000);
  });

  it('requires PAYMENT_PROVIDER_URL when PAYMENT_MODE is queue', () => {
    expect(() =>
      parseEnv({
        ...base,
        PAYMENT_MODE: 'queue',
        RABBITMQ_URL: 'amqp://localhost',
      } as NodeJS.ProcessEnv),
    ).toThrow(/PAYMENT_PROVIDER_URL/);
  });

  it('requires RABBITMQ_URL when PAYMENT_MODE is queue', () => {
    // Payment travels as a message. A broker-less queue mode would accept
    // confirms it could never settle.
    expect(() =>
      parseEnv({
        ...base,
        PAYMENT_MODE: 'queue',
        PAYMENT_PROVIDER_URL: 'http://provider:4000',
      } as NodeJS.ProcessEnv),
    ).toThrow(/RABBITMQ_URL/);
  });

  it('accepts a fully configured queue mode', () => {
    const config = parseEnv({
      ...base,
      PAYMENT_MODE: 'queue',
      PAYMENT_PROVIDER_URL: 'http://provider:4000/',
      RABBITMQ_URL: 'amqp://localhost',
    } as NodeJS.ProcessEnv);
    expect(config.paymentMode).toBe('queue');
    // Trailing slash stripped, like PUBLIC_ERROR_BASE_URL: the client appends
    // '/charge' and '//charge' is a different path on a strict router.
    expect(config.paymentProviderUrl).toBe('http://provider:4000');
  });

  it('rejects a breaker threshold of zero', () => {
    // A threshold of zero opens the breaker before any call has failed, which
    // is a permanently disabled payment path presented as a configuration.
    expect(() =>
      parseEnv({ ...base, PAYMENT_BREAKER_FAILURE_THRESHOLD: '0' } as NodeJS.ProcessEnv),
    ).toThrow();
  });
```

- [ ] **Step 8: Run it and watch it fail**

```bash
npm run build -w @cinema/contracts && npx jest src/config/env.test.ts --runInBand -w @cinema/api
```

(Or from `apps/api`: `npx jest src/config/env.test.ts`.)

Expected: FAIL — `config.paymentMode` is `undefined`.

- [ ] **Step 9: Add the variables**

In `apps/api/src/config/env.ts`, add to `envObject` after the RabbitMQ block:

```ts
  // `off` by default, deliberately, for the third time: a new subsystem does
  // not switch itself on. Here it buys something extra -- on `off` the confirm
  // endpoint keeps phase 2's contract exactly, so every test written before
  // this sub-project stays true (ADR 0017).
  PAYMENT_MODE: z.enum(['off', 'queue']).default('off'),
  // No default, for the reason REDIS_URL and RABBITMQ_URL have none: a default
  // makes the refine below vacuous, and refusing to boot beats answering 500.
  PAYMENT_PROVIDER_URL: z.url({ protocol: /^https?$/ }).optional(),
  // Past this, a slow provider is a dead one. Deliberately short: the caller is
  // a worker with a retry ladder behind it, not a user watching a spinner.
  PAYMENT_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(2_000),
  // How long a reservation may sit in PAYMENT_PENDING before the lazy sweep
  // decides nobody is coming back for it. Must exceed the whole retry ladder,
  // or the reaper races the last tier and frees seats a live payment still owns.
  PAYMENT_DEADLINE_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),
  // Consecutive infrastructural failures before the breaker opens. Declines are
  // not counted -- see ADR 0038.
  PAYMENT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(1_000).default(5),
  PAYMENT_BREAKER_OPEN_MS: z.coerce.number().int().min(1).max(600_000).default(30_000),
```

Add two refines to the `envSchema` chain:

```ts
  .refine((env) => env.PAYMENT_MODE !== 'queue' || env.PAYMENT_PROVIDER_URL !== undefined, {
    path: ['PAYMENT_PROVIDER_URL'],
    error: 'PAYMENT_PROVIDER_URL is required when PAYMENT_MODE is queue',
  })
  .refine((env) => env.PAYMENT_MODE !== 'queue' || env.RABBITMQ_URL !== undefined, {
    path: ['RABBITMQ_URL'],
    error: 'RABBITMQ_URL is required when PAYMENT_MODE is queue',
  });
```

Add to the `AppConfig` type:

```ts
  paymentMode: z.infer<typeof envObject>['PAYMENT_MODE'];
  paymentProviderUrl: string | undefined;
  paymentTimeoutMs: number;
  paymentDeadlineSeconds: number;
  paymentBreakerFailureThreshold: number;
  paymentBreakerOpenMs: number;
```

And to the object `parseEnv` returns:

```ts
    paymentMode: env.PAYMENT_MODE,
    paymentProviderUrl: env.PAYMENT_PROVIDER_URL?.replace(/\/+$/, ''),
    paymentTimeoutMs: env.PAYMENT_TIMEOUT_MS,
    paymentDeadlineSeconds: env.PAYMENT_DEADLINE_SECONDS,
    paymentBreakerFailureThreshold: env.PAYMENT_BREAKER_FAILURE_THRESHOLD,
    paymentBreakerOpenMs: env.PAYMENT_BREAKER_OPEN_MS,
```

- [ ] **Step 10: Run the environment test**

```bash
cd apps/api && npx jest src/config/env.test.ts
```

Expected: PASS.

- [ ] **Step 11: Write the failing message-vocabulary test**

In `apps/api/src/messaging/messages.test.ts`, add:

```ts
describe('payment message vocabulary', () => {
  it('names the payment queues on the same exchange', () => {
    expect(PAYMENT_QUEUE).toBe('payment.requested');
    expect(PAYMENT_KEY).toBe('payment.requested');
    expect(PAYMENT_DLQ).toBe('payment.requested.dlq');
    expect(PAYMENT_DEAD_KEY).toBe('payment.requested.dead');
    expect(paymentRetryQueue(2)).toBe('payment.requested.retry.2');
    expect(paymentRetryKey(2)).toBe('payment.requested.retry.2');
  });

  it('has no wait queue, because the first charge is not delayed', () => {
    // Stated as a test so that adding one later is a deliberate act with a
    // failing assertion attached, not a quiet copy of the expire topology.
    expect(Object.keys({ PAYMENT_QUEUE, PAYMENT_DLQ })).not.toContain('PAYMENT_WAIT_QUEUE');
  });

  it('carries only an id, like the expire message', () => {
    expect(paymentMessageSchema.parse({ paymentId: '00000000-0000-7000-8000-000000000001' })).toEqual({
      paymentId: '00000000-0000-7000-8000-000000000001',
    });
    expect(paymentMessageSchema.safeParse({ paymentId: 'x' }).success).toBe(false);
    // A body carrying the amount would be a fact that can go stale between
    // publication and delivery. The row is read instead (ADR 0027).
    expect(
      paymentMessageSchema.parse({
        paymentId: '00000000-0000-7000-8000-000000000001',
        amountCents: 999,
      }),
    ).toEqual({ paymentId: '00000000-0000-7000-8000-000000000001' });
  });

  it('describes both ladders', () => {
    expect(EXPIRE_LADDER.deadKey).toBe(EXPIRE_DEAD_KEY);
    expect(EXPIRE_LADDER.retryKey(1)).toBe('reservation.expire.retry.1');
    expect(PAYMENT_LADDER.deadKey).toBe(PAYMENT_DEAD_KEY);
    expect(PAYMENT_LADDER.retryKey(1)).toBe('payment.requested.retry.1');
  });
});
```

Extend the existing import at the top of the file to include `PAYMENT_QUEUE`, `PAYMENT_KEY`, `PAYMENT_DLQ`, `PAYMENT_DEAD_KEY`, `paymentRetryQueue`, `paymentRetryKey`, `paymentMessageSchema`, `EXPIRE_LADDER`, `PAYMENT_LADDER` and `EXPIRE_DEAD_KEY`.

- [ ] **Step 12: Run it and watch it fail**

```bash
cd apps/api && npx jest src/messaging/messages.test.ts
```

Expected: FAIL — `PAYMENT_QUEUE is not defined`.

- [ ] **Step 13: Add the payment names**

Append to `apps/api/src/messaging/messages.ts`:

```ts
/**
 * The second message. Same exchange, same direct routing, same ladder shape --
 * and no wait queue, because unlike expiry there is nothing to wait for: a
 * charge is due the moment the hold is confirmed.
 */
export const PAYMENT_QUEUE = 'payment.requested';
export const PAYMENT_DLQ = 'payment.requested.dlq';

export const PAYMENT_KEY = 'payment.requested';
export const PAYMENT_DEAD_KEY = 'payment.requested.dead';

export function paymentRetryQueue(tier: number): string {
  return `payment.requested.retry.${String(tier)}`;
}

export function paymentRetryKey(tier: number): string {
  return `payment.requested.retry.${String(tier)}`;
}

/**
 * An identifier and nothing else, for the same reason `expireMessageSchema`
 * carries only one: the amount, the scenario and the state are all read from
 * the row at handling time, so a delivery that arrives after the payment was
 * settled cannot act on a stale copy of anything (ADR 0027).
 */
export const paymentMessageSchema = z.object({ paymentId: z.uuid() });

export type PaymentMessage = z.infer<typeof paymentMessageSchema>;

/**
 * Which set of routing keys a failing handler climbs. Two messages now share
 * one `nextHop`, and the alternative -- a second near-identical copy of the
 * ladder logic -- is how the two drift apart.
 */
export interface Ladder {
  retryKey: (tier: number) => string;
  deadKey: string;
}

export const EXPIRE_LADDER: Ladder = { retryKey, deadKey: EXPIRE_DEAD_KEY };
export const PAYMENT_LADDER: Ladder = { retryKey: paymentRetryKey, deadKey: PAYMENT_DEAD_KEY };
```

- [ ] **Step 14: Run the messaging tests**

```bash
cd apps/api && npx jest src/messaging/
```

Expected: PASS. `retry.test.ts` still passes — `nextHop` is untouched until Task 5.

- [ ] **Step 15: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Expected: both clean.

- [ ] **Step 16: Commit**

```bash
git add packages/contracts apps/api/src/config apps/api/src/messaging
git commit -m "feat(contracts): name the payment states, the wire contract and the queues

Two reservation states, a provider contract both sides parse, six
environment variables defaulting the subsystem off, and the payment
ladder's routing keys. nextHop still only knows the expire ladder;
Task 5 generalises it.

PAYMENT_MODE=queue refuses to boot without both a provider URL and a
broker: payment travels as a message, so a broker-less queue mode would
accept confirms it could never settle."
```

---

## Task 2: The circuit breaker

A pure state machine with an injected clock. No HTTP, no Nest, no container — every transition in spec §8 is provable in milliseconds.

**Files:**

- Create: `apps/api/src/resilience/circuit-breaker.ts`
- Create: `apps/api/src/resilience/circuit-breaker.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'`
  - `class CircuitOpenError extends Error`
  - `interface CircuitBreakerOptions { failureThreshold: number; openMs: number; now?: () => number }`
  - `class CircuitBreaker` with `execute<T>(operation: () => Promise<T>): Promise<T>`, `get state(): BreakerState`, `get failures(): number`, `get rejected(): number`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/resilience/circuit-breaker.test.ts`:

```ts
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

describe('CircuitBreaker', () => {
  /** A clock the test moves by hand: no timers, no sleeping, no flakiness. */
  const clock = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  const boom = () => Promise.reject(new Error('downstream is down'));
  const fine = () => Promise.resolve('charged');

  it('passes calls straight through while closed', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1_000, now: clock().now });
    await expect(breaker.execute(fine)).resolves.toBe('charged');
    expect(breaker.state).toBe('CLOSED');
  });

  it('stays closed below the threshold and forgets failures after a success', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1_000, now: clock().now });

    await expect(breaker.execute(boom)).rejects.toThrow('downstream is down');
    await expect(breaker.execute(boom)).rejects.toThrow('downstream is down');
    expect(breaker.state).toBe('CLOSED');

    // Consecutive, not cumulative: an intermittent downstream that mostly works
    // is not a downstream worth cutting off.
    await breaker.execute(fine);
    await expect(breaker.execute(boom)).rejects.toThrow('downstream is down');
    expect(breaker.state).toBe('CLOSED');
  });

  it('opens on the threshold-th consecutive failure', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1_000, now: clock().now });
    for (let i = 0; i < 3; i += 1) await expect(breaker.execute(boom)).rejects.toThrow();
    expect(breaker.state).toBe('OPEN');
  });

  it('rejects without calling the operation while open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000, now: clock().now });
    await expect(breaker.execute(boom)).rejects.toThrow();

    let called = 0;
    const counted = () => {
      called += 1;
      return fine();
    };

    // The whole point: an open breaker must not touch the downstream. If this
    // assertion is ever weakened, the breaker has become a logging decorator.
    await expect(breaker.execute(counted)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(0);
    expect(breaker.rejected).toBe(1);
  });

  it('half-opens once openMs has passed and closes on a success', async () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000, now: c.now });
    await expect(breaker.execute(boom)).rejects.toThrow();

    c.advance(999);
    await expect(breaker.execute(fine)).rejects.toBeInstanceOf(CircuitOpenError);

    c.advance(1);
    await expect(breaker.execute(fine)).resolves.toBe('charged');
    expect(breaker.state).toBe('CLOSED');
  });

  it('re-opens on a failed trial call and restarts the clock', async () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000, now: c.now });
    await expect(breaker.execute(boom)).rejects.toThrow();

    c.advance(1_000);
    await expect(breaker.execute(boom)).rejects.toThrow('downstream is down');
    expect(breaker.state).toBe('OPEN');

    // Restarted, not resumed: a downstream that failed its trial gets another
    // full openMs of quiet, not an immediate second trial.
    c.advance(999);
    await expect(breaker.execute(fine)).rejects.toBeInstanceOf(CircuitOpenError);
    c.advance(1);
    await expect(breaker.execute(fine)).resolves.toBe('charged');
  });

  it('admits only one trial call while half-open', async () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000, now: c.now });
    await expect(breaker.execute(boom)).rejects.toThrow();
    c.advance(1_000);

    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return 'charged';
    };

    const results = await Promise.allSettled([breaker.execute(slow), breaker.execute(slow)]);
    // A half-open breaker that admits the whole backlog is a thundering herd
    // aimed at the one downstream least able to take it.
    expect(peak).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('does not count a resolved call, whatever it resolved to', async () => {
    // This is the DECLINED rule, expressed where it is actually enforced: the
    // breaker counts thrown errors, so a client that returns a decline as a
    // value can never trip it. See PaymentProviderClient in Task 7.
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 1_000, now: clock().now });
    await breaker.execute(() => Promise.resolve({ status: 'DECLINED' as const }));
    await breaker.execute(() => Promise.resolve({ status: 'DECLINED' as const }));
    await breaker.execute(() => Promise.resolve({ status: 'DECLINED' as const }));
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.failures).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx jest src/resilience/
```

Expected: FAIL — `Cannot find module './circuit-breaker'`.

- [ ] **Step 3: Write the breaker**

Create `apps/api/src/resilience/circuit-breaker.ts`:

```ts
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Thrown instead of calling the downstream. It is an ordinary failure as far as
 * the caller is concerned -- in this codebase that means the message climbs to
 * the next retry tier -- which is exactly the intent: the breaker decides
 * whether to call, the ladder decides when to try again. Neither reimplements
 * the other.
 */
export class CircuitOpenError extends Error {
  constructor(remainingMs: number) {
    super(`circuit is open for another ${String(remainingMs)}ms`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long it stays open before admitting one trial call. */
  openMs: number;
  /** Injected so tests move time by hand instead of sleeping. */
  now?: () => number;
}

/**
 * One downstream, one breaker, one process. State is deliberately local: a
 * breaker shared through Redis would put Redis on the payment path and would
 * need an answer to "what if the breaker state is unreadable", whose only
 * honest answer -- fail open -- disables the breaker exactly when it matters
 * (ADR 0038).
 *
 * Only a *thrown* error counts as a failure. A call that resolves has succeeded
 * whatever it resolved to, which is how a declined card is kept from opening
 * the circuit without this class knowing what a card is.
 */
export class CircuitBreaker {
  private state_: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  /** True while the single half-open trial call is in flight. */
  private trialInFlight = false;
  private rejectedCount = 0;

  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions) {
    this.threshold = options.failureThreshold;
    this.openMs = options.openMs;
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    return this.state_;
  }

  /** Consecutive failures right now, not since boot. Zero whenever closed and healthy. */
  get failures(): number {
    return this.consecutiveFailures;
  }

  /** Calls refused without touching the downstream, since boot. */
  get rejected(): number {
    return this.rejectedCount;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state_ === 'OPEN') {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.openMs) {
        this.rejectedCount += 1;
        throw new CircuitOpenError(this.openMs - elapsed);
      }
      this.state_ = 'HALF_OPEN';
      this.trialInFlight = false;
    }

    if (this.state_ === 'HALF_OPEN') {
      // One trial at a time. Without this the whole queued backlog arrives at
      // the downstream the instant openMs lapses.
      if (this.trialInFlight) {
        this.rejectedCount += 1;
        throw new CircuitOpenError(0);
      }
      this.trialInFlight = true;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.state_ = 'CLOSED';
    this.consecutiveFailures = 0;
    this.trialInFlight = false;
  }

  private onFailure(): void {
    this.trialInFlight = false;

    // A failed trial restarts the full quiet period rather than resuming what
    // was left of it: the downstream just told us it is still broken.
    if (this.state_ === 'HALF_OPEN') {
      this.open();
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) this.open();
  }

  private open(): void {
    this.state_ = 'OPEN';
    this.openedAt = this.now();
  }
}
```

- [ ] **Step 4: Run the test**

```bash
cd apps/api && npx jest src/resilience/
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/resilience
git commit -m "feat(api): a circuit breaker with an injected clock

CLOSED -> OPEN -> HALF_OPEN -> CLOSED, with one trial call admitted at a
time and a failed trial restarting the full quiet period. The clock is a
constructor parameter, so all eight transitions are proved without a
timer.

Only a thrown error counts as a failure. That is how a declined card is
kept from opening the circuit without this class knowing what a card is:
the client returns declines as values and throws only for timeouts, 5xx
and transport errors."
```

---

## Task 3: The fake payment provider

A separate workspace, a separate process, a real socket. The failure modes this sub-project is about only exist across a network boundary.

**Files:**

- Create: `apps/payment-provider/package.json`
- Create: `apps/payment-provider/tsconfig.json`
- Create: `apps/payment-provider/src/scenario.ts`
- Create: `apps/payment-provider/src/scenario.test.ts`
- Create: `apps/payment-provider/src/store.ts`
- Create: `apps/payment-provider/src/provider.ts`
- Create: `apps/payment-provider/src/provider.test.ts`
- Create: `apps/payment-provider/src/main.ts`
- Modify: `package.json` (root — `build` and `test` scripts)

**Interfaces:**

- Consumes: `chargeRequestSchema`, `ChargeResponse`, `PaymentScenario`, `IDEMPOTENCY_KEY_HEADER`, `PAYMENT_SCENARIO_HEADER`, `IDEMPOTENT_REPLAY_HEADER` from Task 1.
- Produces:
  - `interface ScenarioWeights { success: number; decline: number; error: number; timeout: number }`
  - `pickScenario(header: string | undefined, weights: ScenarioWeights, random: () => number): PaymentScenario`
  - `class IdempotencyStore` with `get(key): StoredCharge | undefined` and `set(key, value): void`
  - `buildProvider(options: ProviderOptions): FastifyInstance` where `ProviderOptions = { weights: ScenarioWeights; hangMs: number; random?: () => number }`

**A note on relative imports.** This workspace writes them **without** a file
extension (`./scenario`, not `./scenario.js`), matching `apps/api`. Under
`moduleResolution: node10` TypeScript does not map `.js` back to `.ts`, and
Task 7 imports this source directly from the API's Jest process, whose resolver
would fail the same way. `packages/contracts` uses `.js` extensions because it
is an ESM package resolved with `Bundler`; this one is not.

**A note on dependencies.** `fastify` becomes a declared dependency of this new workspace. That is not a new package in the tree — it is already installed, hoisted from `@nestjs/platform-fastify` — so `npm install` adds no download and the Global Constraint holds. Declare it explicitly anyway: a workspace that imports a package it does not declare breaks the moment hoisting changes.

- [ ] **Step 1: Create the workspace manifest**

Create `apps/payment-provider/package.json`:

```json
{
  "name": "@cinema/payment-provider",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@cinema/contracts": "*",
    "fastify": "^5.6.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "typescript": "~6.0.3",
    "vitest": "^4.1.11"
  }
}
```

Create `apps/payment-provider/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "commonjs",
    "moduleResolution": "node10",
    // TypeScript 6 deprecates node10 resolution as TS5107. apps/api carries the
    // same suppression for the same reason: this is a CommonJS app, and node16
    // would change how every dependency resolves.
    "ignoreDeprecations": "6.0",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

Create `apps/payment-provider/tsconfig.build.json` — the build must not emit
tests into `dist`, but `typecheck` must still cover them, because vitest
transpiles without type-checking and nothing else would catch a type error in a
test file:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts"]
}
```

Create `apps/payment-provider/vitest.config.ts`, matching `packages/contracts`':

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

- [ ] **Step 2: Install and confirm nothing new is downloaded**

```bash
npm install
git diff --stat package-lock.json
```

Expected: `package-lock.json` gains the workspace entry and its links. If npm reports downloading a new version of `fastify`, pin the version already in the lockfile instead (`node -e "console.log(require('fastify/package.json').version)"`).

- [ ] **Step 3: Write the failing scenario test**

Create `apps/payment-provider/src/scenario.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { pickScenario, type ScenarioWeights } from './scenario';

const weights: ScenarioWeights = { success: 0.85, decline: 0.1, error: 0.03, timeout: 0.02 };

describe('pickScenario', () => {
  it('obeys the header when one is given', () => {
    // Determinism for tests comes from here and nowhere else: a suite that had
    // to coax an outcome out of a random provider would be a flaky suite.
    expect(pickScenario('timeout', weights, () => 0)).toBe('timeout');
    expect(pickScenario('decline', weights, () => 0)).toBe('decline');
  });

  it('ignores a header it does not recognise and rolls instead', () => {
    expect(pickScenario('sideways', weights, () => 0)).toBe('success');
  });

  it('maps the unit interval onto the weights in order', () => {
    expect(pickScenario(undefined, weights, () => 0)).toBe('success');
    expect(pickScenario(undefined, weights, () => 0.849)).toBe('success');
    expect(pickScenario(undefined, weights, () => 0.851)).toBe('decline');
    expect(pickScenario(undefined, weights, () => 0.951)).toBe('error');
    expect(pickScenario(undefined, weights, () => 0.985)).toBe('timeout');
  });

  it('returns success when the roll lands past the last boundary', () => {
    // Weights that do not sum to one are a configuration mistake, not a reason
    // to return undefined into a switch statement.
    expect(pickScenario(undefined, { success: 0.1, decline: 0, error: 0, timeout: 0 }, () => 0.9)).toBe(
      'success',
    );
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

```bash
npm run test -w @cinema/payment-provider
```

Expected: FAIL — `Cannot find module './scenario.js'`.

- [ ] **Step 5: Write the scenario picker**

Create `apps/payment-provider/src/scenario.ts`:

```ts
import { paymentScenarioSchema, type PaymentScenario } from '@cinema/contracts';

export interface ScenarioWeights {
  success: number;
  decline: number;
  error: number;
  timeout: number;
}

/**
 * The header wins; without it the weights decide.
 *
 * Tests name a scenario and get an exact outcome. The compose stack leaves the
 * header off and gets a realistic mix, which is what makes the demonstration
 * worth watching -- a provider that always succeeds proves nothing about a
 * retry ladder.
 */
export function pickScenario(
  header: string | undefined,
  weights: ScenarioWeights,
  random: () => number,
): PaymentScenario {
  const named = paymentScenarioSchema.safeParse(header);
  if (named.success) return named.data;

  const roll = random();
  const order: [PaymentScenario, number][] = [
    ['success', weights.success],
    ['decline', weights.decline],
    ['error', weights.error],
    ['timeout', weights.timeout],
  ];

  let boundary = 0;
  for (const [scenario, weight] of order) {
    boundary += weight;
    if (roll < boundary) return scenario;
  }
  // Weights that do not sum to 1 are a misconfiguration; charging is the
  // least surprising thing to do about it.
  return 'success';
}
```

- [ ] **Step 6: Write the store**

Create `apps/payment-provider/src/store.ts`:

```ts
export interface StoredCharge {
  status: number;
  body: unknown;
}

/**
 * The whole of the provider's idempotency: a key to the answer it was given.
 *
 * In memory on purpose. Restarting this process is restarting the bank, not
 * losing our reservation, and the tests that prove a replay run against one
 * instance. A real provider's version of this is a database row; the mechanism
 * being demonstrated is identical.
 */
export class IdempotencyStore {
  private readonly answers = new Map<string, StoredCharge>();

  get(key: string): StoredCharge | undefined {
    return this.answers.get(key);
  }

  set(key: string, value: StoredCharge): void {
    this.answers.set(key, value);
  }

  get size(): number {
    return this.answers.size;
  }
}
```

- [ ] **Step 7: Write the failing provider test**

Create `apps/payment-provider/src/provider.test.ts`:

```ts
import { IDEMPOTENT_REPLAY_HEADER } from '@cinema/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildProvider } from './provider';

const weights = { success: 1, decline: 0, error: 0, timeout: 0 };
const reference = '00000000-0000-7000-8000-000000000001';

describe('the fake provider', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  const charge = (key: string, scenario?: string) =>
    app.inject({
      method: 'POST',
      url: '/charge',
      headers: {
        'idempotency-key': key,
        ...(scenario ? { 'x-payment-scenario': scenario } : {}),
      },
      payload: { amountCents: 4_500, reference },
    });

  it('charges and returns a provider reference', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    const response = await charge('key-1', 'success');

    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; providerRef: string };
    expect(body.status).toBe('SUCCEEDED');
    expect(body.providerRef).toMatch(/^ch_/);
  });

  it('declines without erroring', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    const response = await charge('key-2', 'decline');

    // 200, not 402: a decline is an answer, and the client must be able to tell
    // it apart from a downstream that could not answer at all.
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe('DECLINED');
  });

  it('answers 500 for the error scenario', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    expect((await charge('key-3', 'error')).statusCode).toBe(500);
  });

  it('replays a stored answer for a repeated key without charging again', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    const first = await charge('key-4', 'success');
    const second = await charge('key-4', 'decline');

    // The second call names a DIFFERENT scenario and is ignored: once a key has
    // an answer, that answer is what the key means.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
    expect(first.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
  });

  it('stores the answer BEFORE hanging, so a lost response is recoverable', async () => {
    app = buildProvider({ weights, hangMs: 30_000 });

    // Fire the hanging request and do not await it: this is the client whose
    // response goes missing. The charge has happened; only the answer is lost.
    const hanging = charge('key-5', 'timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const retry = await charge('key-5');
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { status: string }).status).toBe('SUCCEEDED');
    expect(retry.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');

    // This assertion is the point of the whole sub-project: the retry replayed
    // rather than charged. A provider that recorded its answer only on the way
    // out would charge twice here and no test would notice (spec.md section 11).
    //
    // The hanging inject is settled here so closing the app in afterEach cannot
    // surface it as an unhandled rejection blamed on a later test.
    hanging.catch(() => undefined);
  });

  it('rejects a charge with no idempotency key', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    const response = await app.inject({
      method: 'POST',
      url: '/charge',
      payload: { amountCents: 4_500, reference },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed body', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    const response = await app.inject({
      method: 'POST',
      url: '/charge',
      headers: { 'idempotency-key': 'key-6' },
      payload: { amountCents: -1, reference: 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers /health', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 8: Run it and watch it fail**

```bash
npm run test -w @cinema/payment-provider
```

Expected: FAIL — `Cannot find module './provider.js'`.

- [ ] **Step 9: Write the provider**

Create `apps/payment-provider/src/provider.ts`:

```ts
import { randomUUID } from 'node:crypto';

import {
  chargeRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  PAYMENT_SCENARIO_HEADER,
  type ChargeResponse,
} from '@cinema/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

import { pickScenario, type ScenarioWeights } from './scenario';
import { IdempotencyStore } from './store';

export interface ProviderOptions {
  weights: ScenarioWeights;
  /** How long the `timeout` scenario withholds its answer. */
  hangMs: number;
  random?: () => number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function buildProvider(options: ProviderOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = new IdempotencyStore();
  const random = options.random ?? Math.random;

  app.get('/health', () => ({ status: 'ok', charges: store.size }));

  app.post('/charge', async (request, reply) => {
    const key = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (typeof key !== 'string' || key.length === 0) {
      // A charge with no key cannot be made safe to retry, so it is refused
      // rather than made once and hoped about.
      return reply.code(400).send({ error: 'idempotency-key is required' });
    }

    const replay = store.get(key);
    if (replay) {
      return reply.code(replay.status).header(IDEMPOTENT_REPLAY_HEADER, 'true').send(replay.body);
    }

    const body = chargeRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid charge request' });
    }

    const scenario = pickScenario(
      request.headers[PAYMENT_SCENARIO_HEADER] as string | undefined,
      options.weights,
      random,
    );

    if (scenario === 'error') {
      // Deliberately NOT stored. A 500 is the absence of an outcome, so a retry
      // must genuinely retry -- storing it would turn one blip into a permanent
      // failure for that key.
      return reply.code(500).send({ error: 'provider unavailable' });
    }

    if (scenario === 'decline') {
      const declined: ChargeResponse = { status: 'DECLINED', declineReason: 'insufficient-funds' };
      store.set(key, { status: 200, body: declined });
      return reply.code(200).send(declined);
    }

    const succeeded: ChargeResponse = {
      status: 'SUCCEEDED',
      providerRef: `ch_${randomUUID()}`,
      amountCents: body.data.amountCents,
    };

    // Stored BEFORE the answer is sent, and before the hang. This is the entire
    // point of the timeout scenario: the money moves when the decision is made,
    // not when the client hears about it. A provider that recorded its answer
    // on the way out would charge twice on every retried timeout, which is the
    // exact failure spec.md section 11 asks us to make impossible.
    store.set(key, { status: 200, body: succeeded });

    if (scenario === 'timeout') await delay(options.hangMs);

    return reply.code(200).send(succeeded);
  });

  return app;
}
```

Create `apps/payment-provider/src/main.ts`:

```ts
import { buildProvider } from './provider';

const number = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
};

async function main(): Promise<void> {
  const app = buildProvider({
    weights: {
      success: number('PROVIDER_SUCCESS_RATE', 0.85),
      decline: number('PROVIDER_DECLINE_RATE', 0.1),
      error: number('PROVIDER_ERROR_RATE', 0.03),
      timeout: number('PROVIDER_TIMEOUT_RATE', 0.02),
    },
    hangMs: number('PROVIDER_HANG_MS', 30_000),
  });

  const port = number('PORT', 4000);
  // 0.0.0.0, not localhost: inside a container the loopback interface is not
  // reachable from the rest of the compose network.
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`payment provider listening on ${String(port)}`);
}

void main();
```

- [ ] **Step 10: Run the provider tests**

```bash
npm run test -w @cinema/payment-provider
```

Expected: PASS, 12 tests across both files.

- [ ] **Step 11: Wire the workspace into the root scripts**

In the root `package.json`, extend two scripts (the `workspaces` array already globs `apps/*`, and `typecheck` already uses `--workspaces --if-present`, so neither changes):

```json
    "build": "npm run contracts:build && npm run build -w @cinema/api && npm run build -w @cinema/payment-provider && npm run build -w @cinema/web",
    "test": "npm run contracts:build && npm run test -w @cinema/contracts && npm run test -w @cinema/payment-provider && npm run test -w @cinema/api && npm run test -w @cinema/web",
```

The provider's tests run **before** the API's: they need no containers and take under a second, so a mistake in them is reported in seconds rather than after four minutes of Testcontainers.

- [ ] **Step 12: Run the full suite and lint**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green. The API suite is unchanged so far — nothing it imports has moved.

- [ ] **Step 13: Commit**

```bash
git add apps/payment-provider package.json package-lock.json
git commit -m "feat(provider): a fake payment provider as its own service

Fastify, no database, four scenarios. The header names an outcome for
tests; without it the configured weights roll one, so the compose stack
sees realistic mixed traffic.

The idempotency store records its answer BEFORE replying, and before the
timeout scenario hangs. That ordering is the whole demonstration: the
money moves when the decision is made, not when the client hears about
it, so a retried timeout replays instead of charging twice."
```

---

## Task 4: The `payments` table and the state machine

**Files:**

- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0003_payments.sql` (generated, then renamed)
- Modify: `apps/api/drizzle/meta/_journal.json` (by the generator; verify the tag)
- Modify: `apps/api/src/reservations/state-machine.ts`
- Modify: `apps/api/src/reservations/state-machine.test.ts`
- Modify: `apps/api/test/truncate.ts`
- Modify: `apps/api/test/schema.e2e.spec.ts`

**Interfaces:**

- Consumes: `ReservationStatus` from Task 1.
- Produces: the `payments` Drizzle table exported from `schema.ts` and included in the `schema` object; `TRANSITIONS` covering six states.

- [ ] **Step 1: Write the failing state-machine test**

In `apps/api/src/reservations/state-machine.test.ts`, add:

```ts
describe('payment states', () => {
  it('lets a hold start a payment or confirm directly', () => {
    // Both edges are legal in the graph and PAYMENT_MODE picks which one
    // confirm() uses. The graph describes the domain; it does not read the
    // environment.
    expect(canTransition('PENDING', 'PAYMENT_PENDING')).toBe(true);
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(true);
  });

  it('lets a payment succeed or fail', () => {
    expect(canTransition('PAYMENT_PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransition('PAYMENT_PENDING', 'PAYMENT_FAILED')).toBe(true);
  });

  it('will not expire or cancel a reservation that is paying', () => {
    // "The payment owns the row", expressed where it is enforced rather than
    // in a comment. A hold whose money may already have moved is not the
    // user's to take back and not the sweeper's to reclaim.
    expect(canTransition('PAYMENT_PENDING', 'EXPIRED')).toBe(false);
    expect(canTransition('PAYMENT_PENDING', 'CANCELLED')).toBe(false);
  });

  it('treats PAYMENT_FAILED as terminal', () => {
    expect(TERMINAL_STATUSES.has('PAYMENT_FAILED')).toBe(true);
    expect(canTransition('PAYMENT_FAILED', 'PENDING')).toBe(false);
    expect(canTransition('PAYMENT_FAILED', 'PAYMENT_PENDING')).toBe(false);
  });

  it('leaves PAYMENT_PENDING out of the terminal set', () => {
    expect(TERMINAL_STATUSES.has('PAYMENT_PENDING')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx jest src/reservations/state-machine.test.ts
```

Expected: FAIL — `canTransition('PENDING','PAYMENT_PENDING')` is `false`.

- [ ] **Step 3: Extend the graph**

In `apps/api/src/reservations/state-machine.ts`, replace `TRANSITIONS`:

```ts
/**
 * The graph of legal transitions, in one place. The database's CHECK constraint
 * guards the set of values; this guards the edges between them. Splitting the
 * two is deliberate — SQL expresses the first well and the second badly.
 *
 * `PENDING` lists both `PAYMENT_PENDING` and `CONFIRMED`: which edge a confirm
 * uses is decided by `PAYMENT_MODE`, in the service. This module takes no
 * configuration, because a transition table with two shapes depending on the
 * environment is no longer a statement about the domain.
 *
 * `PAYMENT_PENDING` has no edge to `EXPIRED` or `CANCELLED`, and that absence is
 * the design: once a charge may have been made, the row belongs to the payment
 * (ADR 0036). A hold that is paying ends by succeeding or failing, never by
 * running out of time.
 */
const TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  PENDING: ['PAYMENT_PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'],
  PAYMENT_PENDING: ['CONFIRMED', 'PAYMENT_FAILED'],
  CONFIRMED: [],
  PAYMENT_FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};
```

- [ ] **Step 4: Run the test**

```bash
cd apps/api && npx jest src/reservations/state-machine.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the table to the schema**

In `apps/api/src/db/schema.ts`, extend the reservations CHECK constraint:

```ts
    check(
      'reservations_status_check',
      sql`${t.status} IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED')`,
    ),
```

Then add the table after `reservationSeats`:

```ts
export const payments = pgTable(
  'payments',
  {
    id: primaryId(),
    /**
     * UNIQUE, and that is the structural half of idempotency. Five concurrent
     * confirms already serialise on the reservation's FOR UPDATE; this index
     * makes a second payment impossible even if that lock were ever wrong. The
     * same move as `reservation_seats_active_uq`: the invariant lives in the
     * schema, not in the code that respects it (ADR 0009, ADR 0035).
     */
    reservationId: uuid('reservation_id')
      .notNull()
      .unique()
      .references(() => reservations.id),
    status: text('status').notNull(),
    /**
     * Copied from the reservation when the payment starts. Not denormalised for
     * speed: this is the sum the provider was asked for, and it must survive any
     * later change to the reservation.
     */
    amountCents: integer('amount_cents').notNull(),
    /** NULL until the provider answers. The first thing a human reading the DLQ wants. */
    providerRef: text('provider_ref'),
    /**
     * Calls made to the provider, replays included. Not a duplicate of the
     * `x-attempt` header: that lives in the message and dies with it.
     */
    attempts: integer('attempts').notNull().default(0),
    /** Fake-provider passthrough; NULL in ordinary use. Stored so retry N sends what attempt 1 sent. */
    scenario: text('scenario'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'payments_status_check',
      sql`${t.status} IN ('PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED')`,
    ),
    /** The reaper's predicate: pending payments, oldest first. */
    index('payments_pending_created_idx').on(t.status, t.createdAt),
  ],
);
```

Add `payments` to the exported `schema` object.

- [ ] **Step 6: Generate the migration**

```bash
npm run db:generate -w @cinema/api
```

drizzle-kit writes `apps/api/drizzle/0003_<random-name>.sql` and appends an entry to `meta/_journal.json`.

- [ ] **Step 7: Rename it to match the house convention**

```bash
cd apps/api/drizzle
mv 0003_*.sql 0003_payments.sql
```

Then edit `meta/_journal.json` so the `idx: 3` entry reads `"tag": "0003_payments"`. Leave its `when` value alone. Confirm:

```bash
cat meta/_journal.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).entries.map(e=>e.tag)))"
```

Expected: `[ '0000_tiny_abomination', '0001_showtime_overlap', '0002_reservations', '0003_payments' ]`

- [ ] **Step 8: Read the generated SQL and check two things**

```bash
cat apps/api/drizzle/0003_payments.sql
```

It must contain `CREATE TABLE "payments"`, a `payments_reservation_id_unique` constraint, and **both** halves of the reservations check-constraint change — a `DROP CONSTRAINT "reservations_status_check"` followed by an `ADD CONSTRAINT` naming all six statuses. If the drop is missing, add it by hand above the add; a stale check constraint rejects every `PAYMENT_PENDING` write with a `23514` at runtime, and the failure appears as a mysterious 500 on confirm.

- [ ] **Step 9: Extend the test reset**

In `apps/api/test/truncate.ts`, add `payments` to the truncated tables. It must be listed **before** `reservations` or with `CASCADE`, because of the foreign key. If the file truncates with a single statement, the fix is one word:

```ts
  await db.execute(sql`TRUNCATE payments, reservation_seats, reservations RESTART IDENTITY CASCADE`);
```

- [ ] **Step 10: Assert the invariant at the database level**

In `apps/api/test/schema.e2e.spec.ts`, add:

```ts
  it('refuses a second payment for the same reservation', async () => {
    const reservation = await h.holdOne(h.seatIds[0]!);

    await db.execute(sql`
      INSERT INTO payments (reservation_id, status, amount_cents)
      VALUES (${reservation.id}, 'PENDING', 4500)
    `);

    // The application never tries this -- the row lock stops it long before.
    // The index exists so that a bug in that lock is a constraint violation
    // rather than a second charge.
    await expect(
      db.execute(sql`
        INSERT INTO payments (reservation_id, status, amount_cents)
        VALUES (${reservation.id}, 'PENDING', 4500)
      `),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it('refuses a payment status outside the four', async () => {
    const reservation = await h.holdOne(h.seatIds[1]!);
    await expect(
      db.execute(sql`
        INSERT INTO payments (reservation_id, status, amount_cents)
        VALUES (${reservation.id}, 'REFUNDED', 4500)
      `),
    ).rejects.toThrow(/payments_status_check/);
  });

  it('accepts the two new reservation statuses', async () => {
    const reservation = await h.holdOne(h.seatIds[2]!);
    await expect(
      db.execute(sql`UPDATE reservations SET status = 'PAYMENT_PENDING' WHERE id = ${reservation.id}`),
    ).resolves.toBeDefined();
    await expect(
      db.execute(sql`UPDATE reservations SET status = 'PAYMENT_FAILED' WHERE id = ${reservation.id}`),
    ).resolves.toBeDefined();
  });
```

Match the surrounding file's harness variable names — if it builds its own harness in `beforeAll`, use that one rather than introducing a second.

- [ ] **Step 11: Run the affected suites**

```bash
cd apps/api && npx jest test/schema.e2e.spec.ts src/reservations/state-machine.test.ts
```

Expected: PASS. The migration runs inside `startTestDatabase`, so the new table exists automatically.

- [ ] **Step 12: Run everything**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green. Nothing yet writes a `payments` row or a `PAYMENT_PENDING` status, so phases 1–4 are untouched.

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/db apps/api/drizzle apps/api/src/reservations apps/api/test
git commit -m "feat(api): the payments table and two new reservation states

payments.reservation_id is UNIQUE, which is the structural half of
idempotency: the row lock already serialises concurrent confirms, and the
index makes a second payment impossible if that lock is ever wrong.

PAYMENT_PENDING has no edge to EXPIRED or CANCELLED. That absence is the
design — once a charge may have been made the row belongs to the payment,
and a paying hold ends by succeeding or failing, never by running out of
time (ADR 0036)."
```

---

## Task 5: The topology and the generalised retry ladder

Two messages now climb ladders, so `nextHop` stops knowing which one it is climbing.

**Files:**

- Modify: `apps/api/src/messaging/retry.ts`
- Modify: `apps/api/src/messaging/retry.test.ts`
- Modify: `apps/api/src/messaging/topology.ts`
- Modify: `apps/api/src/worker/expire.consumer.ts` (one call site)
- Modify: `apps/api/test/rabbit-harness.ts` (`deleteTopology` must delete the payment queues too)
- Modify: `apps/api/test/topology.e2e.spec.ts`

**Interfaces:**

- Consumes: `Ladder`, `EXPIRE_LADDER`, `PAYMENT_LADDER`, `PAYMENT_QUEUE`, `PAYMENT_DLQ`, `paymentRetryQueue`, `paymentRetryKey` from Task 1.
- Produces: `nextHop(attempt: number, retryDelaysMs: number[], ladder: Ladder): NextHop` — the third parameter is **required**, so every call site is forced to say which ladder it means.

- [ ] **Step 1: Write the failing retry test**

In `apps/api/src/messaging/retry.test.ts`, add:

```ts
describe('nextHop across two ladders', () => {
  const delays = [5_000, 30_000, 120_000];

  it('climbs the expire ladder as before', () => {
    expect(nextHop(0, delays, EXPIRE_LADDER)).toEqual({
      routingKey: 'reservation.expire.retry.1',
      attempt: 1,
      dead: false,
    });
    expect(nextHop(3, delays, EXPIRE_LADDER)).toEqual({
      routingKey: 'reservation.expire.dead',
      attempt: 4,
      dead: true,
    });
  });

  it('climbs the payment ladder with the same arithmetic', () => {
    expect(nextHop(0, delays, PAYMENT_LADDER)).toEqual({
      routingKey: 'payment.requested.retry.1',
      attempt: 1,
      dead: false,
    });
    expect(nextHop(2, delays, PAYMENT_LADDER)).toEqual({
      routingKey: 'payment.requested.retry.3',
      attempt: 3,
      dead: false,
    });
    expect(nextHop(3, delays, PAYMENT_LADDER)).toEqual({
      routingKey: 'payment.requested.dead',
      attempt: 4,
      dead: true,
    });
  });

  it('shares one ladder length, so both subsystems retry the same number of times', () => {
    // RABBITMQ_RETRY_DELAYS_MS drives both. One knob, and the two topologies
    // cannot drift into different shapes by accident.
    expect(nextHop(1, [5_000], EXPIRE_LADDER).dead).toBe(true);
    expect(nextHop(1, [5_000], PAYMENT_LADDER).dead).toBe(true);
  });
});
```

Extend the file's import to include `EXPIRE_LADDER` and `PAYMENT_LADDER`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx jest src/messaging/retry.test.ts
```

Expected: FAIL — `nextHop` takes two parameters and returns expire keys regardless.

- [ ] **Step 3: Generalise `nextHop`**

Rewrite `apps/api/src/messaging/retry.ts`'s import and function:

```ts
import { ATTEMPT_HEADER, type Ladder } from './messages';
```

```ts
/**
 * `x-attempt` is the number of failed handlings *so far*: the producer publishes
 * 0, and a handler that fails on n republishes with n + 1 into tier n + 1. With
 * three tiers the handler runs at most four times (spec §3).
 *
 * The ladder is a parameter rather than a default, and deliberately has no
 * default value: two messages climb ladders now, and a call site that forgot to
 * say which one would silently dead-letter a payment into the expiry DLQ.
 */
export function nextHop(attempt: number, retryDelaysMs: number[], ladder: Ladder): NextHop {
  const next = attempt + 1;

  if (next > retryDelaysMs.length) {
    return { routingKey: ladder.deadKey, attempt: next, dead: true };
  }
  return { routingKey: ladder.retryKey(next), attempt: next, dead: false };
}
```

Delete the now-unused `EXPIRE_DEAD_KEY` and `retryKey` imports.

- [ ] **Step 4: Fix the one existing call site**

In `apps/api/src/worker/expire.consumer.ts`, the call inside `handle`'s catch becomes:

```ts
        const hop = nextHop(attempt, this.configService.config.rabbitmqRetryDelaysMs, EXPIRE_LADDER);
```

Add `EXPIRE_LADDER` to the import from `../messaging/messages`.

- [ ] **Step 5: Run the messaging and expire suites**

```bash
cd apps/api && npx jest src/messaging/ && npx jest test/expire-retry.e2e.spec.ts
```

Expected: PASS. Phase 4's behaviour is unchanged — only the signature moved.

- [ ] **Step 6: Write the failing topology test**

In `apps/api/test/topology.e2e.spec.ts`, add:

```ts
  it('declares the payment queues on the same exchange', async () => {
    await assertTopology(channel, { reservationTtlSeconds: 60, retryDelaysMs: [5_000, 30_000] });

    await expect(channel.checkQueue(PAYMENT_QUEUE)).resolves.toMatchObject({ queue: PAYMENT_QUEUE });
    await expect(channel.checkQueue(PAYMENT_DLQ)).resolves.toMatchObject({ queue: PAYMENT_DLQ });
    await expect(channel.checkQueue(paymentRetryQueue(1))).resolves.toBeDefined();
    await expect(channel.checkQueue(paymentRetryQueue(2))).resolves.toBeDefined();
  });

  it('gives the payment queue no TTL, because a charge is due immediately', async () => {
    await assertTopology(channel, { reservationTtlSeconds: 60, retryDelaysMs: [5_000] });

    // Re-declaring with the arguments we believe it has is the only way to
    // read them back: a mismatch is PRECONDITION_FAILED. If someone gives this
    // queue a TTL or a dead-letter exchange, this assertion is what says so.
    const probe = await connection.createChannel();
    probe.on('error', () => {});
    await expect(probe.assertQueue(PAYMENT_QUEUE, { durable: true })).resolves.toBeDefined();
    await probe.close();
  });

  it('routes a payment message to the payment queue and not the expire queue', async () => {
    await assertTopology(channel, { reservationTtlSeconds: 60, retryDelaysMs: [5_000] });

    channel.publish(COMMANDS_EXCHANGE, PAYMENT_KEY, Buffer.from('{"paymentId":"x"}'), {
      persistent: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await queueDepth(channel, PAYMENT_QUEUE)).toBe(1);
    // A direct exchange with two exact keys: the shared exchange must not have
    // turned into a fan-out by accident.
    expect(await queueDepth(channel, EXPIRE_QUEUE)).toBe(0);
  });
```

Extend the imports to include `PAYMENT_QUEUE`, `PAYMENT_DLQ`, `PAYMENT_KEY`, `paymentRetryQueue`, `EXPIRE_QUEUE`, `COMMANDS_EXCHANGE` and `queueDepth`, matching what the file already imports.

- [ ] **Step 7: Run it and watch it fail**

```bash
cd apps/api && npx jest test/topology.e2e.spec.ts
```

Expected: FAIL — `checkQueue` rejects with `NOT_FOUND - no queue 'payment.requested'`.

- [ ] **Step 8: Declare the payment queues**

Append to `assertTopology` in `apps/api/src/messaging/topology.ts`, before the closing brace:

```ts
  // The payment side of the exchange. Same ladder shape, and deliberately NO
  // wait queue: expiry needed a delay before it acted, a charge does not.
  await channel.assertQueue(PAYMENT_QUEUE, { durable: true });
  await channel.bindQueue(PAYMENT_QUEUE, COMMANDS_EXCHANGE, PAYMENT_KEY);

  for (const [index, delay] of options.retryDelaysMs.entries()) {
    const tier = index + 1;
    await channel.assertQueue(paymentRetryQueue(tier), {
      durable: true,
      messageTtl: delay,
      deadLetterExchange: COMMANDS_EXCHANGE,
      deadLetterRoutingKey: PAYMENT_KEY,
    });
    await channel.bindQueue(paymentRetryQueue(tier), COMMANDS_EXCHANGE, paymentRetryKey(tier));
  }

  await channel.assertQueue(PAYMENT_DLQ, { durable: true });
  await channel.bindQueue(PAYMENT_DLQ, COMMANDS_EXCHANGE, PAYMENT_DEAD_KEY);
```

Extend the import from `./messages` with `PAYMENT_DEAD_KEY`, `PAYMENT_DLQ`, `PAYMENT_KEY`, `PAYMENT_QUEUE`, `paymentRetryKey` and `paymentRetryQueue`.

Note the two ladders share `options.retryDelaysMs`, so they always have the same number of tiers — the property Step 1's third test pins down.

- [ ] **Step 9: Teach the test harness to delete the new queues**

In `apps/api/test/rabbit-harness.ts`, extend `deleteTopology`:

```ts
export async function deleteTopology(connection: ChannelModel, tiers: number): Promise<void> {
  const queues = [EXPIRE_WAIT_QUEUE, EXPIRE_QUEUE, EXPIRE_DLQ, PAYMENT_QUEUE, PAYMENT_DLQ];
  for (let tier = 1; tier <= tiers; tier += 1) {
    queues.push(retryQueue(tier));
    queues.push(paymentRetryQueue(tier));
  }
  // ... rest unchanged
```

Extend its imports with `PAYMENT_DLQ`, `PAYMENT_QUEUE` and `paymentRetryQueue`.

This matters more than it looks: suites declare the retry tiers with millisecond TTLs instead of production's minutes, and a payment retry queue left behind by an earlier suite makes the next `assertTopology` fail with a 406 that kills the channel — surfacing as an unrelated failure in whichever suite happens to run next.

- [ ] **Step 10: Run the topology suite**

```bash
cd apps/api && npx jest test/topology.e2e.spec.ts
```

Expected: PASS.

- [ ] **Step 11: Run everything**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/messaging apps/api/src/worker apps/api/test
git commit -m "feat(api): declare the payment ladder and generalise nextHop

Two messages climb ladders now, so nextHop takes the ladder as a required
third parameter — no default, because a call site that forgot which one it
meant would dead-letter a payment into the expiry DLQ.

The payment queue has no wait queue and no TTL: expiry needed a delay
before it acted, a charge does not. Both ladders read the same
RABBITMQ_RETRY_DELAYS_MS, so they cannot drift into different shapes."
```

---

## Task 6: Publishing before the commit — confirm becomes `202`

The one place in this codebase where a message is published inside a transaction, and the reasoning that makes it correct.

**Files:**

- Create: `apps/api/src/messaging/payment.publisher.ts`
- Modify: `apps/api/src/messaging/messaging.module.ts`
- Modify: `apps/api/src/http/errors.ts`
- Modify: `apps/api/src/reservations/reservation.service.ts`
- Modify: `apps/api/src/reservations/reservation.controller.ts`
- Create: `apps/api/test/payment-harness.ts`
- Create: `apps/api/test/payment-begin.e2e.spec.ts`

**Interfaces:**

- Consumes: `PAYMENT_KEY`, `COMMANDS_EXCHANGE`, `ATTEMPT_HEADER` (Task 1); `payments` table (Task 4); `canTransition` (Task 4).
- Produces:
  - `class PaymentPublisher` with `publishPayment(paymentId: string): Promise<void>` — **throws** `PaymentUnavailableError` on any failure
  - `class PaymentUnavailableError extends DomainError` (503, slug `payment-unavailable`)
  - `class PaymentInFlightError extends DomainError` (409, slug `payment-in-flight`)
  - `ReservationService.confirm(sessionId, id, scenario?): Promise<{ reservation: Reservation; paying: boolean }>`
  - `startPaymentHarness(options): Promise<PaymentHarness>` in `payment-harness.ts`

- [ ] **Step 1: Write the two errors**

Append to `apps/api/src/http/errors.ts`:

```ts
/**
 * The broker would not take the payment message, so the transaction that would
 * have started the payment was rolled back. The hold is untouched and still
 * PENDING, which is why this is a 503 the caller may retry rather than a 500.
 */
export class PaymentUnavailableError extends DomainError {
  readonly status = 503;
  readonly typeSlug = 'payment-unavailable';
  readonly title = 'Payment cannot be started right now';

  constructor(reservationId: string) {
    super(`Payment for reservation ${reservationId} could not be started; the hold is unchanged`);
  }
}

/**
 * Cancelling a reservation whose money may already be moving. Distinct from
 * InvalidStateTransitionError, which would also be a 409 here: this one names
 * the actual reason, and a client can act on it (wait, then re-read).
 */
export class PaymentInFlightError extends DomainError {
  readonly status = 409;
  readonly typeSlug = 'payment-in-flight';
  readonly title = 'Payment in flight';

  constructor(reservationId: string) {
    super(`Reservation ${reservationId} is being paid for and cannot be changed until it settles`);
  }
}
```

- [ ] **Step 2: Write the publisher**

Create `apps/api/src/messaging/payment.publisher.ts`:

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
import { PaymentUnavailableError } from '../http/errors';
import { currentRequestId } from '../observability/request-context';
import { ATTEMPT_HEADER, COMMANDS_EXCHANGE, PAYMENT_KEY } from './messages';
import { RABBIT, type RabbitConnection } from './rabbit.module';

/**
 * The sibling of ExpirePublisher, with the opposite failure policy — and the
 * asymmetry is the design, not an oversight.
 *
 * `publishExpire` runs after the commit and swallows everything, because lazy
 * expiry returns the seat whether or not the message ever arrives. This message
 * has no such backstop: a lost `payment.requested` leaves a reservation in
 * PAYMENT_PENDING with no process anywhere that knows about it. So this one is
 * published INSIDE the reservation's transaction and throws, which aborts it.
 *
 * That ordering is safe in exactly one direction, and that inequality is the
 * whole argument (ADR 0037):
 *
 *   published, then rolled back  -> the message names a payments row that does
 *                                   not exist; the consumer's first rule drops
 *                                   it. Cost: one wasted message.
 *   committed, then publish lost -> a hold nobody will ever settle. Cost: seats.
 *
 * The price is a broker round trip (bounded by RABBITMQ_PUBLISH_TIMEOUT_MS)
 * held under one row lock. One row, not a range, and bounded above — which is
 * also precisely the seam a transactional outbox replaces later.
 */
@Injectable()
export class PaymentPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentPublisher.name);
  private channel: ConfirmChannel | null = null;

  constructor(
    @Inject(RABBIT) private readonly connection: RabbitConnection,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.connection) return;
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
      channel.on('return', (message) =>
        this.logger.error(`payment message returned unroutable: ${String(message.properties.messageId)}`),
      );
      channel.on('error', (error: Error) =>
        this.logger.warn(`payment publish channel error: ${error.message}`),
      );
      this.channel = channel;
    } catch (error) {
      this.logger.warn(`could not open a payment publish channel: ${String(error)}`);
    }
  }

  /**
   * Called inside the reservation's transaction. Throws rather than warning:
   * the caller's rollback is what keeps the hold consistent.
   */
  async publishPayment(paymentId: string): Promise<void> {
    const channel = this.channel;
    if (!channel) throw new PaymentUnavailableError(paymentId);

    const body = Buffer.from(JSON.stringify({ paymentId }), 'utf8');
    const options = {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId: paymentId,
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

        channel.publish(COMMANDS_EXCHANGE, PAYMENT_KEY, body, options, (error) => {
          clearTimeout(timer);
          if (error) reject(error instanceof Error ? error : new Error(String(error)));
          else resolve();
        });
      });
    } catch (error) {
      this.logger.error(`publishing payment.requested for ${paymentId} failed: ${String(error)}`);
      throw new PaymentUnavailableError(paymentId);
    }
  }
}
```

Register it in `apps/api/src/messaging/messaging.module.ts`:

```ts
@Module({
  imports: [RabbitModule],
  providers: [ExpirePublisher, PaymentPublisher],
  exports: [ExpirePublisher, PaymentPublisher],
})
export class MessagingModule {}
```

- [ ] **Step 3: Write the payment test harness**

Create `apps/api/test/payment-harness.ts`:

```ts
import { sql } from 'drizzle-orm';

import type { Database } from '../src/db/drizzle.module';

export interface PaymentRow {
  id: string;
  reservationId: string;
  status: string;
  amountCents: number;
  providerRef: string | null;
  attempts: number;
  scenario: string | null;
  settledAt: string | null;
}

/** The payment for a reservation, or null. Read as raw SQL to stay honest about NULLs. */
export async function paymentFor(db: Database, reservationId: string): Promise<PaymentRow | null> {
  const result = await db.execute<PaymentRow>(sql`
    SELECT id, reservation_id AS "reservationId", status, amount_cents AS "amountCents",
           provider_ref AS "providerRef", attempts, scenario, settled_at AS "settledAt"
    FROM payments WHERE reservation_id = ${reservationId}
  `);
  return result.rows[0] ?? null;
}

export async function paymentById(db: Database, paymentId: string): Promise<PaymentRow | null> {
  const result = await db.execute<PaymentRow>(sql`
    SELECT id, reservation_id AS "reservationId", status, amount_cents AS "amountCents",
           provider_ref AS "providerRef", attempts, scenario, settled_at AS "settledAt"
    FROM payments WHERE id = ${paymentId}
  `);
  return result.rows[0] ?? null;
}

export async function reservationStatus(db: Database, reservationId: string): Promise<string> {
  const result = await db.execute<{ status: string }>(
    sql`SELECT status FROM reservations WHERE id = ${reservationId}`,
  );
  const row = result.rows[0];
  if (!row) throw new Error(`reservation ${reservationId} is gone`);
  return row.status;
}

export async function activeSeatCount(db: Database, reservationId: string): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM reservation_seats
    WHERE reservation_id = ${reservationId} AND released_at IS NULL
  `);
  return Number(result.rows[0]!.count);
}

/**
 * Ages a payment so the reaper considers it abandoned, without sleeping for
 * PAYMENT_DEADLINE_SECONDS. The column is written directly because no code path
 * moves created_at — which is exactly why it is safe to move it here.
 */
export async function agePayment(db: Database, paymentId: string, seconds: number): Promise<void> {
  await db.execute(sql`
    UPDATE payments SET created_at = now() - make_interval(secs => ${seconds}) WHERE id = ${paymentId}
  `);
}
```

- [ ] **Step 4: Write the failing test**

Create `apps/api/test/payment-begin.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { reservationSchema } from '@cinema/contracts';
import { sql } from 'drizzle-orm';

import {
  COMMANDS_EXCHANGE,
  PAYMENT_QUEUE,
  paymentMessageSchema,
} from '../src/messaging/messages';
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
    const off = await startReservationHarness({ ttlSeconds: 600 });
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
```

- [ ] **Step 5: Add `paymentMode` to the reservation harness**

In `apps/api/test/reservation-harness.ts`, add to `HarnessOptions`:

```ts
  /** Which confirm path the application under test uses. */
  paymentMode?: 'off' | 'queue';
  /** Overrides PAYMENT_PROVIDER_URL. */
  paymentProviderUrl?: string;
```

and to the `overrides` object:

```ts
    PAYMENT_MODE: options.paymentMode,
    PAYMENT_PROVIDER_URL: options.paymentProviderUrl,
```

- [ ] **Step 6: Run it and watch it fail**

```bash
cd apps/api && npx jest test/payment-begin.e2e.spec.ts
```

Expected: FAIL — the first test gets `200` and `CONFIRMED`.

- [ ] **Step 7: Rework `confirm`**

In `apps/api/src/reservations/reservation.service.ts`, add `payments` to the schema import, `PaymentPublisher` to the constructor, and `uuidv7` if not already imported. Replace `confirm`:

```ts
  /**
   * Returns the reservation and whether a payment was started. The caller turns
   * `paying` into 202 rather than 200: the booking is not final yet, and saying
   * so is the difference between a truthful API and one that claims a sale the
   * provider has not agreed to.
   */
  async confirm(
    sessionId: string,
    id: string,
    scenario?: string,
  ): Promise<{ reservation: Reservation; paying: boolean }> {
    const outcome = await this.db.transaction(async (tx) => {
      const row = await this.lockOwned(tx, sessionId, id);

      if (row.status === 'PENDING' && row.expired) {
        return { expired: true as const, released: await this.expire(tx, id) };
      }

      // A replay of a confirm that is already running. Not an error: the caller
      // asked for a payment and a payment is happening. This, plus the row lock
      // above and payments.reservation_id UNIQUE, is the whole of idempotency
      // on this endpoint -- no header, because the path already names the
      // operation (ADR 0035).
      if (row.status === 'PAYMENT_PENDING') {
        return {
          expired: false as const,
          paying: true as const,
          reservation: await this.get(sessionId, id, tx),
          startsAt: null,
        };
      }

      if (this.configService.config.paymentMode !== 'queue') {
        if (!canTransition(row.status, 'CONFIRMED')) {
          throw new InvalidStateTransitionError(row.status, 'CONFIRMED');
        }

        await tx
          .update(reservations)
          .set({ status: 'CONFIRMED', confirmedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(reservations.id, id));

        const reservation = await this.get(sessionId, id, tx);
        const [showtime] = await tx
          .select({ startsAt: showtimes.startsAt })
          .from(showtimes)
          .where(eq(showtimes.id, reservation.showtimeId))
          .limit(1);

        return {
          expired: false as const,
          paying: false as const,
          reservation,
          startsAt: showtime!.startsAt,
        };
      }

      if (!canTransition(row.status, 'PAYMENT_PENDING')) {
        throw new InvalidStateTransitionError(row.status, 'PAYMENT_PENDING');
      }

      await tx
        .update(reservations)
        .set({ status: 'PAYMENT_PENDING', updatedAt: sql`now()` })
        .where(eq(reservations.id, id));

      const [amounts] = await tx
        .select({ totalPriceCents: reservations.totalPriceCents })
        .from(reservations)
        .where(eq(reservations.id, id))
        .limit(1);

      // Minted here, before the insert, because it is the Idempotency-Key the
      // provider will be shown on every attempt (ADR 0035).
      const paymentId = uuidv7();
      await tx.insert(payments).values({
        id: paymentId,
        reservationId: id,
        status: 'PENDING',
        amountCents: amounts!.totalPriceCents,
        scenario: scenario ?? null,
      });

      // INSIDE the transaction, and it throws. See PaymentPublisher's comment
      // and ADR 0037: a message published for a transaction that rolls back is
      // dropped by the consumer, while a lost message strands a hold.
      await this.paymentPublisher.publishPayment(paymentId);

      return {
        expired: false as const,
        paying: true as const,
        reservation: await this.get(sessionId, id, tx),
        startsAt: null,
      };
    });

    if (outcome.expired) {
      await this.releaseLocks(outcome.released);
      throw new ReservationExpiredError(id);
    }

    // Only a finished sale retains its keys. A payment in flight leaves them
    // exactly as the hold left them: still owned, still expiring with the hold.
    if (!outcome.paying) {
      await this.seatLock.retain(
        outcome.reservation.showtimeId,
        outcome.reservation.seats.map((seat) => seat.seatId),
        id,
        outcome.startsAt!,
      );
    }

    return { reservation: outcome.reservation, paying: outcome.paying };
  }
```

- [ ] **Step 8: Refuse to cancel a paying reservation**

In `cancel`, immediately after `const row = await this.lockOwned(tx, sessionId, id);`, add:

```ts
      // The money may already have moved. Answering 409 here rather than
      // letting canTransition do it names the reason, which a client can act on.
      if (row.status === 'PAYMENT_PENDING') throw new PaymentInFlightError(id);
```

Import `PaymentInFlightError` from `../http/errors`.

- [ ] **Step 9: Include the payment in reservation reads**

In `hydrate` — **not** in `get`. `get`, `list` and Task 8's `hydrateById` all
build their `Reservation` through `hydrate`, so attaching the payment anywhere
else would give one caller a payment and the others `undefined` for the same
row. Next to the existing seat query, add a second read:

```ts
    const [payment] = await executor
      .select({
        status: payments.status,
        amountCents: payments.amountCents,
        attempts: payments.attempts,
      })
      .from(payments)
      .where(eq(payments.reservationId, id))
      .limit(1);
```

and include it in the returned object as:

```ts
      payment: payment
        ? {
            status: payment.status as PaymentStatus,
            amountCents: payment.amountCents,
            attempts: payment.attempts,
          }
        : undefined,
```

Import `type PaymentStatus` from `@cinema/contracts`.

- [ ] **Step 10: Give the controller a dynamic status code**

In `apps/api/src/reservations/reservation.controller.ts`:

```ts
  // 200 keeps its phase 2 meaning: the booking is final. 202 means the payment
  // has been accepted for processing and the reservation is not confirmed yet.
  // Answering 200 for both would be the API claiming a sale the provider has
  // not agreed to.
  @Post(':id/confirm')
  @HttpCode(200)
  @Validated(reservationSchema)
  async confirmReservation(
    @SessionId() sessionId: string,
    @Param(zodPipe(idParamSchema)) params: IdParam,
    @Headers(PAYMENT_SCENARIO_HEADER) scenario: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Reservation> {
    const outcome = await this.reservations.confirm(sessionId, params.id, scenario);
    if (outcome.paying) reply.status(202);
    return outcome.reservation;
  }
```

Add `Headers` and `Res` to the `@nestjs/common` import, `PAYMENT_SCENARIO_HEADER` to the contracts import, and `import type { FastifyReply } from 'fastify';`.

- [ ] **Step 11: Run the suite**

```bash
cd apps/api && npx jest test/payment-begin.e2e.spec.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 12: Run everything**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green. Phase 2's confirm tests still pass because `PAYMENT_MODE` defaults to `off`.

- [ ] **Step 13: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): confirm starts a payment and answers 202

The payment message is published INSIDE the reservation's transaction and
the publisher throws, which aborts it. That inverts ADR 0029 on purpose:
expiry has lazy release as a backstop, a payment has none. A message
published for a transaction that then rolls back names a payments row that
does not exist and the consumer drops it; a lost message strands a hold.
The first is cheaper, and the ordering follows from that inequality.

Five concurrent confirms produce one payment row, one message and five
202s. No Idempotency-Key at this boundary: the reservation id in the path
already names the operation."
```

---

## Task 7: The provider client

The one place in the API that speaks HTTP to something it does not control.

**Files:**

- Create: `apps/api/src/payments/payment-provider.client.ts`
- Modify: `apps/api/test/harness.ts`
- Modify: `apps/api/test/global-setup.ts`
- Modify: `apps/api/test/global-teardown.ts`
- Modify: `apps/api/test/setup-after-env.ts`
- Create: `apps/api/test/payment-client.e2e.spec.ts`

**Interfaces:**

- Consumes: `CircuitBreaker`, `CircuitOpenError` (Task 2); `chargeResponseSchema`, `ChargeResponse` (Task 1); the provider from Task 3.
- Produces:
  - `class ProviderUnavailableError extends Error` — thrown for timeout, 5xx, transport failure and unparseable bodies
  - `interface ChargeCommand { paymentId: string; reservationId: string; amountCents: number; scenario: string | null }`
  - `class PaymentProviderClient` with `charge(command: ChargeCommand): Promise<ChargeResponse>` and `get breakerState(): BreakerState`
  - `startTestProvider()` / `getTestProviderUrl()` in `harness.ts`

- [ ] **Step 1: Boot the provider for the test suite**

In `apps/api/test/harness.ts`, add:

```ts
import { buildProvider } from '../../payment-provider/src/provider';

declare global {
  var __PROVIDER__: FastifyInstance | undefined;
}

/**
 * The provider runs in the Jest process on an ephemeral port, not in a
 * container. It is a real socket and a real HTTP hop -- which is the whole
 * argument of ADR 0040 -- but building an image for eight hundred bytes of
 * Fastify would add a minute to every run for nothing.
 *
 * Every scenario the suites use is named by header, so the weights here only
 * decide what an un-headered request gets, and the suites never send one.
 */
export async function startTestProvider(): Promise<FastifyInstance> {
  const app = buildProvider({
    weights: { success: 1, decline: 0, error: 0, timeout: 0 },
    // Longer than any client timeout in the suite, so `timeout` really hangs.
    hangMs: 60_000,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}

export function getTestProviderUrl(): string {
  const url = process.env.PAYMENT_PROVIDER_URL;
  if (!url) throw new Error('PAYMENT_PROVIDER_URL is not set; global setup did not run');
  return url;
}
```

Add `import type { FastifyInstance } from 'fastify';` at the top.

In `apps/api/test/global-setup.ts`, start it alongside the containers and write its URL:

```ts
  const [postgres, redis, rabbit, provider] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
    startTestRabbit(),
    startTestProvider(),
  ]);

  globalThis.__PROVIDER__ = provider;

  const address = provider.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('provider did not bind');
  writeFileSync(`${__dirname}/.provider-url`, `http://127.0.0.1:${String(address.port)}`, 'utf8');
```

In `apps/api/test/global-teardown.ts`, add `await globalThis.__PROVIDER__?.close();` beside the container stops.

In `apps/api/test/setup-after-env.ts`, add:

```ts
process.env.PAYMENT_PROVIDER_URL = readFileSync(`${__dirname}/.provider-url`, 'utf8').trim();
```

Add `.provider-url` to `apps/api/test/.gitignore` if the other URL files are ignored there; check with `git status --porcelain apps/api/test` after the first run.

- [ ] **Step 2: Write the failing client test**

Create `apps/api/test/payment-client.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { ConfigService } from '../src/config/config.service';
import {
  PaymentProviderClient,
  ProviderUnavailableError,
} from '../src/payments/payment-provider.client';
import { CircuitOpenError } from '../src/resilience/circuit-breaker';
import { getTestProviderUrl } from './harness';

describe('PaymentProviderClient', () => {
  const build = (overrides: Record<string, string> = {}): PaymentProviderClient => {
    const restore = new Map<string, string | undefined>();
    const env: Record<string, string> = {
      PAYMENT_MODE: 'queue',
      PAYMENT_PROVIDER_URL: getTestProviderUrl(),
      RABBITMQ_URL: 'amqp://localhost',
      PAYMENT_TIMEOUT_MS: '400',
      PAYMENT_BREAKER_FAILURE_THRESHOLD: '2',
      PAYMENT_BREAKER_OPEN_MS: '200',
      ...overrides,
    };
    for (const [key, value] of Object.entries(env)) {
      restore.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      return new PaymentProviderClient(new ConfigService());
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  const command = (scenario: string | null) => ({
    paymentId: randomUUID(),
    reservationId: randomUUID(),
    amountCents: 4_500,
    scenario,
  });

  it('charges and returns the provider reference', async () => {
    const response = await build().charge(command('success'));
    expect(response).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('returns a decline as a value, not an exception', async () => {
    // This is where "a decline is not a failure" is actually enforced. The
    // breaker counts thrown errors; returning DECLINED means a run of refused
    // cards can never open the circuit.
    const client = build();
    for (let i = 0; i < 5; i += 1) {
      const response = await client.charge(command('decline'));
      expect(response).toMatchObject({ status: 'DECLINED' });
    }
    expect(client.breakerState).toBe('CLOSED');
  });

  it('throws ProviderUnavailableError on a 500', async () => {
    await expect(build().charge(command('error'))).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('throws ProviderUnavailableError when the provider hangs past the timeout', async () => {
    const started = Date.now();
    await expect(build().charge(command('timeout'))).rejects.toBeInstanceOf(ProviderUnavailableError);
    // Bounded by PAYMENT_TIMEOUT_MS, not by the provider's 60s hang: the caller
    // is a worker with a ladder behind it, not a user watching a spinner.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('throws ProviderUnavailableError when the provider is not there at all', async () => {
    const client = build({ PAYMENT_PROVIDER_URL: 'http://127.0.0.1:1' });
    await expect(client.charge(command('success'))).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('opens the circuit after the configured run of failures and stops calling', async () => {
    const client = build({ PAYMENT_PROVIDER_URL: 'http://127.0.0.1:1' });

    await expect(client.charge(command(null))).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(client.charge(command(null))).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(client.breakerState).toBe('OPEN');

    const started = Date.now();
    await expect(client.charge(command(null))).rejects.toBeInstanceOf(CircuitOpenError);
    // Rejected without a connection attempt: an open breaker that still dials
    // is a logging decorator.
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('sends the payment id as the idempotency key on every attempt', async () => {
    const client = build();
    const one = command('success');

    const first = await client.charge(one);
    const second = await client.charge(one);

    // Same key, same answer, one charge. spec.md section 11, at the client.
    expect(second).toEqual(first);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd apps/api && npx jest test/payment-client.e2e.spec.ts
```

Expected: FAIL — `Cannot find module '../src/payments/payment-provider.client'`.

- [ ] **Step 4: Write the client**

Create `apps/api/src/payments/payment-provider.client.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';

import {
  chargeResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  PAYMENT_SCENARIO_HEADER,
  type ChargeResponse,
} from '@cinema/contracts';

import { ConfigService } from '../config/config.service';
import { CircuitBreaker, type BreakerState } from '../resilience/circuit-breaker';

/**
 * The downstream could not answer. Distinct from a decline, which is an answer.
 * Everything that reaches the breaker's failure count arrives as one of these.
 */
export class ProviderUnavailableError extends Error {
  constructor(reason: string) {
    super(`payment provider unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}

export interface ChargeCommand {
  /** Doubles as the Idempotency-Key. Stable across every attempt (ADR 0035). */
  paymentId: string;
  reservationId: string;
  amountCents: number;
  scenario: string | null;
}

@Injectable()
export class PaymentProviderClient {
  private readonly logger = new Logger(PaymentProviderClient.name);
  private readonly breaker: CircuitBreaker;

  constructor(private readonly configService: ConfigService) {
    const { paymentBreakerFailureThreshold, paymentBreakerOpenMs } = configService.config;
    this.breaker = new CircuitBreaker({
      failureThreshold: paymentBreakerFailureThreshold,
      openMs: paymentBreakerOpenMs,
    });
  }

  get breakerState(): BreakerState {
    return this.breaker.state;
  }

  /** Calls refused by the open breaker since boot. Section 22 scrapes this. */
  get breakerRejections(): number {
    return this.breaker.rejected;
  }

  /**
   * Resolves with SUCCEEDED or DECLINED; throws ProviderUnavailableError for
   * anything that is not an answer, and CircuitOpenError when the breaker is
   * open. The distinction is load-bearing: only a throw counts as a failure, so
   * a run of declines can never open the circuit (ADR 0038).
   */
  async charge(command: ChargeCommand): Promise<ChargeResponse> {
    return this.breaker.execute(() => this.call(command));
  }

  private async call(command: ChargeCommand): Promise<ChargeResponse> {
    const { paymentProviderUrl, paymentTimeoutMs } = this.configService.config;
    if (!paymentProviderUrl) throw new ProviderUnavailableError('no provider url configured');

    let response: Response;
    try {
      response = await fetch(`${paymentProviderUrl}/charge`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [IDEMPOTENCY_KEY_HEADER]: command.paymentId,
          ...(command.scenario ? { [PAYMENT_SCENARIO_HEADER]: command.scenario } : {}),
        },
        body: JSON.stringify({
          amountCents: command.amountCents,
          reference: command.reservationId,
        }),
        // AbortSignal.timeout rather than a hand-rolled race: it aborts the
        // socket instead of leaving it open behind a resolved promise.
        signal: AbortSignal.timeout(paymentTimeoutMs),
      });
    } catch (error) {
      // Timeout, DNS failure, connection refused -- all the same to us, and all
      // worth retrying.
      throw new ProviderUnavailableError(String(error));
    }

    if (response.status >= 500) {
      throw new ProviderUnavailableError(`status ${String(response.status)}`);
    }
    if (!response.ok) {
      // A 4xx is our fault and will not improve on retry, but the caller is a
      // message handler, and the ladder plus the DLQ is where a permanently
      // broken request belongs -- so it is still a throw, just a louder one.
      this.logger.error(`provider rejected the charge with ${String(response.status)}`);
      throw new ProviderUnavailableError(`status ${String(response.status)}`);
    }

    const parsed = chargeResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      // A 200 we cannot read is not an answer. Treating it as one would mean
      // guessing whether money moved.
      throw new ProviderUnavailableError('unparseable response body');
    }

    if (response.headers.get(IDEMPOTENT_REPLAY_HEADER) === 'true') {
      this.logger.log(`payment ${command.paymentId}: provider replayed a stored answer`);
    }
    return parsed.data;
  }
}
```

- [ ] **Step 5: Run the client suite**

```bash
cd apps/api && npx jest test/payment-client.e2e.spec.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Run everything**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/payments apps/api/test
git commit -m "feat(api): an HTTP provider client behind the breaker

fetch with AbortSignal.timeout, no new dependency. The provider runs in
the Jest process on an ephemeral port: a real socket and a real HTTP hop,
without an image build in every run.

charge() resolves with SUCCEEDED or DECLINED and throws only when the
provider could not answer. That is where 'a decline is not a failure'
is enforced — the breaker counts throws, so a run of refused cards can
never open the circuit."
```

---

## Task 8: Settling a payment

The decision table at the service level, where it is testable without a broker. `PaymentService` orchestrates; `ReservationService` keeps ownership of the reservation lifecycle and of seat release — so the dependency runs one way only and there is no `forwardRef` anywhere.

**Files:**

- Modify: `apps/api/src/reservations/reservation.service.ts`
- Create: `apps/api/src/payments/payment.service.ts`
- Create: `apps/api/src/payments/payment.module.ts`
- Create: `apps/api/test/payment-settle.e2e.spec.ts`

**Interfaces:**

- Consumes: `PaymentProviderClient`, `ProviderUnavailableError`, `ChargeCommand` (Task 7); `CircuitOpenError` (Task 2).
- Produces:
  - `type PaymentClaim = { kind: 'charge'; paymentId: string; reservationId: string; amountCents: number; scenario: string | null } | { kind: 'not-found' } | { kind: 'terminal' } | { kind: 'stale' }`
  - `type PaymentOutcome = { status: 'SUCCEEDED'; providerRef: string } | { status: 'DECLINED'; reason: string } | { status: 'FAILED'; reason: string }`
  - `type PaymentSettlement = 'confirmed' | 'failed' | 'not-found' | 'terminal' | 'stale'`
  - `ReservationService.claimPayment(paymentId: string): Promise<PaymentClaim>`
  - `ReservationService.settlePayment(paymentId: string, outcome: PaymentOutcome): Promise<PaymentSettlement>`
  - `PaymentService.settle(paymentId: string): Promise<PaymentSettlement>` — throws when the provider could not answer
  - `PaymentService.abandon(paymentId: string, reason: string): Promise<PaymentSettlement>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/payment-settle.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { PaymentService } from '../src/payments/payment.service';
import { ProviderUnavailableError } from '../src/payments/payment-provider.client';
import { ReservationService } from '../src/reservations/reservation.service';
import { seatKey } from '../src/locking/seat-lock';
import { getTestProviderUrl, getTestRabbitUrl } from './harness';
import { activeSeatCount, paymentFor, reservationStatus } from './payment-harness';
import { deleteTopology, openInspection } from './rabbit-harness';
import { startPaymentWorkerHarness, type PaymentWorkerHarness } from './payment-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('settling a payment', () => {
  let api: ReservationHarness;
  let worker: PaymentWorkerHarness;
  let payments: PaymentService;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

  /** Confirms a hold and returns the payment id the confirm created. */
  const startPayment = async (seat: string, scenario?: string): Promise<{ reservationId: string; paymentId: string }> => {
    const session = randomUUID();
    const reservation = await api.holdOne(seat, session);
    await api.app.inject({
      method: 'POST',
      url: `/api/v1/reservations/${reservation.id}/confirm`,
      headers: { 'x-session-id': session, ...(scenario ? { 'x-payment-scenario': scenario } : {}) },
    });
    const payment = await paymentFor(api.db, reservation.id);
    return { reservationId: reservation.id, paymentId: payment!.id };
  };

  beforeAll(async () => {
    inspection = await openInspection(getTestRabbitUrl());
    await deleteTopology(inspection.connection, 3);

    api = await startReservationHarness({
      lockStrategy: 'redis',
      expiryMode: 'queue',
      paymentMode: 'queue',
      rabbitmqUrl: getTestRabbitUrl(),
      paymentProviderUrl: getTestProviderUrl(),
      ttlSeconds: 600,
    });
    worker = await startPaymentWorkerHarness({ consume: false });
    payments = worker.payments;
  });

  afterAll(async () => {
    await worker.close();
    await api.close();
    await inspection.channel.close().catch(() => {});
    await inspection.connection.close().catch(() => {});
  });

  beforeEach(async () => {
    await truncateReservations(api.db, api.redis);
  });

  it('confirms the reservation when the provider charges', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[0]!, 'success');

    await expect(payments.settle(paymentId)).resolves.toBe('confirmed');

    expect(await reservationStatus(api.db, reservationId)).toBe('CONFIRMED');
    const payment = await paymentFor(api.db, reservationId);
    expect(payment).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(payment!.providerRef).toMatch(/^ch_/);
    expect(payment!.settledAt).not.toBeNull();
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
  });

  it('retains the seat lock on success, rather than releasing it', async () => {
    const { paymentId } = await startPayment(api.seatIds[1]!, 'success');
    await payments.settle(paymentId);

    // Not released: a confirmed seat is never free again, and dropping the key
    // would invite the next request to take the lock, open a transaction and be
    // refused by the index — exactly the work the lock exists to avoid.
    await expect(api.redis!.exists(seatKey(api.showtimeId, api.seatIds[1]!))).resolves.toBe(1);
  });

  it('fails the reservation and frees the seats when the card is declined', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[2]!, 'decline');

    await expect(payments.settle(paymentId)).resolves.toBe('failed');

    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'DECLINED' });
    // PAYMENT_FAILED behaves exactly like EXPIRED as far as the seat pool is
    // concerned: a hold that did not become a sale gives the seats back.
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
    await expect(api.redis!.exists(seatKey(api.showtimeId, api.seatIds[2]!))).resolves.toBe(0);
  });

  it('throws rather than settling when the provider cannot answer', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[3]!, 'error');

    await expect(payments.settle(paymentId)).rejects.toBeInstanceOf(ProviderUnavailableError);

    // Nothing is decided. The message will climb the ladder and try again, and
    // the seats stay held while it does.
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
  });

  it('counts every attempt, including the ones that failed', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[4]!, 'error');

    await expect(payments.settle(paymentId)).rejects.toThrow();
    await expect(payments.settle(paymentId)).rejects.toThrow();

    // From the database alone you can tell a payment that worked first time
    // from one that took three goes. x-attempt cannot tell you that: it lives
    // in the message and dies with it.
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ attempts: 2 });
  });

  it('does nothing for a payment that does not exist', async () => {
    await expect(payments.settle(randomUUID())).resolves.toBe('not-found');
  });

  it('does nothing for a payment that already settled', async () => {
    const { paymentId } = await startPayment(api.seatIds[5]!, 'success');
    await payments.settle(paymentId);

    // The duplicate delivery. This is the case that makes at-least-once safe
    // without a dedupe table, and getting it wrong charges twice.
    await expect(payments.settle(paymentId)).resolves.toBe('terminal');
  });

  it('does nothing when the reservation left PAYMENT_PENDING underneath it', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[6]!, 'success');
    await api.db.execute(
      sql`UPDATE reservations SET status = 'PAYMENT_FAILED' WHERE id = ${reservationId}`,
    );

    await expect(payments.settle(paymentId)).resolves.toBe('stale');
  });

  it('abandons a payment when the ladder is exhausted', async () => {
    const { reservationId, paymentId } = await startPayment(api.seatIds[7]!, 'error');

    await expect(payments.abandon(paymentId, 'retries exhausted')).resolves.toBe('failed');

    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'FAILED' });
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    // The seats come back immediately rather than waiting for someone to read
    // the DLQ: leaving them held would mean selling the hall at the speed of
    // whoever is on call.
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
  });
});
```

- [ ] **Step 2: Add the worker harness this suite needs**

Append to `apps/api/test/payment-harness.ts`:

```ts
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PaymentService } from '../src/payments/payment.service';
import { PaymentConsumer } from '../src/worker/payment.consumer';
import { WorkerModule } from '../src/worker/worker.module';

export interface PaymentWorkerHarnessOptions {
  /**
   * `false` cancels the consumer's subscription immediately after boot, so a
   * suite can drive PaymentService by hand without the worker racing it to the
   * same message. Task 9 adds the consumer; until then this flag is inert.
   */
  consume?: boolean;
  retryDelaysMs?: number[];
  prefetch?: number;
  providerUrl?: string;
  timeoutMs?: number;
  breakerThreshold?: number;
  breakerOpenMs?: number;
}

export interface PaymentWorkerHarness {
  context: INestApplicationContext;
  payments: PaymentService;
  consumer: PaymentConsumer;
  close(): Promise<void>;
}

export async function startPaymentWorkerHarness(
  options: PaymentWorkerHarnessOptions = {},
): Promise<PaymentWorkerHarness> {
  const overrides: Record<string, string | undefined> = {
    PAYMENT_MODE: 'queue',
    RESERVATION_EXPIRY_MODE: 'queue',
    PAYMENT_PROVIDER_URL: options.providerUrl,
    PAYMENT_TIMEOUT_MS: options.timeoutMs === undefined ? undefined : String(options.timeoutMs),
    PAYMENT_BREAKER_FAILURE_THRESHOLD:
      options.breakerThreshold === undefined ? undefined : String(options.breakerThreshold),
    PAYMENT_BREAKER_OPEN_MS:
      options.breakerOpenMs === undefined ? undefined : String(options.breakerOpenMs),
    RABBITMQ_PREFETCH: options.prefetch === undefined ? undefined : String(options.prefetch),
    RABBITMQ_RETRY_DELAYS_MS: options.retryDelaysMs?.join(','),
  };
  const restore = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }

  const context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  await context.init();

  const consumer = context.get(PaymentConsumer);
  if (options.consume === false) await consumer.unsubscribe();

  return {
    context,
    payments: context.get(PaymentService),
    consumer,
    close: async () => {
      await context.close();
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
```

The snippet above is the **finished** shape, which Task 9 completes. `PaymentConsumer` does not exist yet, so build this file in two halves: in Task 8 (Step 6) write it **without** the `PaymentConsumer` import, the `consumer` field and the `if (options.consume === false)` line; Task 9 Step 5 adds all three. Task 8's own suite drives `PaymentService` directly and needs none of them.

- [ ] **Step 3: Run it and watch it fail**

```bash
cd apps/api && npx jest test/payment-settle.e2e.spec.ts
```

Expected: FAIL — `Cannot find module '../src/payments/payment.service'`.

- [ ] **Step 4: Add the claim and settle methods to `ReservationService`**

Add the exported types near `SettleOutcome`:

```ts
export type PaymentClaim =
  | {
      kind: 'charge';
      paymentId: string;
      reservationId: string;
      amountCents: number;
      scenario: string | null;
    }
  | { kind: 'not-found' }
  | { kind: 'terminal' }
  | { kind: 'stale' };

export type PaymentOutcome =
  | { status: 'SUCCEEDED'; providerRef: string }
  | { status: 'DECLINED'; reason: string }
  | { status: 'FAILED'; reason: string };

export type PaymentSettlement = 'confirmed' | 'failed' | 'not-found' | 'terminal' | 'stale';
```

Then the two methods:

```ts
  /**
   * Takes ownership of one attempt: checks the payment is still ours to make
   * and counts the attempt, in one transaction.
   *
   * The attempt is counted here rather than after the provider answers,
   * because a provider that never answers is exactly the case the counter
   * exists to record.
   */
  async claimPayment(paymentId: string): Promise<PaymentClaim> {
    return this.db.transaction(async (tx): Promise<PaymentClaim> => {
      const [head] = await tx
        .select({ reservationId: payments.reservationId })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);
      if (!head) return { kind: 'not-found' };

      // Reservations first, then payments, everywhere in this service. The
      // reaper takes the same two rows in the same order; two paths taking them
      // in opposite orders is a deadlock waiting for load.
      const [reservation] = await tx
        .select({ status: reservations.status })
        .from(reservations)
        .where(eq(reservations.id, head.reservationId))
        .limit(1)
        .for('update');

      const [row] = await tx
        .select({
          status: payments.status,
          amountCents: payments.amountCents,
          scenario: payments.scenario,
        })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1)
        .for('update');

      if (!row) return { kind: 'not-found' };
      if (row.status !== 'PENDING') return { kind: 'terminal' };
      if (!reservation || reservation.status !== 'PAYMENT_PENDING') return { kind: 'stale' };

      await tx
        .update(payments)
        .set({ attempts: sql`${payments.attempts} + 1` })
        .where(eq(payments.id, paymentId));

      return {
        kind: 'charge',
        paymentId,
        reservationId: head.reservationId,
        amountCents: row.amountCents,
        scenario: row.scenario,
      };
    });
  }

  /**
   * Records what the provider decided and moves the reservation with it.
   *
   * Idempotent by the same construction as settleExpired: a payment that is no
   * longer PENDING is left alone, which is what makes at-least-once delivery
   * safe without a dedupe table.
   */
  async settlePayment(paymentId: string, outcome: PaymentOutcome): Promise<PaymentSettlement> {
    const settled = await this.db.transaction(async (tx) => {
      const [head] = await tx
        .select({ reservationId: payments.reservationId })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);
      if (!head) return { result: 'not-found' as const, released: [] as ReleasedSeat[] };

      const [reservation] = await tx
        .select({ status: reservations.status, showtimeId: reservations.showtimeId })
        .from(reservations)
        .where(eq(reservations.id, head.reservationId))
        .limit(1)
        .for('update');

      const [row] = await tx
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1)
        .for('update');

      if (!row) return { result: 'not-found' as const, released: [] as ReleasedSeat[] };
      if (row.status !== 'PENDING') return { result: 'terminal' as const, released: [] as ReleasedSeat[] };
      if (!reservation || reservation.status !== 'PAYMENT_PENDING') {
        return { result: 'stale' as const, released: [] as ReleasedSeat[] };
      }

      await tx
        .update(payments)
        .set({
          status: outcome.status,
          providerRef: outcome.status === 'SUCCEEDED' ? outcome.providerRef : null,
          settledAt: sql`now()`,
        })
        .where(eq(payments.id, paymentId));

      if (outcome.status !== 'SUCCEEDED') {
        await tx
          .update(reservations)
          .set({ status: 'PAYMENT_FAILED', cancelledAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(reservations.id, head.reservationId));

        return {
          result: 'failed' as const,
          released: await this.releaseSeatsOf(tx, head.reservationId),
        };
      }

      await tx
        .update(reservations)
        .set({ status: 'CONFIRMED', confirmedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(reservations.id, head.reservationId));

      const confirmed = await this.hydrateById(tx, head.reservationId);
      const [showtime] = await tx
        .select({ startsAt: showtimes.startsAt })
        .from(showtimes)
        .where(eq(showtimes.id, reservation.showtimeId))
        .limit(1);

      return {
        result: 'confirmed' as const,
        released: [] as ReleasedSeat[],
        retain: {
          showtimeId: reservation.showtimeId,
          seatIds: confirmed.seats.map((seat) => seat.seatId),
          reservationId: head.reservationId,
          startsAt: showtime!.startsAt,
        },
      };
    });

    // After the commit, like every other lock operation in this service.
    if (settled.result === 'failed') await this.releaseLocks(settled.released);
    if (settled.result === 'confirmed' && 'retain' in settled && settled.retain) {
      await this.seatLock.retain(
        settled.retain.showtimeId,
        settled.retain.seatIds,
        settled.retain.reservationId,
        settled.retain.startsAt,
      );
    }
    return settled.result;
  }
```

`hydrateById` is a thin helper next to the existing `hydrate`: select the reservation row by id and hand it to `hydrate`. The worker has no session, so `get` — which filters by session — cannot be reused. Add it as a private method:

```ts
  /** `get` without the session filter: the worker acts for the system, not a caller. */
  private async hydrateById(executor: Executor, id: string): Promise<Reservation> {
    const [row] = await executor.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!row) throw new ResourceNotFoundError('Reservation', id);
    return this.hydrate(executor, row);
  }
```

- [ ] **Step 5: Write `PaymentService`**

Create `apps/api/src/payments/payment.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';

import {
  ReservationService,
  type PaymentSettlement,
} from '../reservations/reservation.service';
import type { BreakerState } from '../resilience/circuit-breaker';
import { PaymentProviderClient } from './payment-provider.client';

/**
 * The worker's orchestrator: claim an attempt, ask the provider, record what it
 * said. It calls ReservationService and ReservationService never calls back —
 * the reservation lifecycle and seat release stay where they already live, so
 * the dependency runs one way and no forwardRef is needed anywhere.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly reservations: ReservationService,
    private readonly provider: PaymentProviderClient,
  ) {}

  /** For the consumer's log line and, later, for Prometheus. */
  get breakerState(): BreakerState {
    return this.provider.breakerState;
  }

  /**
   * Resolves with what happened. Throws only when the provider could not
   * answer — which is the consumer's signal to climb the retry ladder, and the
   * reason a decline (an answer) is a resolution rather than a throw.
   */
  async settle(paymentId: string): Promise<PaymentSettlement> {
    const claim = await this.reservations.claimPayment(paymentId);
    if (claim.kind !== 'charge') return claim.kind;

    // Throws ProviderUnavailableError or CircuitOpenError. Deliberately not
    // caught here: nothing is written, the payment stays PENDING, and the
    // message goes back on the ladder with the attempt already counted.
    const response = await this.provider.charge({
      paymentId: claim.paymentId,
      reservationId: claim.reservationId,
      amountCents: claim.amountCents,
      scenario: claim.scenario,
    });

    if (response.status === 'SUCCEEDED') {
      return this.reservations.settlePayment(paymentId, {
        status: 'SUCCEEDED',
        providerRef: response.providerRef,
      });
    }

    this.logger.log(`payment ${paymentId} declined: ${response.declineReason}`);
    return this.reservations.settlePayment(paymentId, {
      status: 'DECLINED',
      reason: response.declineReason,
    });
  }

  /**
   * The end of the ladder. Marks the payment FAILED — ours, not the provider's
   * opinion — and gives the seats back at once rather than holding them until
   * somebody reads the dead-letter queue.
   */
  async abandon(paymentId: string, reason: string): Promise<PaymentSettlement> {
    this.logger.error(`payment ${paymentId} abandoned: ${reason}`);
    return this.reservations.settlePayment(paymentId, { status: 'FAILED', reason });
  }
}
```

Create `apps/api/src/payments/payment.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { ReservationModule } from '../reservations/reservation.module';
import { PaymentProviderClient } from './payment-provider.client';
import { PaymentService } from './payment.service';

/**
 * Worker-side only. AppModule does NOT import this: the API never calls the
 * provider, so the API image has no reason to hold a client for it. The API's
 * half of payment is the publisher, which lives in MessagingModule.
 */
@Module({
  imports: [ReservationModule],
  providers: [PaymentService, PaymentProviderClient],
  exports: [PaymentService, PaymentProviderClient],
})
export class PaymentModule {}
```

Add `PaymentModule` to `WorkerModule`'s `imports`.

- [ ] **Step 6: Build the first half of the payment worker harness**

Add `startPaymentWorkerHarness` to `apps/api/test/payment-harness.ts` exactly as in Step 2, but **without** the `PaymentConsumer` import, the `consumer` field, and the `if (options.consume === false)` line. Task 9 adds all three.

- [ ] **Step 7: Run the settle suite**

```bash
cd apps/api && npx jest test/payment-settle.e2e.spec.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 8: Run everything**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): claim, charge, settle

PaymentService orchestrates and ReservationService never calls back, so
the dependency runs one way and there is no forwardRef: the reservation
lifecycle and seat release stay where they already live.

settle() resolves with what happened and throws only when the provider
could not answer — the consumer's signal to climb the ladder. A decline is
an answer, so it settles to PAYMENT_FAILED and hands the seats back
immediately, exactly as an expiry does.

Both paths lock reservations before payments. The reaper takes the same
two rows in the same order; opposite orders is a deadlock waiting for
load."
```

---

## Task 9: The consumer

**Files:**

- Create: `apps/api/src/worker/payment.consumer.ts`
- Modify: `apps/api/src/worker/worker.module.ts`
- Modify: `apps/api/src/worker/main.ts`
- Modify: `apps/api/test/payment-harness.ts`
- Create: `apps/api/test/payment-consumer.e2e.spec.ts`

**Interfaces:**

- Consumes: `PaymentService` (Task 8); `PAYMENT_QUEUE`, `PAYMENT_DEAD_KEY`, `PAYMENT_LADDER`, `paymentMessageSchema` (Task 1); `nextHop`, `attemptOf` (Task 5).
- Produces: `class PaymentConsumer` with `get handledCount(): number`, `subscribe(): Promise<void>`, `unsubscribe(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/payment-consumer.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { COMMANDS_EXCHANGE, PAYMENT_KEY, PAYMENT_QUEUE } from '../src/messaging/messages';
import { getTestProviderUrl, getTestRabbitUrl } from './harness';
import {
  activeSeatCount,
  paymentFor,
  reservationStatus,
  startPaymentWorkerHarness,
  type PaymentWorkerHarness,
} from './payment-harness';
import { deleteTopology, openInspection, queueDepth } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('the payment consumer', () => {
  let api: ReservationHarness;
  let worker: PaymentWorkerHarness;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

  /** Waits for the consumer to take `n` messages to a conclusion. */
  const settled = async (n: number, timeoutMs = 10_000): Promise<void> => {
    const target = worker.consumer.handledCount + n;
    const deadline = Date.now() + timeoutMs;
    while (worker.consumer.handledCount < target) {
      if (Date.now() > deadline) {
        throw new Error(`only ${String(worker.consumer.handledCount)} messages handled`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const confirmWith = async (seat: string, scenario: string): Promise<string> => {
    const session = randomUUID();
    const reservation = await api.holdOne(seat, session);
    await api.app.inject({
      method: 'POST',
      url: `/api/v1/reservations/${reservation.id}/confirm`,
      headers: { 'x-session-id': session, 'x-payment-scenario': scenario },
    });
    return reservation.id;
  };

  beforeAll(async () => {
    inspection = await openInspection(getTestRabbitUrl());
    await deleteTopology(inspection.connection, 3);

    api = await startReservationHarness({
      lockStrategy: 'redis',
      expiryMode: 'queue',
      paymentMode: 'queue',
      rabbitmqUrl: getTestRabbitUrl(),
      paymentProviderUrl: getTestProviderUrl(),
      ttlSeconds: 600,
    });
    worker = await startPaymentWorkerHarness({ providerUrl: getTestProviderUrl() });
  });

  afterAll(async () => {
    await worker.close();
    await api.close();
    await inspection.channel.close().catch(() => {});
    await inspection.connection.close().catch(() => {});
  });

  beforeEach(async () => {
    await truncateReservations(api.db, api.redis);
  });

  it('carries a hold all the way to CONFIRMED without anyone asking again', async () => {
    const reservationId = await confirmWith(api.seatIds[0]!, 'success');
    await settled(1);

    expect(await reservationStatus(api.db, reservationId)).toBe('CONFIRMED');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await queueDepth(inspection.channel, PAYMENT_QUEUE)).toBe(0);
  });

  it('carries a declined card to PAYMENT_FAILED and frees the seats', async () => {
    const reservationId = await confirmWith(api.seatIds[1]!, 'decline');
    await settled(1);

    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
  });

  it('drops a message whose payment does not exist', async () => {
    // The rolled-back-after-publish case. It is not an error and must not be
    // retried: the transaction that would have created this row went away.
    inspection.channel.publish(
      COMMANDS_EXCHANGE,
      PAYMENT_KEY,
      Buffer.from(JSON.stringify({ paymentId: randomUUID() })),
      { persistent: true },
    );
    await settled(1);
    expect(await queueDepth(inspection.channel, PAYMENT_QUEUE)).toBe(0);
  });

  it('absorbs a duplicate delivery without charging twice', async () => {
    const reservationId = await confirmWith(api.seatIds[2]!, 'success');
    await settled(1);
    const first = await paymentFor(api.db, reservationId);

    inspection.channel.publish(
      COMMANDS_EXCHANGE,
      PAYMENT_KEY,
      Buffer.from(JSON.stringify({ paymentId: first!.id })),
      { persistent: true },
    );
    await settled(1);

    const second = await paymentFor(api.db, reservationId);
    // Same reference, same attempt count: the redelivery never reached the
    // provider, because claimPayment saw a payment that was no longer PENDING.
    expect(second).toEqual(first);
  });

  it('sends an unparseable body straight to the dead-letter queue', async () => {
    inspection.channel.publish(COMMANDS_EXCHANGE, PAYMENT_KEY, Buffer.from('not json'), {
      persistent: true,
    });
    await settled(1);

    // A body that does not parse will not parse in thirty seconds either, so
    // retrying it only delays the diagnosis.
    expect(await queueDepth(inspection.channel, 'payment.requested.dlq')).toBe(1);
    await inspection.channel.purgeQueue('payment.requested.dlq');
  });

  it('stops taking messages when it is cancelled', async () => {
    await worker.consumer.unsubscribe();
    try {
      await confirmWith(api.seatIds[3]!, 'success');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await queueDepth(inspection.channel, PAYMENT_QUEUE)).toBe(1);
    } finally {
      await worker.consumer.subscribe();
    }
    await settled(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx jest test/payment-consumer.e2e.spec.ts
```

Expected: FAIL — `Cannot find module '../src/worker/payment.consumer'`.

- [ ] **Step 3: Write the consumer**

Create `apps/api/src/worker/payment.consumer.ts`:

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
  PAYMENT_DEAD_KEY,
  PAYMENT_LADDER,
  PAYMENT_QUEUE,
  paymentMessageSchema,
} from '../messaging/messages';
import { RABBIT, type RabbitConnection } from '../messaging/rabbit.module';
import { attemptOf, nextHop } from '../messaging/retry';
import { assertTopology } from '../messaging/topology';
import { PaymentService } from '../payments/payment.service';

/**
 * The expiry consumer's twin, on its own channel with its own prefetch, in the
 * same process (ADR 0028). Waiting on the provider is asynchronous, so one
 * event loop serves both queues without either starving the other.
 */
@Injectable()
export class PaymentConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentConsumer.name);
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private inFlight = 0;
  private handled = 0;

  constructor(
    @Inject(RABBIT) private readonly connection: RabbitConnection,
    private readonly payments: PaymentService,
    private readonly configService: ConfigService,
  ) {}

  /** Messages taken to a conclusion since boot, whatever that conclusion was. */
  get handledCount(): number {
    return this.handled;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.connection) return;
    if (this.configService.config.paymentMode !== 'queue') return;
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
      await assertTopology(channel, {
        reservationTtlSeconds,
        retryDelaysMs: rabbitmqRetryDelaysMs,
      });
      await channel.prefetch(rabbitmqPrefetch);
      channel.on('error', (error: Error) => this.logger.warn(`payment channel: ${error.message}`));

      const reply = await channel.consume(PAYMENT_QUEUE, (message) => {
        if (message) void this.handle(channel, message);
      });

      this.channel = channel;
      this.consumerTag = reply.consumerTag;
      this.logger.log(`consuming ${PAYMENT_QUEUE} with prefetch ${String(rabbitmqPrefetch)}`);
    } catch (error) {
      this.logger.warn(`could not subscribe to ${PAYMENT_QUEUE}: ${String(error)}`);
    }
  }

  /** Stops new deliveries without closing the channel. Used by tests. */
  async unsubscribe(): Promise<void> {
    if (this.channel && this.consumerTag) {
      await this.channel.cancel(this.consumerTag).catch(() => {});
      this.consumerTag = null;
    }
  }

  private async handle(channel: Channel, message: ConsumeMessage): Promise<void> {
    this.inFlight += 1;
    try {
      const paymentId = this.parse(message);
      if (!paymentId) {
        this.forward(channel, message, PAYMENT_DEAD_KEY, attemptOf(message.properties.headers));
        channel.ack(message);
        return;
      }

      try {
        const outcome = await this.payments.settle(paymentId);
        this.logger.log(`payment.requested ${paymentId}: ${outcome}`);
        channel.ack(message);
      } catch (error) {
        const attempt = attemptOf(message.properties.headers);
        const hop = nextHop(attempt, this.configService.config.rabbitmqRetryDelaysMs, PAYMENT_LADDER);

        if (hop.dead) {
          // The seats come back now, not when someone reads the DLQ. The
          // message still goes there, because a human needs to know a charge
          // was given up on.
          this.logger.error(
            `payment ${paymentId} failed ${String(hop.attempt)} times, giving up: ${String(error)}`,
          );
          await this.payments
            .abandon(paymentId, String(error))
            .catch((failure: unknown) =>
              this.logger.error(`could not abandon payment ${paymentId}: ${String(failure)}`),
            );
        } else {
          this.logger.warn(
            `payment ${paymentId} failed, retrying as attempt ${String(hop.attempt)}: ${String(error)}`,
          );
        }

        // Publish first, ack second — the same rule as the expiry consumer. The
        // reverse order loses the message if the process dies between the two;
        // this order can deliver it twice instead, and a duplicate is absorbed
        // by claimPayment's terminal check. Losing is worse than repeating.
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
      return paymentMessageSchema.parse(body).paymentId;
    } catch (error) {
      this.logger.error(`unparseable payment.requested message: ${String(error)}`);
      return null;
    }
  }

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

    await this.unsubscribe();
    while (this.inFlight > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await channel.close().catch(() => {});
  }
}
```

- [ ] **Step 4: Register it and let the worker boot for payments alone**

In `apps/api/src/worker/worker.module.ts`, add `PaymentModule` to `imports` and `PaymentConsumer` to `providers`.

In `apps/api/src/worker/main.ts`, replace the early-exit condition:

```ts
  // The process now serves two queues, so it exits only when BOTH are off.
  // Exiting because expiry is lazy would take the payment worker down with it.
  if (config.reservationExpiryMode !== 'queue' && config.paymentMode !== 'queue') {
    logger.info('both RESERVATION_EXPIRY_MODE and PAYMENT_MODE are off; the worker has nothing to do');
    return;
  }
```

and extend the final log line:

```ts
  logger.info(
    {
      prefetch: config.rabbitmqPrefetch,
      expiry: config.reservationExpiryMode,
      payment: config.paymentMode,
    },
    'worker started',
  );
```

`ExpireConsumer.onApplicationBootstrap` must gain the matching guard, or a payment-only worker will subscribe to the expiry queue as well:

```ts
  async onApplicationBootstrap(): Promise<void> {
    if (!this.connection) return;
    if (this.configService.config.reservationExpiryMode !== 'queue') return;
    // ... unchanged
```

- [ ] **Step 5: Finish the payment worker harness**

Add the `PaymentConsumer` import, the `consumer` field and the `if (options.consume === false) await consumer.unsubscribe();` line to `startPaymentWorkerHarness`, completing the shape given in Task 8 Step 2.

- [ ] **Step 6: Run the consumer suite**

```bash
cd apps/api && npx jest test/payment-consumer.e2e.spec.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 7: Run everything**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/worker apps/api/src/payments apps/api/test
git commit -m "feat(api): consume payment.requested beside the expiry queue

Its own channel and prefetch in the same process: waiting on the provider
is asynchronous, so one event loop serves both queues without either
starving the other.

Publish-then-ack, as in phase 4 — a duplicate is absorbed by
claimPayment's terminal check, a loss is not. At the end of the ladder the
consumer abandons the payment BEFORE dead-lettering, so the seats come
back immediately instead of waiting for someone to read the DLQ.

The worker now exits only when both subsystems are off, and each consumer
checks its own mode before subscribing."
```

---

## Task 10: The failures

Everything the sub-project exists to prove. No new production code — if any of these needs a change to make it pass, that change is a bug found.

**Files:**

- Create: `apps/api/test/payment-resilience.e2e.spec.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–9.
- Produces: nothing. This task is evidence.

- [ ] **Step 1: Write the ladder and DLQ tests**

Create `apps/api/test/payment-resilience.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { PAYMENT_DLQ, PAYMENT_QUEUE } from '../src/messaging/messages';
import { getTestProviderUrl, getTestRabbitUrl } from './harness';
import {
  activeSeatCount,
  paymentFor,
  reservationStatus,
  startPaymentWorkerHarness,
  type PaymentWorkerHarness,
} from './payment-harness';
import { deleteTopology, openInspection, queueDepth, takeOne } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('payment under failure', () => {
  let api: ReservationHarness;
  let worker: PaymentWorkerHarness;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

  // Milliseconds, not the production minutes: the ladder's shape is what is
  // under test, not its duration.
  const retryDelaysMs = [200, 400];

  const settled = async (n: number, timeoutMs = 15_000): Promise<void> => {
    const target = worker.consumer.handledCount + n;
    const deadline = Date.now() + timeoutMs;
    while (worker.consumer.handledCount < target) {
      if (Date.now() > deadline) {
        throw new Error(
          `expected ${String(n)} more handled, saw ${String(worker.consumer.handledCount - target + n)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const confirmWith = async (seat: string, scenario: string): Promise<string> => {
    const session = randomUUID();
    const reservation = await api.holdOne(seat, session);
    await api.app.inject({
      method: 'POST',
      url: `/api/v1/reservations/${reservation.id}/confirm`,
      headers: { 'x-session-id': session, 'x-payment-scenario': scenario },
    });
    return reservation.id;
  };

  beforeAll(async () => {
    inspection = await openInspection(getTestRabbitUrl());
    await deleteTopology(inspection.connection, 3);

    api = await startReservationHarness({
      lockStrategy: 'redis',
      expiryMode: 'queue',
      paymentMode: 'queue',
      rabbitmqUrl: getTestRabbitUrl(),
      paymentProviderUrl: getTestProviderUrl(),
      ttlSeconds: 600,
      // Both harnesses MUST agree: queue arguments are part of a queue's
      // identity, and a mismatch is a 406 that kills the channel.
      retryDelaysMs,
    });
  });

  afterAll(async () => {
    await api.close();
    await inspection.channel.close().catch(() => {});
    await inspection.connection.close().catch(() => {});
  });

  beforeEach(async () => {
    await truncateReservations(api.db, api.redis);
    await inspection.channel.purgeQueue(PAYMENT_DLQ).catch(() => {});
  });

  afterEach(async () => {
    await worker.close();
  });

  it('retries a 500 and succeeds when the provider recovers', async () => {
    // The provider answers by header, so "recovery" is the second attempt
    // arriving without the error scenario. The payment row remembers the
    // scenario, so instead the test clears it between attempts.
    worker = await startPaymentWorkerHarness({
      providerUrl: getTestProviderUrl(),
      retryDelaysMs,
    });

    const reservationId = await confirmWith(api.seatIds[0]!, 'error');
    await settled(1);

    // Attempt 1 failed and the message is on tier 1, not lost and not dead.
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'PENDING', attempts: 1 });

    const payment = await paymentFor(api.db, reservationId);
    await api.db.execute(
      sql`UPDATE payments SET scenario = 'success' WHERE id = ${payment!.id}`,
    );

    await settled(1);
    expect(await reservationStatus(api.db, reservationId)).toBe('CONFIRMED');
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
  });

  it('dead-letters after the ladder is exhausted and frees the seats', async () => {
    worker = await startPaymentWorkerHarness({
      providerUrl: getTestProviderUrl(),
      retryDelaysMs,
    });

    const reservationId = await confirmWith(api.seatIds[1]!, 'error');
    // Two tiers means three handlings: the first attempt plus two retries.
    await settled(3);

    const message = await takeOne(inspection.channel, PAYMENT_DLQ, 5_000);
    expect(message.properties.headers?.['x-attempt']).toBe(3);

    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    // Freed at the moment we gave up, not when a human reads the DLQ.
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
  });

  it('recovers a lost response instead of charging twice', async () => {
    // spec.md section 11, end to end. The provider records its decision before
    // hanging, so attempt 1 charges and never answers; attempt 2 presents the
    // same Idempotency-Key and is handed the stored SUCCEEDED.
    worker = await startPaymentWorkerHarness({
      providerUrl: getTestProviderUrl(),
      retryDelaysMs,
      timeoutMs: 300,
    });

    const reservationId = await confirmWith(api.seatIds[2]!, 'timeout');
    await settled(1);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');

    const payment = await paymentFor(api.db, reservationId);
    await api.db.execute(sql`UPDATE payments SET scenario = NULL WHERE id = ${payment!.id}`);

    await settled(1);

    const settledPayment = await paymentFor(api.db, reservationId);
    expect(await reservationStatus(api.db, reservationId)).toBe('CONFIRMED');
    expect(settledPayment).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    // One charge. The provider replayed rather than charged, which is only
    // true because the key is payments.id and did not change between attempts.
    expect(settledPayment!.providerRef).toMatch(/^ch_/);
  });

  it('opens the breaker against a dead provider and stops calling it', async () => {
    worker = await startPaymentWorkerHarness({
      providerUrl: 'http://127.0.0.1:1',
      retryDelaysMs,
      breakerThreshold: 2,
      breakerOpenMs: 60_000,
      timeoutMs: 300,
    });

    await confirmWith(api.seatIds[3]!, 'success');
    await confirmWith(api.seatIds[4]!, 'success');
    await confirmWith(api.seatIds[5]!, 'success');
    await settled(3);

    expect(worker.payments.breakerState).toBe('OPEN');

    // Every later attempt is refused locally. The ladder still runs -- the
    // breaker decides whether to call, the ladder decides when to try again --
    // so the reservations still end in PAYMENT_FAILED rather than hanging.
    await settled(6, 20_000);
    expect(await queueDepth(inspection.channel, PAYMENT_QUEUE)).toBe(0);
  });

  it('keeps answering confirms while the provider is down', async () => {
    worker = await startPaymentWorkerHarness({
      providerUrl: 'http://127.0.0.1:1',
      retryDelaysMs,
      timeoutMs: 300,
    });

    const started = Date.now();
    const reservationId = await confirmWith(api.seatIds[6]!, 'success');
    // The API never touches the provider: it publishes and answers. A dead
    // downstream must not appear in a user's latency.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
  });

  it('gives the seats back after the ladder runs out, so the hall is not lost', async () => {
    worker = await startPaymentWorkerHarness({
      providerUrl: 'http://127.0.0.1:1',
      retryDelaysMs,
      timeoutMs: 300,
    });

    const reservationId = await confirmWith(api.seatIds[7]!, 'success');
    await settled(3);

    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);

    // And the seat is genuinely re-sellable, which is the assertion that
    // matters to a cinema.
    const response = await api.hold([api.seatIds[7]!], randomUUID());
    expect(response.statusCode).toBe(201);
  });
});
```

- [ ] **Step 2: Run the suite**

```bash
cd apps/api && npx jest test/payment-resilience.e2e.spec.ts
```

Expected: PASS, 6 tests. If the breaker test is flaky about `handledCount`, raise its timeout rather than loosening the assertion — the counts are deterministic; only their timing is not.

- [ ] **Step 3: Run everything**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/payment-resilience.e2e.spec.ts
git commit -m "test(api): prove the ladder, the DLQ, the breaker and the lost response

The one that matters most: the provider records its decision before it
hangs, so attempt 1 charges and never answers and attempt 2 presents the
same Idempotency-Key and is handed the stored result. One charge. That is
only true because the key is payments.id and does not change between
attempts.

Also proved: a dead provider never appears in a confirm's latency, the
ladder still runs while the breaker is open, and seats are genuinely
re-sellable once a payment is given up on."
```

---

## Task 11: The expiry race and the reaper

The two mechanisms that keep a `PAYMENT_PENDING` reservation from owning its seats for ever.

**Files:**

- Modify: `apps/api/src/reservations/reservation.service.ts`
- Create: `apps/api/test/payment-expiry.e2e.spec.ts`

**Interfaces:**

- Consumes: everything from Tasks 4–9.
- Produces: `SettleOutcome` gains `'awaiting-payment'`; `releaseStaleHolds` gains its second arm.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/payment-expiry.e2e.spec.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { ReservationService } from '../src/reservations/reservation.service';
import { getTestProviderUrl, getTestRabbitUrl } from './harness';
import {
  activeSeatCount,
  agePayment,
  paymentFor,
  reservationStatus,
} from './payment-harness';
import { deleteTopology, openInspection } from './rabbit-harness';
import { startReservationHarness, type ReservationHarness } from './reservation-harness';
import { truncateReservations } from './truncate';

describe('expiry while a payment is in flight', () => {
  let api: ReservationHarness;
  let service: ReservationService;
  let inspection: Awaited<ReturnType<typeof openInspection>>;

  const confirmWith = async (seat: string): Promise<string> => {
    const session = randomUUID();
    const reservation = await api.holdOne(seat, session);
    await api.act('POST', `/${reservation.id}/confirm`, session);
    return reservation.id;
  };

  beforeAll(async () => {
    inspection = await openInspection(getTestRabbitUrl());
    await deleteTopology(inspection.connection, 3);

    api = await startReservationHarness({
      lockStrategy: 'redis',
      expiryMode: 'queue',
      paymentMode: 'queue',
      rabbitmqUrl: getTestRabbitUrl(),
      paymentProviderUrl: getTestProviderUrl(),
      // One second, so the hold is genuinely past its deadline while the
      // payment is still running. No worker consumes here.
      ttlSeconds: 1,
    });
    service = api.app.get(ReservationService);
  });

  afterAll(async () => {
    await api.close();
    await inspection.channel.close().catch(() => {});
    await inspection.connection.close().catch(() => {});
  });

  beforeEach(async () => {
    await truncateReservations(api.db, api.redis);
  });

  it('will not expire a hold whose payment is running', async () => {
    const reservationId = await confirmWith(api.seatIds[0]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // The expire message was published when the hold was taken and arrives on
    // schedule. It must find a row that no longer belongs to it.
    await expect(service.settleExpired(reservationId)).resolves.toBe('awaiting-payment');

    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
    // The seats are the point: un-selling them here would hand away a seat
    // whose charge may already have gone through.
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
  });

  it('still treats a settled payment as terminal', async () => {
    const reservationId = await confirmWith(api.seatIds[1]!);
    const payment = await paymentFor(api.db, reservationId);
    await api.app.get(ReservationService).settlePayment(payment!.id, {
      status: 'SUCCEEDED',
      providerRef: 'ch_test',
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // CONFIRMED reaches the existing terminal branch unchanged; only
    // PAYMENT_PENDING gets the new answer.
    await expect(service.settleExpired(reservationId)).resolves.toBe('terminal');
    expect(await activeSeatCount(api.db, reservationId)).toBe(1);
  });

  it('leaves a payment that has not yet reached its deadline alone', async () => {
    const reservationId = await confirmWith(api.seatIds[2]!);

    // Someone else asks for the same seat. The sweep runs, and must not take a
    // seat from a payment that is only seconds old.
    const response = await api.hold([api.seatIds[2]!], randomUUID());
    expect(response.statusCode).toBe(409);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_PENDING');
  });

  it('reaps a payment that never came back and frees its seats', async () => {
    const reservationId = await confirmWith(api.seatIds[3]!);
    const payment = await paymentFor(api.db, reservationId);
    // The message reached the DLQ, or the worker died holding it. Nothing will
    // ever settle this row, and PAYMENT_DEADLINE_SECONDS is how long we wait
    // before saying so.
    await agePayment(api.db, payment!.id, 400);

    const response = await api.hold([api.seatIds[3]!], randomUUID());

    expect(response.statusCode).toBe(201);
    expect(await reservationStatus(api.db, reservationId)).toBe('PAYMENT_FAILED');
    expect(await activeSeatCount(api.db, reservationId)).toBe(0);
    // The payment is marked too: a PENDING payment row against a PAYMENT_FAILED
    // reservation would be a lie in the ledger.
    expect(await paymentFor(api.db, reservationId)).toMatchObject({ status: 'FAILED' });
  });

  it('reaps stale holds and abandoned payments in the same sweep', async () => {
    const abandoned = await confirmWith(api.seatIds[4]!);
    const payment = await paymentFor(api.db, abandoned);
    await agePayment(api.db, payment!.id, 400);

    const stale = await api.holdOne(api.seatIds[5]!);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const response = await api.hold([api.seatIds[4]!, api.seatIds[5]!], randomUUID());

    expect(response.statusCode).toBe(201);
    expect(await reservationStatus(api.db, abandoned)).toBe('PAYMENT_FAILED');
    expect(await reservationStatus(api.db, stale.id)).toBe('EXPIRED');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx jest test/payment-expiry.e2e.spec.ts
```

Expected: FAIL — `settleExpired` returns `'terminal'` for `PAYMENT_PENDING`, and the reaper does not exist.

- [ ] **Step 3: Teach `settleExpired` about payments**

Widen the type:

```ts
export type SettleOutcome = 'expired' | 'not-found' | 'terminal' | 'not-due' | 'awaiting-payment';
```

and add one branch, **before** the existing `status !== 'PENDING'` check:

```ts
        if (!row) return { result: 'not-found', released: [] };
        // The payment owns this row now (ADR 0036). Not 'terminal', because it
        // is not over -- naming it separately is what makes the log line and
        // the test say which of the two things happened.
        if (row.status === 'PAYMENT_PENDING') return { result: 'awaiting-payment', released: [] };
        if (row.status !== 'PENDING') return { result: 'terminal', released: [] };
```

The `status` selection in that query already returns the column, so nothing else changes.

- [ ] **Step 4: Give `releaseStaleHolds` its second arm**

Replace the `where` in `releaseStaleHolds` with a left join and a disjunction, and split the update in two:

```ts
  /**
   * Lazy release, and still the authoritative one (ADR 0030). Two things can
   * leave a seat held by a reservation that is over:
   *
   *   a PENDING hold past its expires_at            -> EXPIRED
   *   a PAYMENT_PENDING row whose payment never
   *   came back within PAYMENT_DEADLINE_SECONDS     -> PAYMENT_FAILED
   *
   * The second arm closes the only unbounded case in the payment path: the
   * message reached the DLQ, or the worker died holding it. Without it a seat
   * could be owned for ever by a charge nobody is making.
   */
  private async releaseStaleHolds(
    executor: Executor,
    showtimeId: string,
    seatIds: string[],
  ): Promise<ReleasedSeat[]> {
    const deadline = this.configService.config.paymentDeadlineSeconds;

    const stale = await executor
      .selectDistinct({ id: reservations.id, status: reservations.status })
      .from(reservations)
      .innerJoin(reservationSeats, eq(reservationSeats.reservationId, reservations.id))
      .leftJoin(payments, eq(payments.reservationId, reservations.id))
      .where(
        and(
          eq(reservationSeats.showtimeId, showtimeId),
          inArray(reservationSeats.seatId, seatIds),
          isNull(reservationSeats.releasedAt),
          or(
            and(
              eq(reservations.status, 'PENDING'),
              sql`${reservations.expiresAt} <= now()`,
            ),
            and(
              eq(reservations.status, 'PAYMENT_PENDING'),
              sql`${payments.createdAt} <= now() - make_interval(secs => ${deadline})`,
            ),
          ),
        ),
      );

    if (stale.length === 0) return [];

    const expiredIds = stale.filter((row) => row.status === 'PENDING').map((row) => row.id);
    const abandonedIds = stale
      .filter((row) => row.status === 'PAYMENT_PENDING')
      .map((row) => row.id);

    if (expiredIds.length > 0) {
      await executor
        .update(reservations)
        .set({ status: 'EXPIRED', updatedAt: sql`now()` })
        .where(and(inArray(reservations.id, expiredIds), eq(reservations.status, 'PENDING')));
    }

    if (abandonedIds.length > 0) {
      await executor
        .update(reservations)
        .set({ status: 'PAYMENT_FAILED', cancelledAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(inArray(reservations.id, abandonedIds), eq(reservations.status, 'PAYMENT_PENDING')),
        );

      // A PENDING payment against a PAYMENT_FAILED reservation would be a lie
      // in the ledger, and the row is the only place a refund would ever start.
      await executor
        .update(payments)
        .set({ status: 'FAILED', settledAt: sql`now()` })
        .where(and(inArray(payments.reservationId, abandonedIds), eq(payments.status, 'PENDING')));
    }

    const ids = [...expiredIds, ...abandonedIds];
    return executor
      .update(reservationSeats)
      .set({ releasedAt: sql`now()` })
      .where(and(inArray(reservationSeats.reservationId, ids), isNull(reservationSeats.releasedAt)))
      .returning({
        reservationId: reservationSeats.reservationId,
        showtimeId: reservationSeats.showtimeId,
        seatId: reservationSeats.seatId,
      });
  }
```

Add `or` to the `drizzle-orm` import.

- [ ] **Step 5: Run the suite**

```bash
cd apps/api && npx jest test/payment-expiry.e2e.spec.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Re-run the phase 4 suites specifically**

```bash
cd apps/api && npx jest test/settle-expired.e2e.spec.ts test/expire-consumer.e2e.spec.ts test/reservations.e2e.spec.ts
```

Expected: PASS unchanged. `releaseStaleHolds` grew an arm that never matches when no payment rows exist, and `settleExpired` grew a branch that never fires without `PAYMENT_PENDING`.

- [ ] **Step 7: Run everything**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/reservations apps/api/test
git commit -m "feat(api): the hold's clock stops, and abandoned payments are reaped

settleExpired answers 'awaiting-payment' for a paying reservation and
leaves it alone: the expire message was published when the hold was taken
and arrives on schedule, but the row no longer belongs to it. expires_at
is never rewritten, so reservation.expire.wait keeps the single TTL
ADR 0024 depends on.

releaseStaleHolds gains a second arm for PAYMENT_PENDING rows whose
payment is older than PAYMENT_DEADLINE_SECONDS. That closes the only
unbounded case — the message reached the DLQ, or the worker died holding
it — and keeps lazy release authoritative for both ways a hold can end."
```

---

## Task 12: The stack

**Files:**

- Create: `apps/payment-provider/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.single-api.yml` (only if it overrides the worker)

- [ ] **Step 1: Write the provider's Dockerfile**

Create `apps/payment-provider/Dockerfile`, following the API's two-stage shape:

```dockerfile
FROM node:24-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/payment-provider/package.json apps/payment-provider/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/payment-provider apps/payment-provider
RUN npm run contracts:build && npm run build -w @cinema/payment-provider

FROM node:24-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/payment-provider/package.json apps/payment-provider/
# --ignore-scripts for the same reason the API image does it: the root
# "prepare" script is husky, a devDependency --omit=dev leaves out.
RUN npm ci --omit=dev --workspace @cinema/payment-provider --include-workspace-root --ignore-scripts \
  && npm cache clean --force

COPY --from=build /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build /repo/apps/payment-provider/dist apps/payment-provider/dist

USER node
EXPOSE 4000
CMD ["node", "apps/payment-provider/dist/main.js"]
```

- [ ] **Step 2: Add the service to compose**

In `docker-compose.yml`, add after `rabbitmq`:

```yaml
  # A separate service and a separate image, not a route on the API: proving
  # the breaker opens means stopping this container, and that must not take the
  # API down with it (ADR 0040). No published port — its only client is the
  # worker, and nothing outside the network has any business charging cards.
  payment-provider:
    build:
      context: .
      dockerfile: apps/payment-provider/Dockerfile
    environment:
      PORT: '4000'
      PROVIDER_SUCCESS_RATE: ${PROVIDER_SUCCESS_RATE:-0.85}
      PROVIDER_DECLINE_RATE: ${PROVIDER_DECLINE_RATE:-0.1}
      PROVIDER_ERROR_RATE: ${PROVIDER_ERROR_RATE:-0.03}
      PROVIDER_TIMEOUT_RATE: ${PROVIDER_TIMEOUT_RATE:-0.02}
      PROVIDER_HANG_MS: ${PROVIDER_HANG_MS:-30000}
    healthcheck:
      test:
        [
          'CMD',
          'node',
          '-e',
          "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 5s
      timeout: 3s
      retries: 10
```

- [ ] **Step 3: Give the API and the worker the payment variables**

Add to the `api` service's `environment` (set unconditionally while the mode defaults to `off`, exactly as `REDIS_URL` and `RABBITMQ_URL` already are):

```yaml
      PAYMENT_MODE: ${PAYMENT_MODE:-off}
      PAYMENT_PROVIDER_URL: http://payment-provider:4000
```

Add to the `worker` service's `environment` the same two lines plus:

```yaml
      PAYMENT_TIMEOUT_MS: ${PAYMENT_TIMEOUT_MS:-2000}
      PAYMENT_DEADLINE_SECONDS: ${PAYMENT_DEADLINE_SECONDS:-300}
      PAYMENT_BREAKER_FAILURE_THRESHOLD: ${PAYMENT_BREAKER_FAILURE_THRESHOLD:-5}
      PAYMENT_BREAKER_OPEN_MS: ${PAYMENT_BREAKER_OPEN_MS:-30000}
```

and extend the worker's `depends_on`:

```yaml
      payment-provider:
        condition: service_healthy
```

The API does **not** depend on the provider: it never calls it. Adding the dependency would make a provider outage delay API startup for no reason.

- [ ] **Step 4: Bring the stack up in the default mode**

```bash
docker compose up --build -d
docker compose ps
```

Expected: `payment-provider` healthy; `worker` exits 0 without restarting (both subsystems are off by default); the API answers.

```bash
curl -s http://localhost:8080/api/v1/movies | head -c 200
docker compose logs worker | tail -5
```

Expected: the worker's line reads `both RESERVATION_EXPIRY_MODE and PAYMENT_MODE are off; the worker has nothing to do`.

- [ ] **Step 5: Bring it up with payments on and drive one through**

```bash
docker compose down
RESERVATION_EXPIRY_MODE=queue PAYMENT_MODE=queue docker compose up --build -d
sleep 20
docker compose logs worker | grep -E "consuming|worker started"
```

Expected: two `consuming` lines — one for `reservation.expire`, one for `payment.requested`.

Then a real booking:

```bash
SESSION=$(python3 -c "import uuid;print(uuid.uuid4())")
SHOWTIME=$(curl -s "http://localhost:8080/api/v1/showtimes?limit=1" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['id'])")
SEAT=$(curl -s "http://localhost:8080/api/v1/showtimes/$SHOWTIME/seats" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['seatId'])")

RES=$(curl -s -X POST http://localhost:8080/api/v1/reservations \
  -H "content-type: application/json" -H "X-Session-Id: $SESSION" \
  -d "{\"showtimeId\":\"$SHOWTIME\",\"seatIds\":[\"$SEAT\"]}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

curl -s -i -X POST "http://localhost:8080/api/v1/reservations/$RES/confirm" \
  -H "X-Session-Id: $SESSION" -H "X-Payment-Scenario: success" | head -1

sleep 3
curl -s "http://localhost:8080/api/v1/reservations/$RES" -H "X-Session-Id: $SESSION" \
  | python3 -m json.tool
```

Expected: the confirm answers `HTTP/1.1 202`, and three seconds later the reservation reads `CONFIRMED` with a `payment` of `SUCCEEDED`.

Adjust the seat-map field name in the `SEAT` line if the endpoint's shape differs — read one response by hand first.

- [ ] **Step 6: Prove the breaker against a stopped container**

```bash
docker compose stop payment-provider
# confirm another reservation the same way, then:
docker compose logs worker | grep -iE "circuit|unavailable" | tail -5
docker compose start payment-provider
docker compose down
```

Expected: warnings naming `ProviderUnavailableError`, then `circuit is open`. The API kept answering `202` throughout.

- [ ] **Step 7: Commit**

```bash
git add apps/payment-provider/Dockerfile docker-compose.yml
git commit -m "feat(infra): run the payment provider beside the worker

Its own image and its own service, with no published port: the worker is
its only client. Proving the breaker opens means stopping this container,
which is exactly why it is not a route on the API.

The API gets PAYMENT_MODE and the provider URL but does not depend on the
provider — it never calls it, and a provider outage has no business
delaying API startup."
```

---

## Task 13: The frontend

Without this the SPA claims a confirmed booking on a `202`, which is the app lying about whether money changed hands.

**Files:**

- Modify: `apps/web/src/shared/api/reservations.ts`
- Create: `apps/web/src/shared/lib/use-reservation.ts`
- Modify: `apps/web/src/features/reservations/reservation-page.tsx`
- Create: `apps/web/src/features/reservations/reservation-page.test.tsx` (or extend the existing one)
- Modify: `apps/web/tests/*` — the Playwright smoke spec

- [ ] **Step 1: Write the failing component test**

Add to the reservation page's test file:

```tsx
it('shows a processing state while the payment is running', async () => {
  renderPage({ status: 'PAYMENT_PENDING', payment: { status: 'PENDING', amountCents: 4500, attempts: 0 } });

  expect(await screen.findByText(/processing payment/i)).toBeInTheDocument();
  // No confirmation and no tickets: nothing has been bought yet.
  expect(screen.queryByText(/confirmed/i)).not.toBeInTheDocument();
});

it('shows the failure and offers another go when the payment is refused', async () => {
  renderPage({ status: 'PAYMENT_FAILED', payment: { status: 'DECLINED', amountCents: 4500, attempts: 1 } });

  expect(await screen.findByText(/payment (was )?(declined|not completed)/i)).toBeInTheDocument();
  // The seats went back to the pool, so the honest offer is a fresh selection
  // rather than a retry button that would race other buyers.
  expect(screen.getByRole('link', { name: /choose seats/i })).toBeInTheDocument();
});
```

Match `renderPage` to whatever the existing tests in that file use; if they render through a router and a query client, reuse that helper rather than adding a second one.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test -w @cinema/web
```

Expected: FAIL — no processing state exists.

- [ ] **Step 3: Let the client accept a 202**

In `apps/web/src/shared/api/reservations.ts`, `confirm` already parses `reservationSchema`, which now carries the two new statuses and the optional `payment`. No change is needed unless `apiFetch` treats anything but `200` as an error — check it, and if it does, widen it to accept any 2xx.

- [ ] **Step 4: Add the polling query**

Create `apps/web/src/shared/lib/use-reservation.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import type { Reservation } from '@cinema/contracts';

import { reservationsApi } from '../api/reservations';
import { queryKeys } from '../api/query-keys';

/** The states from which the reservation can still change on its own. */
const SETTLING = new Set(['PAYMENT_PENDING']);

/**
 * Polls only while a payment is running. The interval is switched off on a
 * terminal status rather than left running on a confirmed booking: a page open
 * in a background tab should not keep asking a question that has been answered.
 */
export function useReservation(id: string) {
  return useQuery<Reservation>({
    queryKey: queryKeys.reservation(id),
    queryFn: () => reservationsApi.get(id),
    refetchInterval: (query) =>
      query.state.data && SETTLING.has(query.state.data.status) ? 1_000 : false,
  });
}
```

Use whatever `queryKeys` helper the file already exposes; add `reservation(id)` to it if it is missing.

- [ ] **Step 5: Render the four outcomes**

In `apps/web/src/features/reservations/reservation-page.tsx`, branch on `status`:

- `PAYMENT_PENDING` — a "Processing payment…" panel with a spinner or a live region, and no seat or ticket detail presented as final.
- `CONFIRMED` — what it renders today.
- `PAYMENT_FAILED` — "Payment was declined. Your seats have been released." plus a link back to the seat map for that showtime.
- `EXPIRED` / `CANCELLED` — what they render today.

Give the processing panel `role="status"` and `aria-live="polite"` so the transition to confirmed is announced rather than silently swapped.

- [ ] **Step 6: Run the web tests**

```bash
npm run test -w @cinema/web
```

Expected: PASS.

- [ ] **Step 7: Extend the smoke test**

In the Playwright spec, after clicking confirm, wait for the settled state instead of asserting immediately:

```ts
  await page.getByRole('button', { name: /confirm/i }).click();
  // In PAYMENT_MODE=queue the confirm answers 202 and the worker finishes the
  // job. In `off` the confirmed panel is there immediately; either way this is
  // the assertion that matters.
  await expect(page.getByText(/confirmed/i)).toBeVisible({ timeout: 15_000 });
```

- [ ] **Step 8: Run the smoke test against the stack**

```bash
RESERVATION_EXPIRY_MODE=queue PAYMENT_MODE=queue PROVIDER_SUCCESS_RATE=1 \
  PROVIDER_DECLINE_RATE=0 PROVIDER_ERROR_RATE=0 PROVIDER_TIMEOUT_RATE=0 \
  docker compose up --build -d
# then the project's usual Playwright command
```

Expected: green. The provider weights are pinned so the smoke test does not roll a decline and fail for a correct reason.

- [ ] **Step 9: Run everything and commit**

```bash
docker compose down
npm test && npm run lint && npm run typecheck
```

```bash
git add apps/web
git commit -m "feat(web): follow a payment to a settled state

The reservation page polls while the status is PAYMENT_PENDING and stops
on a terminal one — a confirmed booking in a background tab should not
keep asking a question that has been answered.

Without this the SPA renders a 202 as a completed sale, which is the app
claiming money changed hands when it has not."
```

---

## Task 14: The record

**Files:**

- Create: `docs/adr/0033-payment-as-a-message.md` … `0040-fake-provider-as-a-separate-service.md`
- Modify: `README.md`

- [ ] **Step 1: Write the eight ADRs**

Each follows the existing format — `# N. Title`, `**Status:** accepted (2026-09-03)`, then `## Context`, `## Decision`, `## Alternatives considered`, `## Consequences`. Read `docs/adr/0029-fail-open-on-broker-failure.md` for the voice before writing.

| File | The decision, and the alternative it must argue against |
| --- | --- |
| `0033-payment-as-a-message.md` | Payment is asynchronous through RabbitMQ; confirm answers 202. Against: a synchronous call in the request, which puts a slow downstream in the user's latency and leaves the phase 4 ladder unused for the one message that costs money. |
| `0034-no-bookings-table.md` | The reservation is the booking; only `payments` is added. Against: `bookings` as spec.md's entity list names it — it would restate the session, seats, prices and total, need its own anti-double-booking rule, and split one lifecycle across two tables without adding an invariant. Supersedes nothing; it *completes* ADR 0013, which deferred exactly this question to this sub-project. |
| `0035-structural-idempotence-and-the-provider-key.md` | No key store; the row lock plus `payments.reservation_id UNIQUE` make five confirms one payment, and `Idempotency-Key: payments.id` is sent where the operation is not addressable. Against: an `Idempotency-Key` header at the API edge — a second identifier for an operation the path already names uniquely, plus a new "same key, different reservation" failure mode. |
| `0036-the-holds-clock-stops.md` | `PAYMENT_PENDING` transfers ownership of the seats; `expires_at` is never rewritten. Against: extending the hold (requires replacing `reservation.expire.wait`, ADR 0024) and against letting expiry win (needs a `/void` compensation path and a new failure mode when the void itself fails). |
| `0037-publish-before-commit.md` | `payment.requested` publishes inside the transaction and throws. Against: ADR 0029's after-the-commit fail-open, which is right for expiry because lazy release is a full backstop and wrong here because nothing is. State the cost — a bounded broker round trip under one row lock — and name it as the outbox seam. |
| `0038-breaker-per-process-and-declines-are-not-failures.md` | One breaker per worker, state in memory, only throws counted. Against: shared state in Redis (puts Redis on the payment path; "what if the breaker state is unreadable" has no good answer) and against a general breaker over Redis and the broker (they have fallback paths; the provider does not). |
| `0039-payment-failed-is-terminal.md` | A declined card costs the hold; retry means a new reservation. Against: a `PAYMENT_FAILED → PENDING` retry edge, which makes the graph cyclic and needs a second attempt bound on top of the ladder. Record the UX cost honestly. |
| `0040-fake-provider-as-a-separate-service.md` | A separate workspace, image and compose service. Against: an in-process fake (a `setTimeout` in your own process is not a timeout, and a breaker that never saw a hung socket is not demonstrated) and against a route on the API (stopping it to prove the breaker would stop the API). |

- [ ] **Step 2: Update the README**

Change the "what exists today" paragraph to name phase 5, and add payment to the layout table:

```markdown
This repository is being built in sub-projects. **Phase 5 — payment,
idempotency and the circuit breaker — is what exists today:** … and now a
payment that travels as a message, is charged through a real HTTP provider
behind a circuit breaker, and cannot be charged twice however the response
is lost.
```

Add to the layout table:

```markdown
| `apps/payment-provider` | A fake payment provider: Fastify, no database, four scenarios. Its own service so that stopping it proves the breaker |
```

And a short section documenting the switches:

```markdown
### Payment

`PAYMENT_MODE=off` by default: confirm answers `200 CONFIRMED` exactly as
it did in phase 2. With `PAYMENT_MODE=queue` (and `RESERVATION_EXPIRY_MODE=queue`):

```bash
RESERVATION_EXPIRY_MODE=queue PAYMENT_MODE=queue docker compose up --build
```

confirm answers `202` with `PAYMENT_PENDING`, the worker charges the
provider, and the reservation settles to `CONFIRMED` or `PAYMENT_FAILED`.
`X-Payment-Scenario: success|decline|error|timeout` on the confirm request
picks the provider's behaviour; without it the `PROVIDER_*_RATE` weights
roll one.
```

- [ ] **Step 3: Check the ADR index if one exists**

```bash
ls docs/adr/README.md docs/adr/index.md 2>/dev/null
```

If either exists, add the eight new rows.

- [ ] **Step 4: Final verification**

```bash
npm test && npm run lint && npm run typecheck && npm run format:check
```

Then both modes end to end:

```bash
PAYMENT_MODE=queue RESERVATION_EXPIRY_MODE=queue npm run test -w @cinema/api
```

- [ ] **Step 5: Commit**

```bash
git add docs README.md
git commit -m "docs: record the phase 5 decisions and how payment became a message

Eight ADRs. The two that carry the most weight are 0037, which inverts
0029's publish ordering and says why the asymmetry is safe in exactly one
direction, and 0036, which explains why the hold's clock stops instead of
being extended — extending it would mean replacing the queue ADR 0024
depends on.

0034 finally answers the question ADR 0013 deferred to this sub-project:
the reservation is the booking, and a bookings table would restate its
identity without adding an invariant."
```

---

## Payment as a message

The shape of the thing, once all fourteen tasks are done:

```
POST /reservations/:id/confirm
  │
  ├─ BEGIN
  │    SELECT ... FOR UPDATE            reservation
  │    PENDING -> PAYMENT_PENDING       (expires_at untouched)
  │    INSERT payments                  id = uuidv7(), UNIQUE per reservation
  │    publish payment.requested        inside the transaction; throws
  │  COMMIT
  └─ 202 { status: "PAYMENT_PENDING" }

                    cinema.commands (direct)
                              │
                    payment.requested
                              │
                    [PaymentConsumer]  prefetch N, own channel
                              │
                    claimPayment       attempts += 1; not-found | terminal | stale
                              │
                    breaker.execute ──► POST /charge
                              │           Idempotency-Key: payments.id
                              │           X-Payment-Scenario: …
                              │
              ┌───────────────┼───────────────┐
        SUCCEEDED         DECLINED       throw (5xx, timeout, breaker open)
              │               │                     │
        CONFIRMED      PAYMENT_FAILED         retry.1 → retry.2 → retry.3
        retain keys    release seats                 │
                                              abandon + payment.requested.dlq
                                              PAYMENT_FAILED, seats released

and, independently of all of it:
  releaseStaleHolds()   PENDING past expires_at            -> EXPIRED
                        PAYMENT_PENDING past the deadline  -> PAYMENT_FAILED
  — lazy, authoritative, and needs neither the broker nor the provider.
```

## Definition of Done

1. `npm run lint`, `npm run typecheck`, `npm test` — green on Node 24.
2. The full suite green in both modes: default (`off`) and `PAYMENT_MODE=queue`.
3. `docker compose up --build` brings up the provider; with both modes on, the worker logs two `consuming` lines.
4. Five concurrent confirms of one reservation produce one `payments` row, one message and five `202`s.
5. The `timeout` scenario followed by a retry produces **one** charge and the same `providerRef`.
6. Stopping the provider container opens the breaker; the API keeps answering `202`; the seats come back through `PAYMENT_FAILED`.
7. Exhausting the ladder puts the message in `payment.requested.dlq` **and** frees the seats.
8. A `reservation.expire` delivered during `PAYMENT_PENDING` answers `awaiting-payment` and takes nothing.
9. A `PAYMENT_PENDING` row older than `PAYMENT_DEADLINE_SECONDS` is reaped by the lazy sweep.
10. Playwright's smoke test reaches a confirmed booking through nginx.
11. Eight ADRs written; README describes phase 5 and its switches.

## Handover to sub-project 6

- **`payments` is the first table where a row means money.** Refunds, payouts and tickets hang off it, and `provider_ref` is what they will quote.
- **`PaymentService` is the only place a domain event should be published from.** `payment.succeeded` and `payment.failed` are the obvious first Kafka events, and both moments are already single lines in one file.
- **Publish-before-commit is an outbox without the table.** It buys back the lost message at the cost of a broker round trip under a row lock. The moment a transaction needs to emit more than one message, that price stops being worth paying — and `uuidv7()` is already there to give outbox rows their ids.
- **Compensation is not written.** §10 of the spec names the one scenario where money moves and no booking exists. A `/void` endpoint on the provider and a refund path are what close it.
- **Three breakers, not one.** Shared breaker state is the first thing to revisit when there are meaningfully more than three workers.
- **The DLQ pair and the breaker are the metrics.** `payment.requested.dlq` depth, `PaymentProviderClient.breakerRejections`, `payments.attempts` and the `created_at`/`settled_at` gap are all in place for sub-project 10 to scrape.
