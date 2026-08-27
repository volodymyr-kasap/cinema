import { z } from 'zod';

/** Opaque keyset cursor. Only the server knows how to decode it. */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Every collection response uses this envelope; single resources are returned bare. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
export type Page<T> = { data: T[]; nextCursor: string | null };

/** RFC 9457 Problem Details, extended with the correlation id of the failing request. */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  detail: z.string(),
  instance: z.string(),
  traceId: z.string(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const idParamSchema = z.object({ id: z.uuid() });
export type IdParam = z.infer<typeof idParamSchema>;
