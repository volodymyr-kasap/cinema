import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCountdown } from './use-countdown';

describe('useCountdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts down each second', () => {
    const deadline = new Date(Date.now() + 90_000).toISOString();
    const { result } = renderHook(() => useCountdown(deadline));

    expect(result.current.secondsLeft).toBe(90);
    expect(result.current.label).toBe('1:30');

    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.secondsLeft).toBe(89);
  });

  it('floors at zero and reports expiry', () => {
    const deadline = new Date(Date.now() - 1000).toISOString();
    const { result } = renderHook(() => useCountdown(deadline));

    expect(result.current.secondsLeft).toBe(0);
    expect(result.current.hasExpired).toBe(true);
  });

  // The screen reader must not become a metronome. Only threshold crossings are
  // announced; the visible timer keeps ticking every second.
  it('announces only at thresholds', () => {
    // Hoisted, not inlined into the render callback: a fresh `Date.now()` on
    // every render would change the hook's `deadline` dependency and reset the
    // countdown before it could ever reach a threshold.
    const deadline = new Date(Date.now() + 301_000).toISOString();
    const { result } = renderHook(() => useCountdown(deadline));

    expect(result.current.announcement).toBe('');
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.announcement).toMatch(/5 minutes/i);
  });
});
