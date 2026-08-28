import { useCallback, useState, type KeyboardEvent } from 'react';

export interface GridPosition {
  row: number;
  col: number;
}

/**
 * Roving tabindex: the grid holds a single tab stop and the arrow keys move it.
 * A thousand focusable seats would otherwise mean a thousand presses of Tab to
 * cross the hall.
 */
export function useRovingGrid(rowLengths: number[]) {
  const [active, setActive] = useState<GridPosition>({ row: 0, col: 0 });

  const clamp = useCallback(
    (position: GridPosition): GridPosition => {
      const row = Math.max(0, Math.min(position.row, rowLengths.length - 1));
      const length = rowLengths[row] ?? 0;
      return { row, col: Math.max(0, Math.min(position.col, length - 1)) };
    },
    [rowLengths],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      const moves: Record<string, GridPosition> = {
        ArrowRight: { row: active.row, col: active.col + 1 },
        ArrowLeft: { row: active.row, col: active.col - 1 },
        ArrowDown: { row: active.row + 1, col: active.col },
        ArrowUp: { row: active.row - 1, col: active.col },
        Home: { row: active.row, col: 0 },
        End: { row: active.row, col: Number.MAX_SAFE_INTEGER },
      };

      const target = moves[event.key];
      if (!target) return;

      event.preventDefault();
      const next = clamp(target);
      setActive(next);

      document.querySelector<HTMLElement>(`[data-grid-cell="${next.row}-${next.col}"]`)?.focus();
    },
    [active, clamp],
  );

  return { active, setActive, onKeyDown };
}
