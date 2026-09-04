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

  it('shows a processing state while the payment is running', async () => {
    server.use(
      http.get('/api/v1/reservations/:id', () =>
        HttpResponse.json(
          makeReservation({
            status: 'PAYMENT_PENDING',
            payment: { status: 'PENDING', amountCents: 45_000, attempts: 0 },
          }),
        ),
      ),
    );
    renderPage();

    expect(await screen.findByRole('heading', { name: /processing payment/i })).toBeInTheDocument();
    // Announced, not silently swapped: the worker settles this page without
    // the reader touching it.
    expect(screen.getByRole('status')).toHaveTextContent(/processing payment/i);
    // Nothing has been bought yet, so nothing may read as bought: no
    // confirmation, and no confirm button to press a second time.
    expect(screen.queryByText(/these seats are yours/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
  });

  it('shows the failure and offers another go when the payment is refused', async () => {
    server.use(
      http.get('/api/v1/reservations/:id', () =>
        HttpResponse.json(
          makeReservation({
            status: 'PAYMENT_FAILED',
            payment: { status: 'DECLINED', amountCents: 45_000, attempts: 1 },
          }),
        ),
      ),
    );
    renderPage();

    expect(
      await screen.findByRole('heading', { name: /payment was declined/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/seats have been released/i);
    // The seats went back to the pool, so the honest offer is a fresh
    // selection rather than a retry that would race other buyers.
    expect(screen.getByRole('link', { name: /choose seats/i })).toBeInTheDocument();
  });

  // The point of the polling query. A 202 is not a sale, and the page has to
  // keep asking until the worker has an answer.
  it('follows a running payment to its settled state', async () => {
    let calls = 0;
    server.use(
      http.get('/api/v1/reservations/:id', () => {
        calls += 1;
        return HttpResponse.json(
          calls === 1
            ? makeReservation({
                status: 'PAYMENT_PENDING',
                payment: { status: 'PENDING', amountCents: 45_000, attempts: 0 },
              })
            : makeReservation({
                status: 'CONFIRMED',
                payment: { status: 'SUCCEEDED', amountCents: 45_000, attempts: 1 },
              }),
        );
      }),
    );
    renderPage();

    await screen.findByRole('heading', { name: /processing payment/i });
    expect(await screen.findByRole('heading', { name: /confirmed/i })).toBeInTheDocument();
  });

  it('stops polling once the reservation has settled', async () => {
    let calls = 0;
    server.use(
      http.get('/api/v1/reservations/:id', () => {
        calls += 1;
        return HttpResponse.json(makeReservation({ status: 'CONFIRMED' }));
      }),
    );
    renderPage();
    await screen.findByRole('heading', { name: /confirmed/i });

    // A confirmed booking left open in a background tab must not keep asking a
    // question that has been answered.
    const settled = calls;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(calls).toBe(settled);
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
