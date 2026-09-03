import { describe, expect, it } from 'vitest';

import { chargeRequestSchema, chargeResponseSchema, paymentScenarioSchema } from './payment.js';
import { reservationStatusSchema } from './reservation.js';

describe('payment contracts', () => {
  it('names the four scenarios spec.md section 11 lists', () => {
    expect(paymentScenarioSchema.options).toEqual(['success', 'decline', 'error', 'timeout']);
  });

  it('accepts a charge request and rejects a non-uuid reference', () => {
    expect(
      chargeRequestSchema.parse({
        amountCents: 4500,
        reference: '00000000-0000-7000-8000-000000000001',
      }),
    ).toEqual({ amountCents: 4500, reference: '00000000-0000-7000-8000-000000000001' });
    expect(chargeRequestSchema.safeParse({ amountCents: 4500, reference: 'nope' }).success).toBe(
      false,
    );
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
    expect(chargeResponseSchema.safeParse({ status: 'SUCCEEDED', amountCents: 1 }).success).toBe(
      false,
    );
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
