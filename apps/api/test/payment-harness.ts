import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';

import type { Database } from '../src/db/drizzle.module';
import { PaymentService } from '../src/payments/payment.service';
import { PaymentConsumer } from '../src/worker/payment.consumer';
import { WorkerModule } from '../src/worker/worker.module';

export type PaymentRow = {
  id: string;
  reservationId: string;
  status: string;
  amountCents: number;
  providerRef: string | null;
  attempts: number;
  scenario: string | null;
  settledAt: string | null;
};

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
