import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { makeReservation } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { server } from '../../test/server';
import { ReservationPage } from './reservation-page';

const ID = '019298a1-7c4e-7c3a-8f21-000000000090';

/** MemoryRouter never touches `window.location`; this reports where it is. */
function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderPage() {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="reservations/:reservationId" element={<ReservationPage />} />
        <Route path="showtimes/:showtimeId" element={null} />
      </Routes>
      <LocationProbe />
    </>,
    { route: `/reservations/${ID}` },
  );
}

describe('ReservationPage', () => {
  it('shows the held seats, the total and the countdown', async () => {
    renderPage();

    expect(await screen.findByText(/seat 7/i)).toBeInTheDocument();
    expect(screen.getByText(/^Total/)).toHaveTextContent('450');
    expect(screen.getByTestId('countdown')).toHaveTextContent(/\d+:\d\d/);
  });

  it('confirms the reservation', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /confirm/i }));

    expect(await screen.findByRole('heading', { name: /confirmed/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
  });

  it('cancels the reservation and returns to the seat map', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/showtimes\//));
  });

  it('offers no confirm button once the reservation has expired', async () => {
    server.use(
      http.get('/api/v1/reservations/:id', () =>
        HttpResponse.json(makeReservation({ status: 'EXPIRED' })),
      ),
    );
    renderPage();

    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
  });

  // Expiry is the server's decision. The countdown reaching zero is a reason to
  // ask again, never a reason for the client to declare the hold dead itself.
  it('refetches when the countdown reaches zero rather than deciding locally', async () => {
    let calls = 0;
    server.use(
      http.get('/api/v1/reservations/:id', () => {
        calls += 1;
        return HttpResponse.json(
          makeReservation(
            calls === 1
              ? { expiresAt: new Date(Date.now() + 1000).toISOString() }
              : { status: 'EXPIRED' },
          ),
        );
      }),
    );

    renderPage();
    await screen.findByTestId('countdown');

    await waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 3000 });
    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
  });
});
