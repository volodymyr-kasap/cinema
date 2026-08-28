import type { ShowtimeSeat } from '@cinema/contracts';
import { memo } from 'react';

import { formatPrice } from '../../shared/lib/format';

const CATEGORY_STYLE: Record<ShowtimeSeat['category'], string> = {
  STANDARD: 'bg-slate-200 dark:bg-slate-700',
  VIP: 'bg-amber-200 dark:bg-amber-700',
  RECLINER: 'bg-violet-200 dark:bg-violet-700',
};

/** Status is never carried by colour alone — a glyph carries it too. */
const STATUS_GLYPH: Record<ShowtimeSeat['status'], string> = {
  AVAILABLE: '',
  HELD: '◌',
  CONFIRMED: '×',
};

/**
 * The last field of a seat's label. Ownership and status are two separate
 * facts: a seat you confirmed is both yours *and* sold, and collapsing that to
 * "held by you" would tell a screen-reader user their booked seat is merely on
 * hold.
 */
function describeState(seat: ShowtimeSeat): string {
  if (!seat.heldByYou) return seat.status.toLowerCase();
  return seat.status === 'CONFIRMED' ? 'confirmed, yours' : 'held by you';
}

export interface SeatButtonProps {
  seat: ShowtimeSeat;
  position: string;
  isActive: boolean;
  isSelected: boolean;
  onFocus: () => void;
  onToggle: (seatId: string) => void;
}

/**
 * Memoised on purpose: the premiere hall renders 1000 of these, and selecting a
 * seat must repaint one of them, not the whole hall. That only holds while
 * `onToggle` is stable, so the page memoises it.
 */
export const SeatButton = memo(function SeatButton({
  seat,
  position,
  isActive,
  isSelected,
  onFocus,
  onToggle,
}: SeatButtonProps) {
  // Your own hold is still unavailable to select: choosing it again would lose
  // a 409 to your own reservation. It is labelled differently, not enabled.
  const taken = seat.status !== 'AVAILABLE';

  return (
    <button
      type="button"
      data-grid-cell={position}
      tabIndex={isActive ? 0 : -1}
      onFocus={onFocus}
      onClick={() => onToggle(seat.seatId)}
      disabled={taken}
      aria-pressed={isSelected}
      aria-label={`Row ${seat.rowLabel}, seat ${seat.seatNumber}, ${seat.category.toLowerCase()}, ${formatPrice(
        seat.priceCents,
      )}, ${describeState(seat)}`}
      className={`flex size-7 items-center justify-center rounded text-[10px] font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-40 ${
        isSelected ? 'ring-2 ring-sky-500' : ''
      } ${CATEGORY_STYLE[seat.category]}`}
    >
      {/* Selection is never carried by the ring alone: a glyph carries it too. */}
      <span aria-hidden>{isSelected ? '✓' : STATUS_GLYPH[seat.status] || seat.seatNumber}</span>
    </button>
  );
});
