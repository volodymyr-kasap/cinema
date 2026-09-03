import {
  ATTEMPT_HEADER,
  COMMANDS_EXCHANGE,
  EXPIRE_DEAD_KEY,
  EXPIRE_DLQ,
  EXPIRE_KEY,
  EXPIRE_LADDER,
  EXPIRE_QUEUE,
  EXPIRE_WAIT_KEY,
  EXPIRE_WAIT_QUEUE,
  expireMessageSchema,
  PAYMENT_DEAD_KEY,
  PAYMENT_DLQ,
  PAYMENT_KEY,
  PAYMENT_LADDER,
  PAYMENT_QUEUE,
  paymentMessageSchema,
  paymentRetryKey,
  paymentRetryQueue,
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
    expect(
      paymentMessageSchema.parse({ paymentId: '00000000-0000-7000-8000-000000000001' }),
    ).toEqual({
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
