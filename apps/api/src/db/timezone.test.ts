import { zonedToUtc } from './timezone';

describe('zonedToUtc', () => {
  it('converts Kyiv summer time (UTC+3) to UTC', () => {
    expect(zonedToUtc(2026, 9, 1, 10, 0, 'Europe/Kyiv').toISOString()).toBe(
      '2026-09-01T07:00:00.000Z',
    );
  });

  it('converts Warsaw summer time (UTC+2) to UTC', () => {
    expect(zonedToUtc(2026, 9, 1, 10, 0, 'Europe/Warsaw').toISOString()).toBe(
      '2026-09-01T08:00:00.000Z',
    );
  });

  it('handles a winter date, where the offset differs', () => {
    expect(zonedToUtc(2026, 12, 1, 10, 0, 'Europe/Kyiv').toISOString()).toBe(
      '2026-12-01T08:00:00.000Z',
    );
  });
});
