import type { Cinema, Movie, Reservation, Showtime, ShowtimeSeats } from '@cinema/contracts';

export const movieFixture: Movie = {
  id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60',
  title: 'Dune: Part Two',
  description: 'Seeded catalogue entry.',
  durationMinutes: 166,
  posterUrl: 'https://images.example/posters/dune-part-two.jpg',
  releaseDate: '2024-03-01',
  rating: 8.5,
};

export const otherMovieFixture: Movie = {
  ...movieFixture,
  id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b61',
  title: 'Arrival',
  durationMinutes: 116,
  rating: 7.9,
};

export const cinemaFixture: Cinema = {
  id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b70',
  name: 'Zoryany',
  city: 'Kyiv',
  address: 'Velyka Vasylkivska 41',
  timezone: 'Europe/Kyiv',
};

export const showtimeFixture: Showtime = {
  id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b80',
  movieId: movieFixture.id,
  hallId: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b90',
  hallName: 'Premiere',
  cinemaId: cinemaFixture.id,
  cinemaName: cinemaFixture.name,
  startsAt: '2026-09-01T07:00:00.000Z',
  endsAt: '2026-09-01T10:16:00.000Z',
  basePriceCents: 15_000,
  language: 'uk',
  format: 'TWO_D',
};

/** A 3 x 4 hall — small enough to assert on, shaped like the real thing. */
export const seatMapFixture: ShowtimeSeats = {
  showtimeId: showtimeFixture.id,
  hallId: showtimeFixture.hallId,
  hallName: showtimeFixture.hallName,
  seats: ['A', 'B', 'C'].flatMap((rowLabel, rowIndex) =>
    [1, 2, 3, 4].map((seatNumber) => ({
      seatId: `019298a1-7c4e-7c3a-8f21-2f4a9c1d5${rowIndex}${seatNumber}0`,
      rowLabel,
      seatNumber,
      category: rowIndex === 2 ? ('VIP' as const) : ('STANDARD' as const),
      priceCents: rowIndex === 2 ? 23_000 : 15_000,
      // Row A seat 3 is held by a stranger, so the map has one seat that must
      // render as unavailable and must not be selectable.
      status: rowLabel === 'A' && seatNumber === 3 ? ('HELD' as const) : ('AVAILABLE' as const),
      heldByYou: false,
    })),
  ),
};

/** Row A seat 1 — the seat the seat-map tests select and lose. */
export const SEAT_A1_ID = seatMapFixture.seats.find(
  (seat) => seat.rowLabel === 'A' && seat.seatNumber === 1,
)!.seatId;

export function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: '019298a1-7c4e-7c3a-8f21-000000000090',
    showtimeId: showtimeFixture.id,
    status: 'PENDING',
    totalPriceCents: 45_000,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString(),
    seats: [
      {
        seatId: '019298a1-7c4e-7c3a-8f21-000000000002',
        rowLabel: 'C',
        seatNumber: 7,
        category: 'VIP',
        priceCents: 45_000,
      },
    ],
    ...overrides,
  };
}
