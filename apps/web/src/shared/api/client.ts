import { problemDetailsSchema, type ProblemDetails } from '@cinema/contracts';
import type { z } from 'zod';

import { getSessionId } from './session';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail);
    this.name = 'ApiError';
  }

  get status(): number {
    return this.problem.status;
  }
}

function fallbackProblem(status: number, path: string): ProblemDetails {
  return {
    type: 'about:blank',
    title: 'Unexpected response',
    status,
    detail: `The server answered ${status} without a problem document`,
    instance: path,
    traceId: 'unknown',
  };
}

/**
 * Every response is parsed with the same schema the server validates against.
 * The cost is a parse per response; the benefit is that a contract mismatch
 * surfaces here, as a named error, instead of as `undefined` deep in a render.
 */
export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      // Sent on every request, including the seat map, which uses it to mark
      // the caller's own holds.
      'x-session-id': getSessionId(),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const problem = problemDetailsSchema.safeParse(body);
    throw new ApiError(problem.success ? problem.data : fallbackProblem(response.status, path));
  }

  // 204 carries no body, and `response.json()` throws on an empty one.
  if (response.status === 204) return schema.parse(undefined);

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Response for ${path} does not match its contract: ${parsed.error.message}`);
  }

  return parsed.data;
}

/** The seats a `seats-unavailable` response says this request lost. */
export function lostSeatIds(error: unknown): string[] {
  return error instanceof ApiError ? (error.problem.seatIds ?? []) : [];
}
