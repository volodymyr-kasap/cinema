import { http, HttpResponse } from 'msw';

import {
  cinemaFixture,
  movieFixture,
  otherMovieFixture,
  seatMapFixture,
  showtimeFixture,
} from './fixtures';

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
];
