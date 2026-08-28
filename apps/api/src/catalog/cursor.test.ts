import { InvalidCursorError } from '../http/errors';
import { decodeCursor, encodeCursor } from './cursor';

describe('cursor codec', () => {
  it('round-trips the ordering key', () => {
    const cursor = encodeCursor(['Dune', '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60']);

    expect(decodeCursor(cursor)).toEqual(['Dune', '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60']);
  });

  it('produces a url-safe string', () => {
    expect(encodeCursor(['a/b+c', 1])).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a cursor that is not one we issued', () => {
    expect(() => decodeCursor('not-base64!!')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toThrow(
      InvalidCursorError,
    );
  });
});
