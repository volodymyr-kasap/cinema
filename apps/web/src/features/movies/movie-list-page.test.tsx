import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';

import { movieFixture, otherMovieFixture } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { server } from '../../test/server';
import { MovieListPage } from './movie-list-page';

describe('MovieListPage', () => {
  it('shows a skeleton while loading, then the movies', async () => {
    renderWithProviders(<MovieListPage />);

    expect(screen.getByTestId('movie-list-skeleton')).toBeInTheDocument();

    expect(await screen.findByRole('link', { name: /Arrival/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dune: Part Two/ })).toBeInTheDocument();
  });

  it('links each movie to its detail route', async () => {
    renderWithProviders(<MovieListPage />);

    const link = await screen.findByRole('link', { name: /Dune: Part Two/ });
    expect(link).toHaveAttribute('href', `/movies/${movieFixture.id}`);
  });

  it('loads the next page when asked and appends it', async () => {
    let call = 0;
    server.use(
      http.get('/api/v1/movies', () => {
        call += 1;
        return call === 1
          ? HttpResponse.json({ data: [otherMovieFixture], nextCursor: 'cursor-2' })
          : HttpResponse.json({ data: [movieFixture], nextCursor: null });
      }),
    );

    renderWithProviders(<MovieListPage />);

    await screen.findByRole('link', { name: /Arrival/ });
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByRole('link', { name: /Dune: Part Two/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Arrival/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument(),
    );
  });

  it('renders an empty state when the catalogue is empty', async () => {
    server.use(http.get('/api/v1/movies', () => HttpResponse.json({ data: [], nextCursor: null })));

    renderWithProviders(<MovieListPage />);

    expect(await screen.findByText(/no movies/i)).toBeInTheDocument();
  });

  it('renders the problem detail and a retry when the request fails', async () => {
    server.use(
      http.get('/api/v1/movies', () =>
        HttpResponse.json(
          {
            type: 'https://cinema.example/errors/internal',
            title: 'Internal server error',
            status: 500,
            detail: 'The request could not be processed',
            instance: '/api/v1/movies',
            traceId: 'trace-9',
          },
          { status: 500 },
        ),
      ),
    );

    renderWithProviders(<MovieListPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The request could not be processed',
    );
    expect(screen.getByText(/trace-9/)).toBeInTheDocument();
  });
});
