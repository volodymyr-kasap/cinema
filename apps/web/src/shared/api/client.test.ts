import { movieSchema } from '@cinema/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../test/server';
import { ApiError, apiFetch } from './client';

const movie = {
  id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60',
  title: 'Dune: Part Two',
  description: 'seeded',
  durationMinutes: 166,
  posterUrl: 'https://images.example/posters/dune.jpg',
  releaseDate: '2024-03-01',
  rating: 8.5,
};

describe('apiFetch', () => {
  it('parses a successful response with the contract schema', async () => {
    server.use(http.get('/api/v1/movies/:id', () => HttpResponse.json(movie)));

    await expect(apiFetch('/api/v1/movies/1', movieSchema)).resolves.toEqual(movie);
  });

  it('turns a problem document into a typed ApiError', async () => {
    server.use(
      http.get('/api/v1/movies/:id', () =>
        HttpResponse.json(
          {
            type: 'https://cinema.example/errors/not-found',
            title: 'Resource not found',
            status: 404,
            detail: 'Movie 1 does not exist',
            instance: '/api/v1/movies/1',
            traceId: 'trace-1',
          },
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const error = await apiFetch('/api/v1/movies/1', movieSchema).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).problem.traceId).toBe('trace-1');
    expect((error as ApiError).message).toContain('does not exist');
  });

  it('still produces an ApiError when the server answers with something else entirely', async () => {
    server.use(
      http.get('/api/v1/movies/:id', () => new HttpResponse('gateway down', { status: 502 })),
    );

    const error = await apiFetch('/api/v1/movies/1', movieSchema).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it('fails loudly when the payload does not match the contract', async () => {
    server.use(
      http.get('/api/v1/movies/:id', () =>
        HttpResponse.json({ ...movie, durationMinutes: 'long' }),
      ),
    );

    await expect(apiFetch('/api/v1/movies/1', movieSchema)).rejects.toThrow(/contract/i);
  });
});
