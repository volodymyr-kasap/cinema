import { MissingSessionError } from './errors';
import { readOptionalSessionId, readSessionId } from './session.decorator';

const VALID = '019298a1-7c4e-7c3a-8f21-000000000001';

describe('readSessionId', () => {
  it('returns a well-formed uuid', () => {
    expect(readSessionId(VALID)).toBe(VALID);
  });

  it('rejects a missing header', () => {
    expect(() => readSessionId(undefined)).toThrow(MissingSessionError);
  });

  // A caller sending junk gets the same answer as one sending nothing: without a
  // usable session there is no reservation to act on either way.
  it('rejects a header that is not a uuid', () => {
    expect(() => readSessionId('session-42')).toThrow(MissingSessionError);
  });

  it('rejects an array of headers', () => {
    expect(() => readSessionId([VALID, VALID])).toThrow(MissingSessionError);
  });
});

describe('readOptionalSessionId', () => {
  it('returns null rather than throwing when absent', () => {
    expect(readOptionalSessionId(undefined)).toBeNull();
  });

  it('returns null for a malformed value', () => {
    expect(readOptionalSessionId('nonsense')).toBeNull();
  });

  it('returns the uuid when present', () => {
    expect(readOptionalSessionId(VALID)).toBe(VALID);
  });
});
