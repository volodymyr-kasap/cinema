import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useParams } from 'react-router';

import { catalogApi } from '../../shared/api/catalog';
import { queryKeys } from '../../shared/api/query-keys';
import { EmptyState } from '../../shared/ui/empty-state';
import { ErrorState } from '../../shared/ui/error-state';
import { Skeleton } from '../../shared/ui/skeleton';
import { ShowtimeFilters, type ShowtimeFilterValue } from './showtime-filters';
import { ShowtimeList } from './showtime-list';

export function MovieDetailPage() {
  const { movieId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Filters live in the URL, not in component state: the selection is shareable
   * and the back button works. This is also why the app needs no client-state
   * store at this stage.
   */
  const filters: ShowtimeFilterValue = {
    cinemaId: searchParams.get('cinemaId') ?? undefined,
    date: searchParams.get('date') ?? undefined,
  };

  const applyFilters = (next: ShowtimeFilterValue): void => {
    const params = new URLSearchParams();
    if (next.cinemaId) params.set('cinemaId', next.cinemaId);
    if (next.date) params.set('date', next.date);
    setSearchParams(params, { replace: true });
  };

  const movie = useQuery({
    queryKey: queryKeys.movies.detail(movieId),
    queryFn: () => catalogApi.getMovie(movieId),
  });

  const cinemas = useQuery({
    queryKey: queryKeys.cinemas.list(),
    queryFn: () => catalogApi.listCinemas(),
  });

  const showtimes = useQuery({
    queryKey: queryKeys.showtimes.list({ movieId, ...filters }),
    queryFn: () => catalogApi.listShowtimes({ movieId, ...filters }),
  });

  if (movie.isError) return <ErrorState error={movie.error} onRetry={() => void movie.refetch()} />;
  if (movie.isPending) return <Skeleton className="h-40 w-full" />;

  const cinemaList = cinemas.data?.data ?? [];
  const cinemasById = new Map(cinemaList.map((cinema) => [cinema.id, cinema]));

  return (
    <article>
      <header className="mb-8 flex flex-col gap-4 md:flex-row">
        <img src={movie.data.posterUrl} alt="" className="w-48 rounded-lg object-cover" />
        <div>
          <h1 className="text-2xl font-semibold">{movie.data.title}</h1>
          <p className="mt-2 text-sm text-slate-500">
            {movie.data.durationMinutes} min · {movie.data.rating.toFixed(1)} ·{' '}
            {movie.data.releaseDate}
          </p>
          <p className="mt-4 max-w-prose">{movie.data.description}</p>
        </div>
      </header>

      <h2 className="mb-4 text-xl font-semibold">Showtimes</h2>
      <ShowtimeFilters cinemas={cinemaList} value={filters} onChange={applyFilters} />

      {showtimes.isPending ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : showtimes.isError ? (
        <ErrorState error={showtimes.error} onRetry={() => void showtimes.refetch()} />
      ) : showtimes.data.data.length === 0 ? (
        <EmptyState
          title="No showtimes match these filters"
          description="Try another date or another cinema."
        />
      ) : (
        <ShowtimeList showtimes={showtimes.data.data} cinemasById={cinemasById} />
      )}
    </article>
  );
}
