import { z } from 'zod';

import { pageSchema } from './common.js';

export const movieSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  description: z.string(),
  durationMinutes: z.int().positive(),
  posterUrl: z.url(),
  releaseDate: z.iso.date(),
  rating: z.number().min(0).max(10),
});
export type Movie = z.infer<typeof movieSchema>;

export const moviePageSchema = pageSchema(movieSchema);
