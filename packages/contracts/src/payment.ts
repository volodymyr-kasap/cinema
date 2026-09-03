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
