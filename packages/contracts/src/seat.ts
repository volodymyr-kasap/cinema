import { z } from 'zod';

export const seatCategorySchema = z.enum(['STANDARD', 'VIP', 'RECLINER']);
export type SeatCategory = z.infer<typeof seatCategorySchema>;

/**
 * `HELD` and `CONFIRMED` cannot occur yet — nothing books a seat in phase 1.
 * The values exist now so the seat map does not have to be rewritten when
 * sub-project 2 starts producing them.
 */
export const seatStatusSchema = z.enum(['AVAILABLE', 'HELD', 'CONFIRMED']);
export type SeatStatus = z.infer<typeof seatStatusSchema>;

export const showtimeSeatSchema = z.object({
  seatId: z.uuid(),
  rowLabel: z.string().min(1),
  seatNumber: z.int().positive(),
  category: seatCategorySchema,
  /** Showtime base price plus the category surcharge; the client never computes this. */
  priceCents: z.int().nonnegative(),
  status: seatStatusSchema,
});
export type ShowtimeSeat = z.infer<typeof showtimeSeatSchema>;

export const showtimeSeatsSchema = z.object({
  showtimeId: z.uuid(),
  hallId: z.uuid(),
  hallName: z.string().min(1),
  seats: z.array(showtimeSeatSchema),
});
export type ShowtimeSeats = z.infer<typeof showtimeSeatsSchema>;
