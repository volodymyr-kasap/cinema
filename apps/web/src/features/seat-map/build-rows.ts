import type { ShowtimeSeat } from '@cinema/contracts';

export interface SeatRow {
  label: string;
  seats: ShowtimeSeat[];
}

/**
 * The API returns a flat, ordered list; the grid needs rows. Sorting here rather
 * than trusting the order keeps the component correct if the query ever changes.
 */
export function buildRows(seats: ShowtimeSeat[]): SeatRow[] {
  const byRow = new Map<string, ShowtimeSeat[]>();

  for (const seat of seats) {
    const row = byRow.get(seat.rowLabel);
    if (row) row.push(seat);
    else byRow.set(seat.rowLabel, [seat]);
  }

  return [...byRow.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, rowSeats]) => ({
      label,
      seats: [...rowSeats].sort((a, b) => a.seatNumber - b.seatNumber),
    }));
}
