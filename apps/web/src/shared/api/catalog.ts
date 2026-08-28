import {
  cinemaPageSchema,
  moviePageSchema,
  movieSchema,
  showtimePageSchema,
  showtimeSchema,
  showtimeSeatsSchema,
  type Cinema,
  type Movie,
  type Page,
  type Showtime,
  type ShowtimeSeats,
} from '@cinema/contracts';

import { apiFetch } from './client';
import type { ShowtimeFilters } from './query-keys';

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export const catalogApi = {
  listMovies: (params: { cursor?: string; limit: number }): Promise<Page<Movie>> =>
    apiFetch(`/api/v1/movies${query(params)}`, moviePageSchema),

  getMovie: (id: string): Promise<Movie> => apiFetch(`/api/v1/movies/${id}`, movieSchema),

  listCinemas: (): Promise<Page<Cinema>> => apiFetch('/api/v1/cinemas?limit=100', cinemaPageSchema),

  listShowtimes: (filters: ShowtimeFilters): Promise<Page<Showtime>> =>
    apiFetch(`/api/v1/showtimes${query({ ...filters, limit: 100 })}`, showtimePageSchema),

  getShowtime: (id: string): Promise<Showtime> =>
    apiFetch(`/api/v1/showtimes/${id}`, showtimeSchema),

  getShowtimeSeats: (id: string): Promise<ShowtimeSeats> =>
    apiFetch(`/api/v1/showtimes/${id}/seats`, showtimeSeatsSchema),
};
