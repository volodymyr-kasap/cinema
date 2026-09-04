import type { Reservation } from '@cinema/contracts';
import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../api/query-keys';
import { reservationsApi } from '../api/reservations';

/**
 * The states the reservation can still leave on its own, with nobody touching
 * this page. Only one: a payment is running somewhere behind the queue, and the
 * confirm that started it answered `202` rather than an outcome.
 */
const SETTLING = new Set<Reservation['status']>(['PAYMENT_PENDING']);

/**
 * Polls only while a payment is running, and stops on a terminal status rather
 * than leaving the interval on a confirmed booking: a page open in a background
 * tab should not keep asking a question that has been answered.
 */
export function useReservation(id: string) {
  return useQuery({
    queryKey: queryKeys.reservations.detail(id),
    queryFn: () => reservationsApi.get(id),
    refetchInterval: (query) =>
      query.state.data && SETTLING.has(query.state.data.status) ? 1_000 : false,
  });
}
