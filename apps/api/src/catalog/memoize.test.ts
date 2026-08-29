import { singleFlight } from './memoize';

describe('singleFlight', () => {
  it('loads once and reuses the value', async () => {
    const cache = new Map<string, Promise<number>>();
    let loads = 0;
    const load = () => {
      loads += 1;
      return Promise.resolve(42);
    };

    await expect(singleFlight(cache, 'k', load)).resolves.toBe(42);
    await expect(singleFlight(cache, 'k', load)).resolves.toBe(42);
    expect(loads).toBe(1);
  });

  // The case this exists for: a thousand losers hitting a cold cache at once
  // must produce one query, not a thousand. Caching the promise rather than the
  // resolved value is the whole trick.
  it('loads once under concurrent misses', async () => {
    const cache = new Map<string, Promise<number>>();
    let loads = 0;
    const load = () => {
      loads += 1;
      return new Promise<number>((resolve) => setTimeout(() => resolve(1), 10));
    };

    await Promise.all(Array.from({ length: 1_000 }, () => singleFlight(cache, 'k', load)));

    expect(loads).toBe(1);
  });

  // A failed load must not be remembered as the answer, or one bad moment
  // poisons the key for the lifetime of the process.
  it('forgets a rejected load', async () => {
    const cache = new Map<string, Promise<number>>();
    let attempts = 0;
    const load = () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('nope')) : Promise.resolve(7);
    };

    await expect(singleFlight(cache, 'k', load)).rejects.toThrow('nope');
    await expect(singleFlight(cache, 'k', load)).resolves.toBe(7);
    expect(cache.size).toBe(1);
  });
});
