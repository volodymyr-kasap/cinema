import { describe, expect, it } from 'vitest';

import { createReservationSchema, reservationSchema } from './reservation.js';

describe('createReservationSchema', () => {
  const showtimeId = '019298a1-7c4e-7c3a-8f21-000000000001';
  const seat = (n: number) => `019298a1-7c4e-7c3a-8f21-00000000000${n}`;

  it('accepts a showtime and between one and ten seats', () => {
    const parsed = createReservationSchema.parse({ showtimeId, seatIds: [seat(1), seat(2)] });
    expect(parsed.seatIds).toHaveLength(2);
  });

  it('rejects an empty seat list', () => {
    expect(createReservationSchema.safeParse({ showtimeId, seatIds: [] }).success).toBe(false);
  });

  it('rejects more than ten seats', () => {
    const many = Array.from(
      { length: 11 },
      (_, i) => `019298a1-7c4e-7c3a-8f21-0000000000${10 + i}`,
    );
    expect(createReservationSchema.safeParse({ showtimeId, seatIds: many }).success).toBe(false);
  });

  // A repeated id would collapse inside `seat_id = ANY(...)`, and the service's
  // "fewer rows than seats asked for" check would report a conflict on a seat
  // nobody holds. Rejecting here keeps that lie impossible.
  it('rejects a repeated seat id', () => {
    const result = createReservationSchema.safeParse({ showtimeId, seatIds: [seat(1), seat(1)] });
    expect(result.success).toBe(false);
  });
});

describe('reservationSchema', () => {
  it('parses a hold with its seats', () => {
    const parsed = reservationSchema.parse({
      id: '019298a1-7c4e-7c3a-8f21-000000000009',
      showtimeId: '019298a1-7c4e-7c3a-8f21-000000000001',
      status: 'PENDING',
      totalPriceCents: 45000,
      expiresAt: '2026-08-28T12:10:00.000Z',
      createdAt: '2026-08-28T12:00:00.000Z',
      seats: [
        {
          seatId: '019298a1-7c4e-7c3a-8f21-000000000002',
          rowLabel: 'C',
          seatNumber: 7,
          category: 'VIP',
          priceCents: 22500,
        },
      ],
    });

    expect(parsed.status).toBe('PENDING');
    expect(parsed.seats[0]?.rowLabel).toBe('C');
  });

  it('rejects a status outside the state machine', () => {
    expect(reservationSchema.safeParse({ status: 'PAID' }).success).toBe(false);
  });
});
