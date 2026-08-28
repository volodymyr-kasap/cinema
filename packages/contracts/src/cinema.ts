import { z } from 'zod';

import { pageSchema } from './common.js';

export const cinemaSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  city: z.string().min(1),
  address: z.string().min(1),
  /** IANA time zone, e.g. Europe/Kyiv. */
  timezone: z.string().min(1),
});
export type Cinema = z.infer<typeof cinemaSchema>;

export const cinemaPageSchema = pageSchema(cinemaSchema);
