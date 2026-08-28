import { http, HttpResponse } from 'msw';

import {
  cinemaFixture,
  makeReservation,
  movieFixture,
  otherMovieFixture,
  seatMapFixture,
  showtimeFixture,
} from './fixtures';

export { SEAT_A1_ID } from './fixtures';

/** Default happy path. Individual tests override with `server.use(...)`. */
export const handlers = [
  http.get('/api/v1/movies', () =>
    HttpResponse.json({ data: [otherMovieFixture, movieFixture], nextCursor: null }),
  ),
  http.get('/api/v1/movies/:id', () => HttpResponse.json(movieFixture)),
  http.get('/api/v1/cinemas', () => HttpResponse.json({ data: [cinemaFixture], nextCursor: null })),
  http.get('/api/v1/showtimes', () =>
    HttpResponse.json({ data: [showtimeFixture], nextCursor: null }),
  ),
  http.get('/api/v1/showtimes/:id', () => HttpResponse.json(showtimeFixture)),
  http.get('/api/v1/showtimes/:id/seats', () => HttpResponse.json(seatMapFixture)),

  http.post('/api/v1/reservations', () => HttpResponse.json(makeReservation(), { status: 201 })),
  http.get('/api/v1/reservations/:id', () => HttpResponse.json(makeReservation())),
  http.post('/api/v1/reservations/:id/confirm', () =>
    HttpResponse.json(makeReservation({ status: 'CONFIRMED' })),
  ),
  http.delete('/api/v1/reservations/:id', () => new HttpResponse(null, { status: 204 })),
];

/**
 * The lost race, as the API reports it: a 409 whose problem document names the
 * seats in an RFC 9457 extension member.
 */
export function conflictOnHold(seatIds: string[]) {
  return http.post('*/api/v1/reservations', () =>
    HttpResponse.json(
      {
        type: 'https://cinema.example/errors/seats-unavailable',
        title: 'Seats unavailable',
        status: 409,
        detail: 'Seats A1 were taken by another reservation',
        instance: '/api/v1/reservations',
        traceId: 'test',
        seatIds,
      },
      { status: 409, headers: { 'content-type': 'application/problem+json' } },
    ),
  );
}
