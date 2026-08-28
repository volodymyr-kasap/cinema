import {
  InvalidStateTransitionError,
  MissingSessionError,
  ReservationExpiredError,
  SeatsNotInHallError,
  SeatsUnavailableError,
  ShowtimeAlreadyStartedError,
} from './errors';

describe('reservation domain errors', () => {
  it('reports a lost race as 409 and names the seats that were lost', () => {
    const error = new SeatsUnavailableError([
      { seatId: '019298a1-7c4e-7c3a-8f21-000000000001', label: 'C7' },
      { seatId: '019298a1-7c4e-7c3a-8f21-000000000002', label: 'C8' },
    ]);

    expect(error.status).toBe(409);
    expect(error.typeSlug).toBe('seats-unavailable');
    expect(error.message).toContain('C7, C8');
    expect(error.extensions).toEqual({
      seatIds: ['019298a1-7c4e-7c3a-8f21-000000000001', '019298a1-7c4e-7c3a-8f21-000000000002'],
    });
  });

  it('maps each remaining failure to its status', () => {
    expect(new MissingSessionError().status).toBe(400);
    expect(new SeatsNotInHallError(['C7']).status).toBe(400);
    expect(new ShowtimeAlreadyStartedError('019298a1').status).toBe(409);
    expect(new ReservationExpiredError('019298a1').status).toBe(409);
    expect(new InvalidStateTransitionError('CONFIRMED', 'CANCELLED').status).toBe(409);
  });

  it('explains which transition was refused', () => {
    const error = new InvalidStateTransitionError('CONFIRMED', 'CANCELLED');
    expect(error.message).toContain('CONFIRMED');
    expect(error.message).toContain('CANCELLED');
  });
});
