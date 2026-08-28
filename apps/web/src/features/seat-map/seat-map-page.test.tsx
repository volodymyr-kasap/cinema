import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { seatMapFixture, showtimeFixture } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { server } from '../../test/server';
import { SeatMapPage } from './seat-map-page';

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="showtimes/:showtimeId" element={<SeatMapPage />} />
    </Routes>,
    { route: `/showtimes/${showtimeFixture.id}` },
  );
}

describe('SeatMapPage', () => {
  it('renders every seat as a button labelled with row, number, category and price', async () => {
    renderPage();

    expect(await screen.findByRole('grid', { name: /seat map/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /row [A-C], seat/i })).toHaveLength(12);
    expect(
      screen.getByRole('button', { name: /Row C, seat 1, vip, 230 ₴, available/i }),
    ).toBeInTheDocument();
  });

  it('exposes a single tab stop and moves focus with the arrow keys', async () => {
    renderPage();

    const first = await screen.findByRole('button', { name: /Row A, seat 1/i });
    expect(first).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: /Row A, seat 2/i })).toHaveAttribute(
      'tabindex',
      '-1',
    );

    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: /Row A, seat 2/i })).toHaveFocus();

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: /Row B, seat 2/i })).toHaveFocus();
  });

  it('does not walk past the edge of the hall', async () => {
    renderPage();

    const first = await screen.findByRole('button', { name: /Row A, seat 1/i });
    first.focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}');

    expect(first).toHaveFocus();
  });

  it('disables a seat that is already taken', async () => {
    server.use(
      http.get('/api/v1/showtimes/:id/seats', () =>
        HttpResponse.json({
          ...seatMapFixture,
          seats: seatMapFixture.seats.map((seat, index) =>
            index === 0 ? { ...seat, status: 'CONFIRMED' as const } : seat,
          ),
        }),
      ),
    );

    renderPage();

    expect(await screen.findByRole('button', { name: /Row A, seat 1.*confirmed/i })).toBeDisabled();
  });

  it('shows the showtime heading and a legend of the categories', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Premiere/ })).toBeInTheDocument();
    expect(screen.getByText(/standard/i)).toBeInTheDocument();
    expect(screen.getByText(/vip/i)).toBeInTheDocument();
  });

  it('renders an alert when the seat map cannot be loaded', async () => {
    server.use(
      http.get('/api/v1/showtimes/:id/seats', () =>
        HttpResponse.json(
          {
            type: 'https://cinema.example/errors/not-found',
            title: 'Resource not found',
            status: 404,
            detail: 'Showtime does not exist',
            instance: '/api/v1/showtimes/x/seats',
            traceId: 'trace-7',
          },
          { status: 404 },
        ),
      ),
    );

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Showtime does not exist');
  });
});
