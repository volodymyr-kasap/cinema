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

export interface SeatButtonProps {
  seat: ShowtimeSeat;
  position: string;
  isActive: boolean;
  onFocus: () => void;
}

/**
 * Memoised on purpose: the premiere hall renders 1000 of these, and selecting a
 * seat in sub-project 2 must repaint one of them, not the whole hall.
 */
export const SeatButton = memo(function SeatButton({
  seat,
  position,
  isActive,
  onFocus,
}: SeatButtonProps) {
  const taken = seat.status !== 'AVAILABLE';

  return (
    <button
      type="button"
      data-grid-cell={position}
      tabIndex={isActive ? 0 : -1}
      onFocus={onFocus}
      disabled={taken}
      aria-label={`Row ${seat.rowLabel}, seat ${seat.seatNumber}, ${seat.category.toLowerCase()}, ${formatPrice(
        seat.priceCents,
      )}, ${seat.status.toLowerCase()}`}
      className={`flex size-7 items-center justify-center rounded text-[10px] font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-40 ${
        CATEGORY_STYLE[seat.category]
      }`}
    >
      <span aria-hidden>{STATUS_GLYPH[seat.status] || seat.seatNumber}</span>
    </button>
  );
});
