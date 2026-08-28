import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { catalogApi } from '../../shared/api/catalog';
import { lostSeatIds } from '../../shared/api/client';
import { queryKeys } from '../../shared/api/query-keys';
import { reservationsApi } from '../../shared/api/reservations';
import { ErrorState } from '../../shared/ui/error-state';
import { Skeleton } from '../../shared/ui/skeleton';
import { buildRows } from './build-rows';
import { SeatGrid } from './seat-grid';
import { SelectionSummary } from './selection-summary';

const LEGEND = [
  { label: 'Standard', className: 'bg-slate-200 dark:bg-slate-700' },
  { label: 'VIP', className: 'bg-amber-200 dark:bg-amber-700' },
  { label: 'Recliner', className: 'bg-violet-200 dark:bg-violet-700' },
];

export function SeatMapPage() {
  const { showtimeId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const showtime = useQuery({
    queryKey: queryKeys.showtimes.detail(showtimeId),
    queryFn: () => catalogApi.getShowtime(showtimeId),
  });

  const seats = useQuery({
    queryKey: queryKeys.showtimes.seats(showtimeId),
    queryFn: () => catalogApi.getShowtimeSeats(showtimeId),
    // Seats change under the user while they choose. Five seconds is short
    // enough to see contention and long enough not to be a load generator; a
    // subscription waits for sub-project 5, where Kafka gives it a real reason.
    refetchInterval: 5_000,
    staleTime: 0,
  });

  // Stable, so the memoised seat buttons are not all invalidated on every click.
  const toggle = useCallback((seatId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(seatId)) next.add(seatId);
      return next;
    });
  }, []);

  const hold = useMutation({
    mutationFn: () => reservationsApi.create({ showtimeId, seatIds: [...selected] }),
    onSuccess: (reservation) => {
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: queryKeys.showtimes.seats(showtimeId) });
      void navigate(`/reservations/${reservation.id}`);
    },
    onError: () => {
      // A lost race means the map is out of date; refetch rather than guess.
      void queryClient.invalidateQueries({ queryKey: queryKeys.showtimes.seats(showtimeId) });
    },
  });

  if (seats.isError) return <ErrorState error={seats.error} onRetry={() => void seats.refetch()} />;
  if (showtime.isError)
    return <ErrorState error={showtime.error} onRetry={() => void showtime.refetch()} />;
  if (seats.isPending || showtime.isPending) return <Skeleton className="h-96 w-full" />;

  const rows = buildRows(seats.data.seats);
  const selectedSeats = seats.data.seats.filter((seat) => selected.has(seat.seatId));
  const lostSeats = lostSeatIds(hold.error)
    .map((id) => seats.data.seats.find((seat) => seat.seatId === id))
    .filter((seat) => seat !== undefined)
    .map((seat) => `${seat.rowLabel}${seat.seatNumber}`);

  return (
    <section>
      <h1 className="text-2xl font-semibold">
        {showtime.data.cinemaName} · {seats.data.hallName}
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        {seats.data.seats.length} seats · {showtime.data.format} · {showtime.data.language}
      </p>

      <div className="my-6 h-1.5 w-full rounded-full bg-slate-300 dark:bg-slate-700" aria-hidden />
      <p className="mb-6 text-center text-xs uppercase tracking-widest text-slate-400">Screen</p>

      <SeatGrid rows={rows} selected={selected} onToggle={toggle} />

      <ul className="mt-8 flex flex-wrap gap-4 text-sm">
        {LEGEND.map((item) => (
          <li key={item.label} className="flex items-center gap-2">
            <span aria-hidden className={`size-4 rounded ${item.className}`} />
            {item.label}
          </li>
        ))}
        <li className="flex items-center gap-2">
          <span aria-hidden>×</span> Taken
        </li>
      </ul>

      {hold.isError && (
        <p role="alert" className="mt-4 rounded bg-rose-100 p-3 text-sm dark:bg-rose-950">
          {lostSeats.length > 0
            ? `Seats ${lostSeats.join(', ')} were taken while you were choosing. Pick again.`
            : hold.error.message}
        </p>
      )}

      <SelectionSummary
        seats={selectedSeats}
        isHolding={hold.isPending}
        onHold={() => hold.mutate()}
      />
    </section>
  );
}
