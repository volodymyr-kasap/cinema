import { expect, test } from '@playwright/test';

/**
 * The only test that proves the whole stack is wired together: nginx serves the
 * SPA, proxies /api, the API talks to a migrated and seeded PostgreSQL, and the
 * routes chain from catalogue to seat map.
 */
test('walks from the catalogue to a seat map', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Now showing' })).toBeVisible();

  const firstMovie = page.getByRole('link').filter({ hasText: /min$/ }).first();
  await firstMovie.click();

  await expect(page.getByRole('heading', { name: 'Showtimes' })).toBeVisible();

  await page
    .getByRole('link')
    .filter({ hasText: /^\d{2}:\d{2}/ })
    .first()
    .click();

  const grid = page.getByRole('grid', { name: /seat map/i });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole('button').first()).toBeVisible();

  // One test, not five: the smoke test's job is proving the stack is wired
  // together end to end. The behaviour itself is covered by the API and
  // component suites.
  const seatMapUrl = page.url();
  const seat = grid.getByRole('button').and(page.locator(':not([disabled])')).first();
  const seatLabel = await seat.getAttribute('aria-label');
  await seat.click();
  await expect(seat).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: /hold seats/i }).click();

  await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: /your seats are held/i })).toBeVisible();
  await expect(page.getByTestId('countdown')).toHaveText(/\d+:\d\d/);

  await page.getByRole('button', { name: /confirm booking/i }).click();
  // In PAYMENT_MODE=queue the confirm answers 202 and the page follows the
  // payment to its settled state; with payments off the confirmed heading is
  // there on the first render. Either way this is the assertion that matters,
  // and the generous timeout is what makes the same line true in both modes.
  await expect(page.getByRole('heading', { name: /booking confirmed/i })).toBeVisible({
    timeout: 15_000,
  });

  // Back on the map, the seat now reads as sold and yours -- the occupancy join
  // reading the row the confirm just committed.
  await page.goto(seatMapUrl);
  const sold = page.getByRole('button', {
    name: seatLabel!.replace(/available$/, 'confirmed, yours'),
  });
  await expect(sold).toBeDisabled();
});

test('shows the 1000-seat premiere hall', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link').filter({ hasText: /min$/ }).first().click();

  // Every seeded hall is reachable; the premiere hall is the one that matters
  // for the load experiment in sub-project 3.
  const premiere = page.getByRole('link').filter({ hasText: 'Premiere' }).first();
  await premiere.click();

  await expect(page.getByText(/1000 seats/)).toBeVisible();
});

test('serves a deep link directly, without a 404 from nginx', async ({ page }) => {
  const response = await page.goto('/movies/019298a1-7c4e-7c3a-8f21-000000000000');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('alert')).toBeVisible();
});
