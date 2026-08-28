import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const RESPONSE_SCHEMA = 'response_schema';

/** Declares the schema a handler promises to return. Read by the interceptor and by the OpenAPI builder. */
export const Validated = (schema: z.ZodType): MethodDecorator =>
  SetMetadata(RESPONSE_SCHEMA, schema);
