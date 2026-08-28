import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { ValidationFailedError } from './errors';

/**
 * Validates with the same schemas the contracts package exports, so the API
 * cannot accept a shape the client's types say is impossible.
 */
export function zodPipe<T extends z.ZodType>(schema: T): PipeTransform<unknown, z.infer<T>> {
  return {
    transform(value: unknown): z.infer<T> {
      const result = schema.safeParse(value);
      if (!result.success) {
        throw new ValidationFailedError(z.prettifyError(result.error));
      }
      return result.data;
    },
  };
}
