import { EXPIRE_LADDER, PAYMENT_LADDER } from './messages';
import { attemptOf, nextHop } from './retry';

const ladder = [5_000, 30_000, 120_000];

describe('nextHop', () => {
  it('sends a first failure to the first tier', () => {
    // x-attempt counts failures so far, so a message the producer published
    // (attempt 0) that has now failed once goes to tier 1 carrying 1.
    expect(nextHop(0, ladder, EXPIRE_LADDER)).toEqual({
      routingKey: 'reservation.expire.retry.1',
      attempt: 1,
      dead: false,
    });
  });

  it('walks the ladder one tier at a time', () => {
    expect(nextHop(1, ladder, EXPIRE_LADDER).routingKey).toBe('reservation.expire.retry.2');
    expect(nextHop(2, ladder, EXPIRE_LADDER).routingKey).toBe('reservation.expire.retry.3');
  });

  it('dead-letters once the tiers are exhausted', () => {
    // Three tiers means the handler runs at most four times: the original
    // delivery plus one per tier.
    expect(nextHop(3, ladder, EXPIRE_LADDER)).toEqual({
      routingKey: 'reservation.expire.dead',
      attempt: 4,
      dead: true,
    });
  });

  it('dead-letters immediately when the ladder has one rung', () => {
    expect(nextHop(1, [100], EXPIRE_LADDER).dead).toBe(true);
  });
});

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
