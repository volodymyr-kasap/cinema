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
