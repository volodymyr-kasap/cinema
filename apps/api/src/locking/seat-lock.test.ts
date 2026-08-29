import { seatKey } from './seat-lock';

describe('seatKey', () => {
  // Section 8 of spec.md gives this format verbatim. The load scripts and the
  // adapter must agree on it, which is why it exists exactly once in the code.
  it('is seat:{showtimeId}:{seatId}', () => {
    expect(
      seatKey('01936c7a-0000-7000-8000-000000000001', '01936c7a-0000-7000-8000-000000000002'),
    ).toBe('seat:01936c7a-0000-7000-8000-000000000001:01936c7a-0000-7000-8000-000000000002');
  });

  it('gives different seats of one showtime different keys', () => {
    expect(seatKey('show', 'a')).not.toBe(seatKey('show', 'b'));
  });

  it('gives the same seat under different showtimes different keys', () => {
    expect(seatKey('one', 'seat')).not.toBe(seatKey('two', 'seat'));
  });
});
