import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { cinemaFixture, movieFixture, showtimeFixture } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { server } from '../../test/server';
import { MovieDetailPage } from './movie-detail-page';

function renderPage(route = `/movies/${movieFixture.id}`) {
  return renderWithProviders(
    <Routes>
      <Route path="movies/:movieId" element={<MovieDetailPage />} />
    </Routes>,
    { route },
  );
}

describe('MovieDetailPage', () => {
  it('shows the movie and its showtimes in the cinema local time', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Dune: Part Two/ })).toBeInTheDocument();
    // 07:00Z in Europe/Kyiv is 10:00 local.
    expect(await screen.findByRole('link', { name: /10:00/ })).toHaveAttribute(
      'href',
      `/showtimes/${showtimeFixture.id}`,
    );
  });

  it('reads the initial filters from the URL', async () => {
    renderPage(`/movies/${movieFixture.id}?cinemaId=${cinemaFixture.id}&date=2026-09-03`);

    await screen.findByRole('heading', { name: /Dune: Part Two/ });

    expect(await screen.findByLabelText(/cinema/i)).toHaveValue(cinemaFixture.id);
    expect(screen.getByLabelText(/date/i)).toHaveValue('2026-09-03');
  });

  it('writes a changed filter back into the URL and refetches', async () => {
    const requested: string[] = [];
    server.use(
      http.get('/api/v1/showtimes', ({ request }) => {
        requested.push(new URL(request.url).searchParams.get('date') ?? '');
        return HttpResponse.json({ data: [showtimeFixture], nextCursor: null });
      }),
    );

    renderPage();
    await screen.findByRole('heading', { name: /Dune: Part Two/ });

    // Ruling R6: userEvent.type does not reliably populate input[type=date] in
    // jsdom — it types character by character and the control rejects the
    // intermediate values. fireEvent.change sets the value in one step.
    fireEvent.change(await screen.findByLabelText(/date/i), { target: { value: '2026-09-05' } });

    await waitFor(() => expect(requested).toContain('2026-09-05'));
  });

  it('offers a reset when the filters exclude every showtime', async () => {
    server.use(
      http.get('/api/v1/showtimes', () => HttpResponse.json({ data: [], nextCursor: null })),
    );

    renderPage(`/movies/${movieFixture.id}?date=2026-12-25`);

    expect(await screen.findByText(/no showtimes/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /clear filters/i }));

    await waitFor(() => expect(screen.getByLabelText(/date/i)).toHaveValue(''));
  });

  it('renders a problem document as an alert', async () => {
    server.use(
      http.get('/api/v1/movies/:id', () =>
        HttpResponse.json(
          {
            type: 'https://cinema.example/errors/not-found',
            title: 'Resource not found',
            status: 404,
            detail: 'Movie does not exist',
            instance: '/api/v1/movies/x',
            traceId: 'trace-3',
          },
          { status: 404 },
        ),
      ),
    );

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Movie does not exist');
  });
});
