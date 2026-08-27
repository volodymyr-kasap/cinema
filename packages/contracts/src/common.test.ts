import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  idParamSchema,
  pageSchema,
  paginationQuerySchema,
  problemDetailsSchema,
} from './common.js';

describe('paginationQuerySchema', () => {
  it('defaults limit to 20 when absent', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it('coerces the limit from a query string', () => {
    expect(paginationQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('rejects a limit above 100', () => {
    expect(paginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('keeps the cursor as an opaque string', () => {
    expect(paginationQuerySchema.parse({ cursor: 'abc' })).toEqual({ cursor: 'abc', limit: 20 });
  });
});

describe('pageSchema', () => {
  it('wraps items in a data/nextCursor envelope', () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    expect(schema.parse({ data: [{ id: 'a' }], nextCursor: null })).toEqual({
      data: [{ id: 'a' }],
      nextCursor: null,
    });
  });

  it('rejects a page without nextCursor', () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    expect(schema.safeParse({ data: [] }).success).toBe(false);
  });
});

describe('problemDetailsSchema', () => {
  it('requires a traceId so every failure is traceable', () => {
    const problem = {
      type: 'https://cinema.example/errors/not-found',
      title: 'Not found',
      status: 404,
      detail: 'Movie 018f does not exist',
      instance: '/api/v1/movies/018f',
    };
    expect(problemDetailsSchema.safeParse(problem).success).toBe(false);
    expect(problemDetailsSchema.safeParse({ ...problem, traceId: 'r-1' }).success).toBe(true);
  });
});

describe('idParamSchema', () => {
  it('accepts a uuid v7 and rejects anything else', () => {
    expect(idParamSchema.safeParse({ id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60' }).success).toBe(
      true,
    );
    expect(idParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });
});
