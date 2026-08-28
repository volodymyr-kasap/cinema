import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { catalogApi } from '../../shared/api/catalog';
import { queryKeys } from '../../shared/api/query-keys';
import { ErrorState } from '../../shared/ui/error-state';
import { Skeleton } from '../../shared/ui/skeleton';
import { buildRows } from './build-rows';
import { SeatGrid } from './seat-grid';

const LEGEND = [
  { label: 'Standard', className: 'bg-slate-200 dark:bg-slate-700' },
  { label: 'VIP', className: 'bg-amber-200 dark:bg-amber-700' },
  { label: 'Recliner', className: 'bg-violet-200 dark:bg-violet-700' },
];

export function SeatMapPage() {
  const { showtimeId = '' } = useParams();

  const showtime = useQuery({
    queryKey: queryKeys.showtimes.detail(showtimeId),
    queryFn: () => catalogApi.getShowtime(showtimeId),
  });

  const seats = useQuery({
    queryKey: queryKeys.showtimes.seats(showtimeId),
    // Sub-project 2 turns this into a live view; 30 s keeps the shape now.
    staleTime: 30_000,
    queryFn: () => catalogApi.getShowtimeSeats(showtimeId),
  });

  if (seats.isError) return <ErrorState error={seats.error} onRetry={() => void seats.refetch()} />;
  if (showtime.isError)
    return <ErrorState error={showtime.error} onRetry={() => void showtime.refetch()} />;
  if (seats.isPending || showtime.isPending) return <Skeleton className="h-96 w-full" />;

  const rows = buildRows(seats.data.seats);

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

      <SeatGrid rows={rows} />

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
    </section>
  );
}
