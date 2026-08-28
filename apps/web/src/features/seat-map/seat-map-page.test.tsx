import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { SEAT_A1_ID, seatMapFixture, showtimeFixture } from '../../test/fixtures';
import { conflictOnHold } from '../../test/handlers';
import { renderWithProviders } from '../../test/render';
import { server } from '../../test/server';
import { SeatMapPage } from './seat-map-page';

/**
 * The suite renders under MemoryRouter, so `window.location` never moves. This
 * reports where the router actually is, which is what a navigation assertion is
 * really about.
 */
function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderPage() {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="showtimes/:showtimeId" element={<SeatMapPage />} />
        <Route path="reservations/:reservationId" element={null} />
      </Routes>
      <LocationProbe />
    </>,
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

  it('selects and deselects a seat', async () => {
    renderPage();
    const seat = await screen.findByRole('button', { name: /row a, seat 1/i });

    await userEvent.click(seat);
    expect(seat).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(seat);
    expect(seat).toHaveAttribute('aria-pressed', 'false');
  });

  it('announces the running total of the selection', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /row a, seat 1/i }));
    await userEvent.click(await screen.findByRole('button', { name: /row a, seat 2/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/2 seats/i);
  });

  it('does not let a taken seat be selected', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: /row a, seat 3.*held/i })).toBeDisabled();
  });

  it('navigates to the reservation once the hold succeeds', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /row a, seat 1/i }));
    await userEvent.click(screen.getByRole('button', { name: /hold seats/i }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/reservations\/[0-9a-f-]+$/),
    );
  });

  // The point of the extension member: the user is told which seats they lost,
  // not just that something failed.
  it('names the seats lost to another user', async () => {
    server.use(conflictOnHold([SEAT_A1_ID]));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /row a, seat 1/i }));
    await userEvent.click(screen.getByRole('button', { name: /hold seats/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/a1/i);
  });
});
