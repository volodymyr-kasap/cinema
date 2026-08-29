import http from 'k6/http';

/**
 * The stage of the section 25 experiment: the 1000-seat Premiere hall.
 *
 * Discovered through the public API rather than passed in, so the run needs no
 * knowledge of seed internals and fails with a sentence a human can act on when
 * the catalogue is missing or has aged out of its window.
 */
export function findPremiereShowtime(baseUrl) {
  const listed = http.get(`${baseUrl}/api/v1/showtimes?limit=100`);
  if (listed.status !== 200) {
    throw new Error(`could not list showtimes: ${listed.status} ${listed.body}`);
  }

  const now = Date.now();
  for (const showtime of listed.json('data')) {
    // A started showtime refuses every hold, which would look like a total
    // failure of the locking rather than a stale seed.
    if (Date.parse(showtime.startsAt) <= now) continue;

    const seats = http.get(`${baseUrl}/api/v1/showtimes/${showtime.id}/seats`);
    if (seats.status !== 200) continue;

    const seatIds = seats.json('seats').map((seat) => seat.seatId);
    if (seatIds.length === 1000) return { showtimeId: showtime.id, seatIds };
  }

  throw new Error(
    'no future 1000-seat showtime in the first 100 -- run `docker compose up seed` and check the seed window has not passed',
  );
}
