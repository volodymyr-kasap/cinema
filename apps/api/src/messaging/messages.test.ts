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
