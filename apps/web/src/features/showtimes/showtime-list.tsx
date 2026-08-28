import type { Cinema, Showtime } from '@cinema/contracts';
import { Link } from 'react-router';

import { formatShowtimeDay, formatShowtimeTime } from '../../shared/lib/format';
import { Badge } from '../../shared/ui/badge';

export function ShowtimeList({
  showtimes,
  cinemasById,
}: {
  showtimes: Showtime[];
  cinemasById: Map<string, Cinema>;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {showtimes.map((showtime) => {
        // Instants are UTC; the cinema's own zone is what a viewer expects to read.
        const timeZone = cinemasById.get(showtime.cinemaId)?.timezone ?? 'UTC';

        return (
          <li key={showtime.id}>
            <Link
              to={`/showtimes/${showtime.id}`}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 transition hover:border-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 dark:border-slate-800"
            >
              <span className="text-lg font-semibold tabular-nums">
                {formatShowtimeTime(showtime.startsAt, timeZone)}
              </span>
              <span className="text-sm text-slate-500">
                {formatShowtimeDay(showtime.startsAt, timeZone)}
              </span>
              <span className="text-sm">
                {showtime.cinemaName} · {showtime.hallName}
              </span>
              <Badge>{showtime.format}</Badge>
              <Badge>{showtime.language}</Badge>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
