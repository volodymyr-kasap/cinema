import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';

import { catalogApi } from '../../shared/api/catalog';
import { queryKeys } from '../../shared/api/query-keys';
import { Button } from '../../shared/ui/button';
import { EmptyState } from '../../shared/ui/empty-state';
import { ErrorState } from '../../shared/ui/error-state';
import { Skeleton } from '../../shared/ui/skeleton';
import { MovieCard } from './movie-card';

const PAGE_SIZE = 12;

export function MovieListPage() {
  const query = useInfiniteQuery({
    queryKey: queryKeys.movies.list(PAGE_SIZE),
    queryFn: ({ pageParam }) =>
      catalogApi.listMovies({ limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Keeps the rendered list in place while the next page is in flight, instead
    // of collapsing the grid back to a skeleton.
    placeholderData: keepPreviousData,
  });

  if (query.isPending) {
    return (
      <div data-testid="movie-list-skeleton" className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="aspect-2/3 w-full" />
        ))}
      </div>
    );
  }

  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const movies = query.data.pages.flatMap((page) => page.data);

  if (movies.length === 0) {
    return <EmptyState title="No movies yet" description="The catalogue is empty." />;
  }

  return (
    <section aria-labelledby="movies-heading">
      <h1 id="movies-heading" className="mb-6 text-2xl font-semibold">
        Now showing
      </h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {movies.map((movie) => (
          <MovieCard key={movie.id} movie={movie} />
        ))}
      </div>

      {query.hasNextPage ? (
        <div className="mt-8 flex justify-center">
          <Button onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
