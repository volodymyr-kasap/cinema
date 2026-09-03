import { z } from 'zod';

import { pageSchema } from './common.js';
import { paymentStatusSchema } from './payment.js';
import { seatCategorySchema } from './seat.js';

/**
 * The whole state machine. `PENDING` and `PAYMENT_PENDING` are the only
 * non-terminal states: a hold either starts a payment, is given up, or runs out
 * of time; a payment either succeeds or does not.
 */
export const reservationStatusSchema = z.enum([
  'PENDING',
  'PAYMENT_PENDING',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'CANCELLED',
  'EXPIRED',
]);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;

/** Not a business rule: an upper bound on how many rows one transaction may lock. */
export const MAX_SEATS_PER_RESERVATION = 10;

export const createReservationSchema = z.object({
  showtimeId: z.uuid(),
  seatIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_SEATS_PER_RESERVATION)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'seatIds must not repeat a seat',
    }),
});
export type CreateReservation = z.infer<typeof createReservationSchema>;

/** Geometry travels with the reservation so the confirmation screen needs no second request. */
export const reservationSeatSchema = z.object({
  seatId: z.uuid(),
  rowLabel: z.string().min(1),
  seatNumber: z.int().positive(),
  category: seatCategorySchema,
  /** The price quoted when the hold was taken, not today's price of the showtime. */
  priceCents: z.int().nonnegative(),
});
export type ReservationSeat = z.infer<typeof reservationSeatSchema>;

export const reservationSchema = z.object({
  id: z.uuid(),
  showtimeId: z.uuid(),
  status: reservationStatusSchema,
  totalPriceCents: z.int().nonnegative(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  seats: z.array(reservationSeatSchema).min(1),
  /**
   * Present only once a payment has been started. Optional rather than
   * nullable so every response phases 1-4 produced still parses unchanged.
   */
  payment: z
    .object({
      status: paymentStatusSchema,
      amountCents: z.int().positive(),
      attempts: z.int().nonnegative(),
    })
    .optional(),
});
export type Reservation = z.infer<typeof reservationSchema>;

export const reservationPageSchema = pageSchema(reservationSchema);
