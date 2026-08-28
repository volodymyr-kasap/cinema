export interface ShowtimeFilters {
  movieId?: string;
  cinemaId?: string;
  date?: string;
}

/**
 * One typed place for every key. Sub-project 2 invalidates seat maps after a
 * hold; a stringly-typed key written at the call site would silently miss.
 */
export const queryKeys = {
  movies: {
    all: ['movies'] as const,
    list: (limit: number) => ['movies', 'list', { limit }] as const,
    detail: (id: string) => ['movies', 'detail', id] as const,
  },
  cinemas: {
    all: ['cinemas'] as const,
    list: () => ['cinemas', 'list'] as const,
  },
  showtimes: {
    all: ['showtimes'] as const,
    list: (filters: ShowtimeFilters) => ['showtimes', 'list', filters] as const,
    detail: (id: string) => ['showtimes', 'detail', id] as const,
    seats: (id: string) => ['showtimes', 'seats', id] as const,
  },
  reservations: {
    all: ['reservations'] as const,
    list: () => ['reservations', 'list'] as const,
    detail: (id: string) => ['reservations', 'detail', id] as const,
  },
} as const;
