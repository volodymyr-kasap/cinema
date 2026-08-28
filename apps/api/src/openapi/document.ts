import { problemDetailsSchema } from '@cinema/contracts';
import { z } from 'zod';

import { ROUTES, type RouteDoc } from './routes';

type JsonSchema = Record<string, unknown>;

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  tags: string[];
  parameters?: { name: string; in: 'path' | 'query'; required: boolean; schema: JsonSchema }[];
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  >;
}

export interface OpenApiDocument {
  openapi: '3.0.3';
  info: { title: string; version: string; description: string };
  paths: Record<string, { get?: OpenApiOperation }>;
}

/** Zod 4 converts natively — no second schema language, so docs cannot drift from validation. */
function toJson(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io }) as JsonSchema;
}

function queryParameters(schema: z.ZodType): OpenApiOperation['parameters'] {
  const json = toJson(schema, 'input');
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required as string[] | undefined) ?? []);

  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: 'query' as const,
    required: required.has(name),
    schema: property,
  }));
}

function operationFor(route: RouteDoc): OpenApiOperation {
  const problem = toJson(problemDetailsSchema, 'output');

  const responses: OpenApiOperation['responses'] = {
    '200': {
      description: 'Success',
      content: { 'application/json': { schema: toJson(route.response, 'output') } },
    },
  };

  for (const status of route.errors) {
    responses[String(status)] = {
      description: status === 404 ? 'Not found' : 'Bad request',
      content: { 'application/problem+json': { schema: problem } },
    };
  }

  return {
    operationId: route.operationId,
    summary: route.summary,
    tags: route.tags,
    parameters: [
      ...route.pathParams.map((name) => ({
        name,
        in: 'path' as const,
        required: true,
        schema: { type: 'string', format: 'uuid' } as JsonSchema,
      })),
      ...(route.query ? (queryParameters(route.query) ?? []) : []),
    ],
    responses,
  };
}

export function buildOpenApiDocument(): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};

  for (const route of ROUTES) {
    paths[route.path] = { get: operationFor(route) };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Cinema Booking Platform API',
      version: '1.0.0',
      description:
        'Read-only catalogue of movies, cinemas, showtimes and seat maps. Generated from the Zod schemas in @cinema/contracts, which are the same schemas that validate requests.',
    },
    paths,
  };
}
