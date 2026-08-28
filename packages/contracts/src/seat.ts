import { z } from 'zod';

export const seatCategorySchema = z.enum(['STANDARD', 'VIP', 'RECLINER']);
export type SeatCategory = z.infer<typeof seatCategorySchema>;

/**
 * `HELD` means someone's unexpired hold covers this seat; `CONFIRMED` means it
 * is sold. A hold past its expiry reads as `AVAILABLE` — expiry is decided by
 * the same predicate that decides whether a hold blocks an insert.
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
  /**
   * True when the reservation covering this seat belongs to the caller's
   * session. Without it the map cannot tell your own hold from a stranger's and
   * shows your seats as unavailable to you.
   */
  heldByYou: z.boolean(),
});
export type ShowtimeSeat = z.infer<typeof showtimeSeatSchema>;

export const showtimeSeatsSchema = z.object({
  showtimeId: z.uuid(),
  hallId: z.uuid(),
  hallName: z.string().min(1),
  seats: z.array(showtimeSeatSchema),
});
export type ShowtimeSeats = z.infer<typeof showtimeSeatsSchema>;
