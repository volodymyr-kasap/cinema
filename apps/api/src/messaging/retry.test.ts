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
