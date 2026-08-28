/** Milliseconds the zone is ahead of UTC at the given instant. */
function offsetAt(utcMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }

  const asIfUtc = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    (parts.hour ?? 0) % 24,
    parts.minute ?? 0,
    parts.second ?? 0,
  );

  return asIfUtc - utcMs;
}

/**
 * Turns a wall-clock time in a named zone into the UTC instant we store.
 * Two passes: the first offset is a guess made from the wrong instant, the
 * second is taken at the corrected instant, which is what DST changeovers need.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = naive - offsetAt(naive, timeZone);
  return new Date(naive - offsetAt(firstGuess, timeZone));
}
