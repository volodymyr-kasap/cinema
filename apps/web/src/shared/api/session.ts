export const SESSION_STORAGE_KEY = 'cinema.sessionId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 2 has no accounts, so a reservation belongs to a browser. The id is
 * minted once and kept, because losing it means losing every hold this browser
 * is holding.
 *
 * Storage is the only source of truth — deliberately not memoised. A cached copy
 * would keep serving an id another tab has already cleared, and it buys nothing:
 * this is one synchronous read per request.
 */
export function getSessionId(): string {
  const stored = localStorage.getItem(SESSION_STORAGE_KEY);
  if (stored && UUID.test(stored)) return stored;

  const created = crypto.randomUUID();
  localStorage.setItem(SESSION_STORAGE_KEY, created);
  return created;
}
