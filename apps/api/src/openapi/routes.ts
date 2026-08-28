import {
  cinemaPageSchema,
  cinemaSchema,
  createReservationSchema,
  movieSchema,
  moviePageSchema,
  paginationQuerySchema,
  reservationPageSchema,
  reservationSchema,
  showtimePageSchema,
  showtimeQuerySchema,
  showtimeSchema,
  showtimeSeatsSchema,
} from '@cinema/contracts';
import type { z } from 'zod';

export interface RouteDoc {
  method: 'get' | 'post' | 'delete';
  /** OpenAPI path template, with `{id}` where Nest writes `:id`. */
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  pathParams: string[];
  query?: z.ZodType;
  body?: z.ZodType;
  /** Documents the `X-Session-Id` header as a required parameter. */
  requiresSession?: boolean;
  /** `undefined` for 204 responses, which carry no body. */
  response?: z.ZodType;
  errors: number[];
}

const ID_PARAM = ['id'];

export const ROUTES: RouteDoc[] = [
  {
    method: 'get',
    path: '/api/v1/movies',
    operationId: 'listMovies',
    summary: 'List movies, ordered by title',
    tags: ['catalogue'],
    pathParams: [],
    query: paginationQuerySchema,
    response: moviePageSchema,
    errors: [400],
  },
  {
    method: 'get',
    path: '/api/v1/movies/{id}',
    operationId: 'getMovie',
    summary: 'Fetch one movie',
    tags: ['catalogue'],
    pathParams: ID_PARAM,
    response: movieSchema,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/api/v1/cinemas',
    operationId: 'listCinemas',
    summary: 'List cinemas, ordered by name',
    tags: ['catalogue'],
    pathParams: [],
    query: paginationQuerySchema,
    response: cinemaPageSchema,
    errors: [400],
  },
  {
    method: 'get',
    path: '/api/v1/cinemas/{id}',
    operationId: 'getCinema',
    summary: 'Fetch one cinema',
    tags: ['catalogue'],
    pathParams: ID_PARAM,
    response: cinemaSchema,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/api/v1/showtimes',
    operationId: 'listShowtimes',
    summary: 'List showtimes, ordered by start time',
    tags: ['catalogue'],
    pathParams: [],
    query: showtimeQuerySchema,
    response: showtimePageSchema,
    errors: [400],
  },
  {
    method: 'get',
    path: '/api/v1/showtimes/{id}',
    operationId: 'getShowtime',
    summary: 'Fetch one showtime',
    tags: ['catalogue'],
    pathParams: ID_PARAM,
    response: showtimeSchema,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/api/v1/showtimes/{id}/seats',
    operationId: 'getShowtimeSeats',
    summary: 'Fetch the seat map of a showtime, with prices and availability',
    tags: ['catalogue'],
    pathParams: ID_PARAM,
    response: showtimeSeatsSchema,
    errors: [400, 404],
  },
  {
    method: 'post',
    path: '/api/v1/reservations',
    operationId: 'createReservation',
    summary: 'Hold seats for a showtime',
    tags: ['reservations'],
    pathParams: [],
    body: createReservationSchema,
    requiresSession: true,
    response: reservationSchema,
    errors: [400, 404, 409],
  },
  {
    method: 'get',
    path: '/api/v1/reservations',
    operationId: 'listReservations',
    summary: "List this session's reservations, newest first",
    tags: ['reservations'],
    pathParams: [],
    query: paginationQuerySchema,
    requiresSession: true,
    response: reservationPageSchema,
    errors: [400],
  },
  {
    method: 'get',
    path: '/api/v1/reservations/{id}',
    operationId: 'getReservation',
    summary: 'Fetch one reservation of this session',
    tags: ['reservations'],
    pathParams: ID_PARAM,
    requiresSession: true,
    response: reservationSchema,
    errors: [400, 404],
  },
  {
    method: 'delete',
    path: '/api/v1/reservations/{id}',
    operationId: 'cancelReservation',
    summary: 'Cancel a reservation and release its seats',
    tags: ['reservations'],
    pathParams: ID_PARAM,
    requiresSession: true,
    errors: [400, 404, 409],
  },
  {
    method: 'post',
    path: '/api/v1/reservations/{id}/confirm',
    operationId: 'confirmReservation',
    summary: 'Confirm a pending reservation',
    tags: ['reservations'],
    pathParams: ID_PARAM,
    requiresSession: true,
    response: reservationSchema,
    errors: [400, 404, 409],
  },
];
