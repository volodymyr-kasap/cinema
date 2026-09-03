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
