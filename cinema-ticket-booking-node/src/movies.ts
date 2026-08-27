export interface Movie {
  id: string;
  title: string;
  rows: number;
  seats_per_row: number;
}

/** Static catalogue — the booking flow is the point, not the catalogue. */
export const movies: readonly Movie[] = [
  { id: 'inception', title: 'Inception', rows: 5, seats_per_row: 8 },
  { id: 'dune', title: 'Dune: Part Two', rows: 4, seats_per_row: 6 },
];
