import { problemDetailsSchema } from '@cinema/contracts';
import { z } from 'zod';

import { ROUTES, type RouteDoc } from './routes';

type JsonSchema = Record<string, unknown>;

const DESCRIPTIONS: Record<number, string> = {
  400: 'Bad request',
  404: 'Not found',
  409: 'Conflict',
};

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  tags: string[];
  parameters?: {
    name: string;
    in: 'path' | 'query' | 'header';
    required: boolean;
    schema: JsonSchema;
  }[];
  requestBody?: { required: true; content: Record<string, { schema: JsonSchema }> };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  >;
}

export interface OpenApiDocument {
  openapi: '3.0.3';
  info: { title: string; version: string; description: string };
  paths: Record<string, Partial<Record<RouteDoc['method'], OpenApiOperation>>>;
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

  const responses: OpenApiOperation['responses'] = route.response
    ? {
        '200': {
          description: 'Success',
          content: { 'application/json': { schema: toJson(route.response, 'output') } },
        },
      }
    : { '204': { description: 'No content' } };

  for (const status of route.errors) {
    responses[String(status)] = {
      description: DESCRIPTIONS[status] ?? 'Bad request',
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
      ...(route.requiresSession
        ? [
            {
              name: 'X-Session-Id',
              in: 'header' as const,
              required: true,
              schema: { type: 'string', format: 'uuid' } as JsonSchema,
            },
          ]
        : []),
      ...(route.query ? (queryParameters(route.query) ?? []) : []),
    ],
    ...(route.body
      ? {
          requestBody: {
            required: true as const,
            content: { 'application/json': { schema: toJson(route.body, 'input') } },
          },
        }
      : {}),
    responses,
  };
}

export function buildOpenApiDocument(): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};

  // Merged, not assigned: `/api/v1/reservations` is served by both a GET and a
  // POST, and overwriting would silently drop whichever came first.
  for (const route of ROUTES) {
    paths[route.path] = { ...paths[route.path], [route.method]: operationFor(route) };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Cinema Booking Platform API',
      version: '1.0.0',
      description:
        'Catalogue of movies, cinemas, showtimes and seat maps, plus seat reservations. Generated from the Zod schemas in @cinema/contracts, which are the same schemas that validate requests.',
    },
    paths,
  };
}
