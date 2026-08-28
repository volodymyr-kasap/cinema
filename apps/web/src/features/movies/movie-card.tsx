import type { Movie } from '@cinema/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';

import { catalogApi } from '../../shared/api/catalog';
import { queryKeys } from '../../shared/api/query-keys';
import { Badge } from '../../shared/ui/badge';

export function MovieCard({ movie }: { movie: Movie }) {
  const queryClient = useQueryClient();

  /**
   * Pointing at a card is a strong signal it is about to be opened. Warming the
   * detail route's two queries here makes the navigation feel instant, and
   * costs nothing when the guess is wrong — the cache simply expires.
   */
  const prefetch = (): void => {
    void queryClient.prefetchQuery({
      queryKey: queryKeys.movies.detail(movie.id),
      queryFn: () => catalogApi.getMovie(movie.id),
    });
    void queryClient.prefetchQuery({
      queryKey: queryKeys.showtimes.list({ movieId: movie.id }),
      queryFn: () => catalogApi.listShowtimes({ movieId: movie.id }),
    });
  };

  return (
    <Link
      to={`/movies/${movie.id}`}
      onMouseEnter={prefetch}
      onFocus={prefetch}
      className="group rounded-lg border border-slate-200 p-4 transition hover:border-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 dark:border-slate-800"
    >
      <img
        src={movie.posterUrl}
        alt=""
        className="mb-3 aspect-2/3 w-full rounded-md object-cover"
        loading="lazy"
      />
      <h2 className="font-medium group-hover:text-sky-600">{movie.title}</h2>
      <p className="mt-1 flex items-center gap-2 text-sm text-slate-500">
        <Badge>{movie.rating.toFixed(1)}</Badge>
        <span>{movie.durationMinutes} min</span>
      </p>
    </Link>
  );
}
