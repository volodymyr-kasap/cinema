import { InvalidCursorError } from '../http/errors';

/**
 * Keyset cursors, not offsets: an offset skips or repeats rows when something is
 * inserted between two pages, and degrades as the offset grows.
 *
 * The payload is the ordering key of the last row on the page. It is opaque to
 * clients on purpose — the ordering may change without breaking their code.
 */
export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }

  if (!Array.isArray(parsed)) throw new InvalidCursorError();
  return parsed;
}

/** Narrows a decoded cursor to the `[string, uuid]` shape every catalogue list uses. */
export function decodeTextIdCursor(cursor: string): [string, string] {
  const parts = decodeCursor(cursor);
  const [text, id] = parts;
  if (typeof text !== 'string' || typeof id !== 'string') throw new InvalidCursorError();
  return [text, id];
}
