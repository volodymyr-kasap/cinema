export interface HallSpec {
  name: string;
  rows: number;
  seatsPerRow: number;
}

export interface CinemaSpec {
  name: string;
  city: string;
  address: string;
  timezone: string;
  halls: HallSpec[];
}

export const SEAT_CATEGORIES = [
  { code: 'STANDARD', label: 'Standard', surchargeCents: 0 },
  { code: 'VIP', label: 'VIP', surchargeCents: 8_000 },
  { code: 'RECLINER', label: 'Recliner', surchargeCents: 15_000 },
] as const;

export const USERS = [
  { email: 'ada@example.com', displayName: 'Ada' },
  { email: 'grace@example.com', displayName: 'Grace' },
  { email: 'linus@example.com', displayName: 'Linus' },
] as const;

export const MOVIES = [
  { title: 'Dune: Part Two', durationMinutes: 166, releaseDate: '2024-03-01', rating: 8.5 },
  { title: 'Inception', durationMinutes: 148, releaseDate: '2010-07-16', rating: 8.8 },
  { title: 'Arrival', durationMinutes: 116, releaseDate: '2016-11-11', rating: 7.9 },
  { title: 'Blade Runner 2049', durationMinutes: 164, releaseDate: '2017-10-06', rating: 8.0 },
  { title: 'Interstellar', durationMinutes: 169, releaseDate: '2014-11-07', rating: 8.7 },
  { title: 'The Prestige', durationMinutes: 130, releaseDate: '2006-10-20', rating: 8.5 },
  { title: 'Whiplash', durationMinutes: 106, releaseDate: '2014-10-10', rating: 8.5 },
  { title: 'Parasite', durationMinutes: 132, releaseDate: '2019-05-30', rating: 8.5 },
  { title: 'Sicario', durationMinutes: 121, releaseDate: '2015-09-18', rating: 7.6 },
  { title: 'Her', durationMinutes: 126, releaseDate: '2013-12-18', rating: 8.0 },
] as const;

/** The Premiere hall is 25 x 40 = 1000 seats — the hall sub-project 3 runs its load experiment against. */
export const CINEMAS: CinemaSpec[] = [
  {
    name: 'Zoryany',
    city: 'Kyiv',
    address: 'Velyka Vasylkivska 41',
    timezone: 'Europe/Kyiv',
    halls: [
      { name: 'Premiere', rows: 25, seatsPerRow: 40 },
      { name: 'Blue', rows: 10, seatsPerRow: 14 },
      { name: 'Green', rows: 8, seatsPerRow: 12 },
      { name: 'Red', rows: 6, seatsPerRow: 10 },
    ],
  },
  {
    name: 'Kinopalats',
    city: 'Lviv',
    address: 'Teatralna 22',
    timezone: 'Europe/Kyiv',
    halls: [
      { name: 'Halyna', rows: 12, seatsPerRow: 16 },
      { name: 'Ivan', rows: 8, seatsPerRow: 12 },
      { name: 'Lesya', rows: 6, seatsPerRow: 10 },
      { name: 'Taras', rows: 10, seatsPerRow: 14 },
    ],
  },
  {
    name: 'Muranow',
    city: 'Warsaw',
    address: 'Andersa 1',
    timezone: 'Europe/Warsaw',
    halls: [
      { name: 'Alfa', rows: 12, seatsPerRow: 16 },
      { name: 'Beta', rows: 8, seatsPerRow: 12 },
      { name: 'Gamma', rows: 6, seatsPerRow: 10 },
      { name: 'Delta', rows: 10, seatsPerRow: 14 },
    ],
  },
];

/** Local wall-clock start times. 3.5 h apart, which clears the longest film plus cleaning. */
export const SLOTS = [
  { hour: 10, minute: 0 },
  { hour: 13, minute: 30 },
  { hour: 17, minute: 0 },
  { hour: 20, minute: 30 },
] as const;

export const FORMATS = ['TWO_D', 'THREE_D', 'IMAX'] as const;
export const LANGUAGES = ['uk', 'en', 'pl'] as const;

/**
 * A rolling window anchored on tomorrow, not a literal date.
 *
 * This was `{ year: 2026, month: 9, day: 1 }`, written as "a window of future
 * dates" — true only until the calendar reached it. On 2026-09-02 the seeded
 * catalogue covered the present and the past, so every hold against the first
 * showtimes the API returns was refused with SHOWTIME_ALREADY_STARTED, taking
 * the Playwright smoke test with it. Anchoring on tomorrow means the whole
 * window is in the future whatever the date and whatever the hour, since the
 * earliest slot of day 0 is still a day away.
 */
export function seedStartDate(): { year: number; month: number; day: number } {
  const anchor = new Date();
  anchor.setDate(anchor.getDate() + 1);
  return { year: anchor.getFullYear(), month: anchor.getMonth() + 1, day: anchor.getDate() };
}
export const SEED_DAYS = 14;
export const CLEANING_MINUTES = 30;
export const BASE_PRICE_CENTS = 15_000;

/** A, B, ... Y — 25 letters is exactly the Premiere hall's row count. */
export function rowLabel(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

/** Front half standard, then VIP, last two rows recliners. Deterministic, no randomness. */
export function categoryForRow(rowIndex: number, totalRows: number): string {
  if (rowIndex >= totalRows - 2) return 'RECLINER';
  if (rowIndex >= Math.floor(totalRows / 2)) return 'VIP';
  return 'STANDARD';
}
