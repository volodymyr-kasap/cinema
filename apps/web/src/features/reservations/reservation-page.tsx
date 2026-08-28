import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';

import { queryKeys } from '../../shared/api/query-keys';
import { reservationsApi } from '../../shared/api/reservations';
import { formatPrice } from '../../shared/lib/format';
import { useCountdown } from '../../shared/lib/use-countdown';
import { Button } from '../../shared/ui/button';
import { ErrorState } from '../../shared/ui/error-state';
import { Skeleton } from '../../shared/ui/skeleton';

/**
 * The placeholder deadline used while the reservation is still loading. Two
 * things matter about it. It is a constant, because a fresh `new Date()` each
 * render would change the countdown's dependency and restart its interval. And
 * it is in the future, because "we have not loaded it yet" must not read as
 * "expired" -- that would hide the countdown and fire the refetch effect below
 * against a hold that is perfectly alive.
 */
const NO_DEADLINE = new Date(Date.now() + 86_400_000).toISOString();

export function ReservationPage() {
  const { reservationId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const reservation = useQuery({
    queryKey: queryKeys.reservations.detail(reservationId),
    queryFn: () => reservationsApi.get(reservationId),
  });

  const countdown = useCountdown(reservation.data?.expiresAt ?? NO_DEADLINE);
  const hasExpired = reservation.data !== undefined && countdown.hasExpired;

  // The server declares expiry; the client only notices it is time to ask again.
  useEffect(() => {
    if (hasExpired && reservation.data?.status === 'PENDING') {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.reservations.detail(reservationId),
      });
    }
  }, [hasExpired, reservation.data?.status, queryClient, reservationId]);

  const confirm = useMutation({
    mutationFn: () => reservationsApi.confirm(reservationId),
    onSuccess: (updated) => {
      // The confirm response *is* the reservation's new state, so it goes
      // straight into the cache. Invalidating instead would spend a second
      // request to learn what this one already returned.
      queryClient.setQueryData(queryKeys.reservations.detail(reservationId), updated);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.showtimes.seats(updated.showtimeId),
      });
    },
  });

  const cancel = useMutation({
    mutationFn: () => reservationsApi.cancel(reservationId),
    onSuccess: () => {
      const showtimeId = reservation.data?.showtimeId;
      if (!showtimeId) return;
      // 204 returns no body, so here the cache genuinely has to ask again.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.reservations.detail(reservationId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.showtimes.seats(showtimeId) });
      void navigate(`/showtimes/${showtimeId}`);
    },
  });

  if (reservation.isError) {
    return <ErrorState error={reservation.error} onRetry={() => void reservation.refetch()} />;
  }
  if (reservation.isPending) return <Skeleton className="h-64 w-full" />;

  const { status, seats, totalPriceCents, showtimeId } = reservation.data;
  const isPending = status === 'PENDING' && !hasExpired;

  return (
    <section className="mx-auto max-w-xl">
      <h1 className="text-2xl font-semibold">
        {status === 'CONFIRMED' ? 'Booking confirmed' : 'Your seats are held'}
      </h1>

      <ul className="mt-4 space-y-1">
        {seats.map((seat) => (
          <li key={seat.seatId} className="flex justify-between text-sm">
            <span>
              Row {seat.rowLabel}, seat {seat.seatNumber} · {seat.category.toLowerCase()}
            </span>
            <span>{formatPrice(seat.priceCents)}</span>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-lg font-medium">Total {formatPrice(totalPriceCents)}</p>

      {isPending && (
        <>
          {/* Visible every second, announced only at thresholds: a timer read
              aloud once a second is a metronome, not information. */}
          <p data-testid="countdown" aria-hidden className="mt-4 text-3xl tabular-nums">
            {countdown.label}
          </p>
          <p aria-live="polite" className="sr-only">
            {countdown.announcement}
          </p>

          <div className="mt-6 flex gap-3">
            <Button onClick={() => confirm.mutate()} disabled={confirm.isPending}>
              {confirm.isPending ? 'Confirming…' : 'Confirm booking'}
            </Button>
            <Button onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {/* A statement, not a second heading: the h1 above already announces the
          confirmation, and a heading that repeats it just adds a duplicate
          landmark for anyone navigating by headings. */}
      {status === 'CONFIRMED' && <p className="mt-6 text-lg">These seats are yours.</p>}

      {(status === 'EXPIRED' || status === 'CANCELLED' || hasExpired) && status !== 'CONFIRMED' && (
        <p className="mt-6">
          {status === 'CANCELLED'
            ? 'This reservation was cancelled.'
            : 'This hold expired and the seats were released.'}{' '}
          <a className="underline" href={`/showtimes/${showtimeId}`}>
            Choose seats again
          </a>
        </p>
      )}

      {(confirm.isError || cancel.isError) && (
        <p role="alert" className="mt-4 rounded bg-rose-100 p-3 text-sm dark:bg-rose-950">
          {(confirm.error ?? cancel.error)?.message}
        </p>
      )}
    </section>
  );
}
