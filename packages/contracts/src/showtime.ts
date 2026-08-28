import { z } from 'zod';

import { pageSchema, paginationQuerySchema } from './common.js';

export const showtimeFormatSchema = z.enum(['TWO_D', 'THREE_D', 'IMAX']);
export type ShowtimeFormat = z.infer<typeof showtimeFormatSchema>;

export const showtimeSchema = z.object({
  id: z.uuid(),
  movieId: z.uuid(),
  hallId: z.uuid(),
  hallName: z.string().min(1),
  cinemaId: z.uuid(),
  cinemaName: z.string().min(1),
  /** UTC instant. The cinema's own zone lives on the cinema resource. */
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  basePriceCents: z.int().nonnegative(),
  language: z.string().min(1),
  format: showtimeFormatSchema,
});
export type Showtime = z.infer<typeof showtimeSchema>;

export const showtimePageSchema = pageSchema(showtimeSchema);

export const showtimeQuerySchema = paginationQuerySchema.extend({
  movieId: z.uuid().optional(),
  cinemaId: z.uuid().optional(),
  /** Calendar day in the cinema's own time zone, not in UTC. */
  date: z.iso.date().optional(),
});
export type ShowtimeQuery = z.infer<typeof showtimeQuerySchema>;
