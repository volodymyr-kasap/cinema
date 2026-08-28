import { describe, expect, it } from 'vitest';

import { formatPrice, formatShowtimeDay, formatShowtimeTime } from './format';

describe('formatPrice', () => {
  it('renders minor units as hryvnia', () => {
    expect(formatPrice(15_000)).toBe('150 ₴');
    expect(formatPrice(23_050)).toBe('230,50 ₴');
  });

  it('renders a free seat as zero rather than an empty string', () => {
    expect(formatPrice(0)).toBe('0 ₴');
  });
});

describe('formatShowtimeTime', () => {
  it('renders a UTC instant in the cinema local zone', () => {
    expect(formatShowtimeTime('2026-09-01T07:00:00.000Z', 'Europe/Kyiv')).toBe('10:00');
    expect(formatShowtimeTime('2026-09-01T07:00:00.000Z', 'Europe/Warsaw')).toBe('09:00');
  });
});

describe('formatShowtimeDay', () => {
  it('renders the calendar day in the cinema local zone', () => {
    expect(formatShowtimeDay('2026-09-01T21:30:00.000Z', 'Europe/Kyiv')).toBe('2026-09-02');
    expect(formatShowtimeDay('2026-09-01T21:30:00.000Z', 'Europe/Warsaw')).toBe('2026-09-01');
  });
});
