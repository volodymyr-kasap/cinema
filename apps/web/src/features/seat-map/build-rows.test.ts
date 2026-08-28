import type { ShowtimeSeat } from '@cinema/contracts';
import { describe, expect, it } from 'vitest';

import { buildRows } from './build-rows';

const seat = (rowLabel: string, seatNumber: number): ShowtimeSeat => ({
  seatId: `${rowLabel}${seatNumber}`,
  rowLabel,
  seatNumber,
  category: 'STANDARD',
  priceCents: 15_000,
  status: 'AVAILABLE',
});

describe('buildRows', () => {
  it('groups a flat seat list into rows', () => {
    const rows = buildRows([seat('A', 1), seat('A', 2), seat('B', 1)]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.label).toBe('A');
    expect(rows[0]?.seats).toHaveLength(2);
    expect(rows[1]?.label).toBe('B');
  });

  it('orders rows and seats regardless of the order they arrive in', () => {
    const rows = buildRows([seat('B', 2), seat('A', 3), seat('B', 1), seat('A', 1)]);

    expect(rows.map((row) => row.label)).toEqual(['A', 'B']);
    expect(rows[0]?.seats.map((s) => s.seatNumber)).toEqual([1, 3]);
    expect(rows[1]?.seats.map((s) => s.seatNumber)).toEqual([1, 2]);
  });

  it('handles a hall with rows of unequal length', () => {
    const rows = buildRows([seat('A', 1), seat('B', 1), seat('B', 2), seat('B', 3)]);

    expect(rows.map((row) => row.seats.length)).toEqual([1, 3]);
  });

  it('returns nothing for an empty hall', () => {
    expect(buildRows([])).toEqual([]);
  });
});
