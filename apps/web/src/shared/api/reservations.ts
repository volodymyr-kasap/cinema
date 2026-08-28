import {
  reservationPageSchema,
  reservationSchema,
  type CreateReservation,
  type Page,
  type Reservation,
} from '@cinema/contracts';
import { z } from 'zod';

import { apiFetch } from './client';

export const reservationsApi = {
  create: (input: CreateReservation): Promise<Reservation> =>
    apiFetch('/api/v1/reservations', reservationSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),

  get: (id: string): Promise<Reservation> =>
    apiFetch(`/api/v1/reservations/${id}`, reservationSchema),

  list: (): Promise<Page<Reservation>> =>
    apiFetch('/api/v1/reservations?limit=20', reservationPageSchema),

  confirm: (id: string): Promise<Reservation> =>
    apiFetch(`/api/v1/reservations/${id}/confirm`, reservationSchema, { method: 'POST' }),

  // 204 carries no body; `z.void()` is what the parse of an empty response
  // needs to succeed.
  cancel: (id: string): Promise<void> =>
    apiFetch(`/api/v1/reservations/${id}`, z.void(), { method: 'DELETE' }),
};
