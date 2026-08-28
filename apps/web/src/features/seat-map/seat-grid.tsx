import { useMemo } from 'react';

import { useRovingGrid } from '../../shared/lib/use-roving-grid';
import type { SeatRow } from './build-rows';
import { SeatButton } from './seat-button';

export interface SeatGridProps {
  rows: SeatRow[];
  selected: ReadonlySet<string>;
  onToggle: (seatId: string) => void;
}

export function SeatGrid({ rows, selected, onToggle }: SeatGridProps) {
  const rowLengths = useMemo(() => rows.map((row) => row.seats.length), [rows]);
  const { active, setActive, onKeyDown } = useRovingGrid(rowLengths);

  return (
    <div
      role="grid"
      aria-label="Seat map"
      onKeyDown={onKeyDown}
      className="inline-flex flex-col gap-1 overflow-x-auto"
    >
      {rows.map((row, rowIndex) => (
        <div key={row.label} role="row" className="flex items-center gap-1">
          <span aria-hidden className="w-5 text-right text-xs text-slate-500">
            {row.label}
          </span>
          {row.seats.map((seat, colIndex) => (
            <div role="gridcell" key={seat.seatId}>
              <SeatButton
                seat={seat}
                position={`${rowIndex}-${colIndex}`}
                isActive={active.row === rowIndex && active.col === colIndex}
                isSelected={selected.has(seat.seatId)}
                onFocus={() => setActive({ row: rowIndex, col: colIndex })}
                onToggle={onToggle}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
