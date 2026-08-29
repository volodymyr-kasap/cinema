import { uuidv7 } from './uuid-v7';

describe('uuidv7', () => {
  it('looks like a UUID', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('declares version 7 and the RFC 9562 variant', () => {
    for (let i = 0; i < 100; i += 1) {
      const id = uuidv7();
      expect(id[14]).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
    }
  });

  it('carries the current time in its first 48 bits', () => {
    const before = Date.now();
    const millis = Number.parseInt(uuidv7().replaceAll('-', '').slice(0, 12), 16);

    expect(millis).toBeGreaterThanOrEqual(before - 1_000);
    expect(millis).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  // The reason for choosing v7 (ADR 0004): ids that sort by creation time keep
  // B-tree inserts local. A generator that is only *roughly* ordered gives that
  // away inside a single millisecond, which is where a burst of holds lands.
  it('is strictly increasing, including within one millisecond', () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7());
    const sorted = [...ids].sort();

    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
