import { useEffect, useState } from 'react';

const ANNOUNCE_AT = [300, 60, 30] as const;

export interface Countdown {
  secondsLeft: number;
  label: string;
  hasExpired: boolean;
  /** Non-empty only on the tick that crosses a threshold. */
  announcement: string;
}

function remaining(deadline: string): number {
  return Math.max(0, Math.round((new Date(deadline).getTime() - Date.now()) / 1000));
}

/**
 * The interval carries no value — it only asks for a repaint, and the remaining
 * time is derived from the deadline during render. Storing the seconds in state
 * instead would need an effect to resync whenever `deadline` changes, which is
 * both a cascading render and a way to briefly report a stale count.
 */
export function useCountdown(deadline: string): Countdown {
  const [, tick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const secondsLeft = remaining(deadline);
  const minutes = Math.floor(secondsLeft / 60);
  const threshold = ANNOUNCE_AT.find((mark) => mark === secondsLeft);

  return {
    secondsLeft,
    label: `${minutes}:${String(secondsLeft % 60).padStart(2, '0')}`,
    hasExpired: secondsLeft === 0,
    announcement: threshold
      ? threshold >= 60
        ? `${threshold / 60} minutes left to confirm`
        : `${threshold} seconds left to confirm`
      : '',
  };
}
