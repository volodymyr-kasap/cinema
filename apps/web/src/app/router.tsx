import { Route, Routes } from 'react-router';

import { MovieDetailPage } from '../features/showtimes/movie-detail-page';
import { MovieListPage } from '../features/movies/movie-list-page';
import { SeatMapPage } from '../features/seat-map/seat-map-page';
import { Layout } from './layout';

/**
 * Declarative routes, no data loaders: TanStack Query already owns loading and
 * caching, and a second mechanism would mean a second place data can go stale.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<MovieListPage />} />
        <Route path="movies/:movieId" element={<MovieDetailPage />} />
        <Route path="showtimes/:showtimeId" element={<SeatMapPage />} />
      </Route>
    </Routes>
  );
}
