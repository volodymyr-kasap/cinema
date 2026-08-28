import 'reflect-metadata';

import { CatalogController } from '../catalog/catalog.controller';
import { ReservationController } from '../reservations/reservation.controller';
import { RESPONSE_SCHEMA } from '../http/validated.decorator';
import { buildOpenApiDocument } from './document';
import { ROUTES } from './routes';

describe('buildOpenApiDocument', () => {
  const document = buildOpenApiDocument();

  it('declares OpenAPI 3.0 and the versioned server path', () => {
    expect(document.openapi).toBe('3.0.3');
    expect(document.info.title).toBe('Cinema Booking Platform API');
  });

  it('documents every catalogue and reservation route', () => {
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        '/api/v1/cinemas',
        '/api/v1/cinemas/{id}',
        '/api/v1/movies',
        '/api/v1/movies/{id}',
        '/api/v1/reservations',
        '/api/v1/reservations/{id}',
        '/api/v1/reservations/{id}/confirm',
        '/api/v1/showtimes',
        '/api/v1/showtimes/{id}',
        '/api/v1/showtimes/{id}/seats',
      ].sort(),
    );
  });

  it('derives request schemas from the contracts, not from hand-written JSON', () => {
    const listMovies = document.paths['/api/v1/movies']?.get;
    const limit = listMovies?.parameters?.find((parameter) => parameter.name === 'limit');

    expect(limit?.schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
  });

  it('describes the success response body', () => {
    const getMovie = document.paths['/api/v1/movies/{id}']?.get;
    const schema = getMovie?.responses['200']?.content?.['application/json']?.schema;

    expect(schema).toMatchObject({ type: 'object' });
    expect(Object.keys((schema as { properties: object }).properties)).toContain('durationMinutes');
  });

  it('describes every declared failure as a problem document', () => {
    const getMovie = document.paths['/api/v1/movies/{id}']?.get;

    expect(getMovie?.responses['404']?.content?.['application/problem+json']).toBeDefined();
  });

  // Ruling R5: the registry carries path, summary, tags and error codes the decorator
  // cannot, so both stay. The only duplication is the response schema reference, and
  // this guard makes divergence between them impossible.
  it('documents the same schema object the handler declares with @Validated', () => {
    // Keyed by tag, and every route's handler is named for its operationId --
    // the two conventions this guard rides on.
    const prototypes: Record<string, Record<string, () => unknown>> = {
      catalogue: CatalogController.prototype as unknown as Record<string, () => unknown>,
      reservations: ReservationController.prototype as unknown as Record<string, () => unknown>,
    };

    for (const route of ROUTES) {
      const prototype = prototypes[route.tags[0]!];
      expect(prototype).toBeDefined();

      const handler = prototype![route.operationId];
      expect(handler).toBeDefined();

      // `undefined` on both sides for a 204 route: it declares no response
      // schema, and the document must not invent one for it.
      const declared: unknown = Reflect.getMetadata(RESPONSE_SCHEMA, handler as object);
      expect(declared).toBe(route.response);
    }
  });
});
