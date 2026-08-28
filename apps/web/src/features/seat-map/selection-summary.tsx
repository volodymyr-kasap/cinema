import type { ShowtimeSeat } from '@cinema/contracts';

import { formatPrice } from '../../shared/lib/format';
import { Button } from '../../shared/ui/button';

export interface SelectionSummaryProps {
  seats: ShowtimeSeat[];
  isHolding: boolean;
  onHold: () => void;
}

export function SelectionSummary({ seats, isHolding, onHold }: SelectionSummaryProps) {
  const total = seats.reduce((sum, seat) => sum + seat.priceCents, 0);
  const labels = seats.map((seat) => `${seat.rowLabel}${seat.seatNumber}`).join(', ');

  return (
    <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-4 border-t bg-white/90 p-4 backdrop-blur dark:bg-slate-900/90">
      {/* polite, not assertive: this updates on every click and must not
          interrupt what the screen reader is already saying. */}
      <p role="status" aria-live="polite" className="text-sm">
        {seats.length === 0
          ? 'No seats selected'
          : `${seats.length} seats selected · ${labels} · ${formatPrice(total)}`}
      </p>
      <Button onClick={onHold} disabled={seats.length === 0 || isHolding}>
        {isHolding ? 'Holding…' : 'Hold seats'}
      </Button>
    </div>
  );
}
