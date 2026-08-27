import type { FastifyPluginAsync } from 'fastify';

import type { Booking } from './domain.js';
import type { BookingService } from './service.js';

const userBody = {
  type: 'object',
  required: ['user_id'],
  properties: {
    user_id: { type: 'string', minLength: 1 },
  },
} as const;

const sessionResponse = {
  type: 'object',
  properties: {
    session_id: { type: 'string' },
    movie_id: { type: 'string' },
    seat_id: { type: 'string' },
    user_id: { type: 'string' },
    status: { type: 'string' },
    expires_at: { type: 'string', nullable: true },
  },
} as const;

interface UserBody {
  user_id: string;
}

interface MovieParams {
  movieId: string;
}

interface SeatParams extends MovieParams {
  seatId: string;
}

interface SessionParams {
  sessionId: string;
}

export const bookingRoutes =
  (svc: BookingService): FastifyPluginAsync =>
  async (fastify) => {
    fastify.get<{ Params: MovieParams }>(
      '/movies/:movieId/seats',
      {
        schema: {
          response: {
            200: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  seat_id: { type: 'string' },
                  user_id: { type: 'string' },
                  booked: { type: 'boolean' },
                  confirmed: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
      async (request) => {
        const bookings = await svc.listBookings(request.params.movieId);

        return bookings.map((b) => ({
          seat_id: b.seatId,
          user_id: b.userId,
          booked: true,
          confirmed: b.status === 'confirmed',
        }));
      },
    );

    fastify.post<{ Params: SeatParams; Body: UserBody }>(
      '/movies/:movieId/seats/:seatId/hold',
      {
        schema: {
          body: userBody,
          response: { 201: sessionResponse },
        },
      },
      async (request, reply) => {
        const { movieId, seatId } = request.params;

        const session = await svc.hold({
          movieId,
          seatId,
          userId: request.body.user_id,
        });

        return reply.code(201).send(toSessionResponse(session));
      },
    );

    fastify.put<{ Params: SessionParams; Body: UserBody }>(
      '/sessions/:sessionId/confirm',
      {
        schema: {
          body: userBody,
          response: { 200: sessionResponse },
        },
      },
      async (request) => {
        const session = await svc.confirmSeat(request.params.sessionId, request.body.user_id);

        return toSessionResponse(session);
      },
    );

    fastify.delete<{ Params: SessionParams; Body: UserBody }>(
      '/sessions/:sessionId',
      { schema: { body: userBody } },
      async (request, reply) => {
        await svc.releaseSeat(request.params.sessionId, request.body.user_id);

        return reply.code(204).send();
      },
    );
  };

function toSessionResponse(b: Booking) {
  return {
    session_id: b.id,
    movie_id: b.movieId,
    seat_id: b.seatId,
    user_id: b.userId,
    status: b.status,
    expires_at: b.expiresAt?.toISOString() ?? null,
  };
}
