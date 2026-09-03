import { sql } from 'drizzle-orm';

import type { Database } from '../src/db/drizzle.module';

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
