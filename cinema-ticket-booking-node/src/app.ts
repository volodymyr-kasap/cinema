import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { BookingError, type BookingStore } from './booking/domain.js';
import { bookingRoutes } from './booking/routes.js';
import { BookingService } from './booking/service.js';
import { movies } from './movies.js';

const staticRoot = fileURLToPath(new URL('../static', import.meta.url));

export async function buildApp(
  store: BookingStore,
  opts: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify(opts);

  // The frontend reads `data.error` off every failed response, so every error
  // leaves through here in that shape.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof BookingError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }

    if (error.validation) {
      return reply.code(400).send({ error: error.message });
    }

    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error(error);

    return reply.code(status).send({ error: status >= 500 ? 'internal server error' : error.message });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not found' }));

  app.get('/movies', async () => movies);

  await app.register(bookingRoutes(new BookingService(store)));

  await app.register(fastifyStatic, { root: staticRoot });

  return app;
}
