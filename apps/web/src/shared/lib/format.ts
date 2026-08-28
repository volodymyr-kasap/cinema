/**
 * Money shows either no decimals or exactly two — never one. A single
 * `maximumFractionDigits: 2` formatter renders 230.50 as "230,5", so the whole
 * and fractional cases get their own formatter.
 */
function currencyFormatter(fractionDigits: 0 | 2): Intl.NumberFormat {
  return new Intl.NumberFormat('uk-UA', {
    style: 'currency',
    currency: 'UAH',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

const wholeFormatter = currencyFormatter(0);
const fractionalFormatter = currencyFormatter(2);

/** Prices arrive as integer minor units; the client only ever renders them. */
export function formatPrice(cents: number): string {
  const formatter = cents % 100 === 0 ? wholeFormatter : fractionalFormatter;

  // Intl separates the amount from the symbol with a no-break space (U+00A0) or,
  // on some ICU builds, a narrow one (U+202F). Escape them rather than writing the
  // literal characters, which do not survive copying, and normalise to a plain
  // space so tests and screen readers see one predictable string.
  return formatter.format(cents / 100).replace(/[\u202F\u00A0]/g, ' ');
}

export function formatShowtimeTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function formatShowtimeDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}
