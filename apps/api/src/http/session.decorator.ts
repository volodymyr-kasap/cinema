import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { MissingSessionError } from './errors';

export const SESSION_HEADER = 'x-session-id';

const sessionIdSchema = z.uuid();

/** Required: every reservation endpoint needs to know whose reservation this is. */
export function readSessionId(header: unknown): string {
  const parsed = sessionIdSchema.safeParse(header);
  if (!parsed.success) throw new MissingSessionError();
  return parsed.data;
}

/**
 * Optional: the seat map stays public. Without a session every seat simply
 * reads `heldByYou: false`, which is true — an anonymous caller holds nothing.
 */
export function readOptionalSessionId(header: unknown): string | null {
  const parsed = sessionIdSchema.safeParse(header);
  return parsed.success ? parsed.data : null;
}

export const SessionId = createParamDecorator((_data: unknown, context: ExecutionContext): string =>
  readSessionId(context.switchToHttp().getRequest<FastifyRequest>().headers[SESSION_HEADER]),
);

export const OptionalSessionId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    readOptionalSessionId(
      context.switchToHttp().getRequest<FastifyRequest>().headers[SESSION_HEADER],
    ),
);
