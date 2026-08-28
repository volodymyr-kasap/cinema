import { beforeEach, describe, expect, it } from 'vitest';

import { SESSION_STORAGE_KEY, getSessionId } from './session';

describe('getSessionId', () => {
  beforeEach(() => localStorage.clear());

  it('creates and stores an id on first use', () => {
    const id = getSessionId();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(id);
  });

  // The same browser must keep its reservations across a reload; a new id every
  // page load would orphan every hold the user is holding.
  it('returns the same id on later calls', () => {
    expect(getSessionId()).toBe(getSessionId());
  });

  it('replaces a stored value that is not a uuid', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'not-a-uuid');

    const id = getSessionId();

    expect(id).not.toBe('not-a-uuid');
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(id);
  });
});
