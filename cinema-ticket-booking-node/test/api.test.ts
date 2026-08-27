import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { MemoryBookingStore } from '../src/booking/memory-store.js';

const HOLD_TTL_MS = 60_000;

describe('booking API', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp(new MemoryBookingStore(HOLD_TTL_MS));
  });

  after(async () => {
    await app.close();
  });

  const hold = (movieId: string, seatId: string, userId: string) =>
    app.inject({
      method: 'POST',
      url: `/movies/${movieId}/seats/${seatId}/hold`,
      payload: { user_id: userId },
    });

  it('holds a free seat', async () => {
    const res = await hold('inception', 'A1', 'alice');
    const body = res.json();

    assert.equal(res.statusCode, 201);
    assert.equal(body.seat_id, 'A1');
    assert.equal(body.movie_id, 'inception');
    assert.equal(body.status, 'held');
    assert.ok(body.session_id);
    assert.ok(Date.parse(body.expires_at) > Date.now());
  });

  it('answers 409 when the seat is already held', async () => {
    await hold('inception', 'B2', 'alice');

    const res = await hold('inception', 'B2', 'bob');

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'seat is already taken');
  });

  it('rejects a body without user_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/movies/inception/seats/C3/hold',
      payload: {},
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error);
  });

  it('lists held and confirmed seats for a movie', async () => {
    await hold('dune', 'A1', 'alice');
    const held = await hold('dune', 'A2', 'bob');
    await app.inject({
      method: 'PUT',
      url: `/sessions/${held.json().session_id}/confirm`,
      payload: { user_id: 'bob' },
    });

    const seats = (await app.inject({ method: 'GET', url: '/movies/dune/seats' })).json();
    const bySeat = new Map(seats.map((s: { seat_id: string }) => [s.seat_id, s]));

    assert.equal(seats.length, 2);
    assert.deepEqual(bySeat.get('A1'), {
      seat_id: 'A1',
      user_id: 'alice',
      booked: true,
      confirmed: false,
    });
    assert.deepEqual(bySeat.get('A2'), {
      seat_id: 'A2',
      user_id: 'bob',
      booked: true,
      confirmed: true,
    });
  });

  it('confirms a held seat', async () => {
    const session = (await hold('inception', 'D4', 'alice')).json();

    const res = await app.inject({
      method: 'PUT',
      url: `/sessions/${session.session_id}/confirm`,
      payload: { user_id: 'alice' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'confirmed');
    assert.equal(res.json().expires_at, null);
  });

  it('refuses to confirm someone else’s session', async () => {
    const session = (await hold('inception', 'E5', 'alice')).json();

    const res = await app.inject({
      method: 'PUT',
      url: `/sessions/${session.session_id}/confirm`,
      payload: { user_id: 'mallory' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'session belongs to another user');
  });

  it('answers 404 for an unknown session', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/sessions/does-not-exist/confirm',
      payload: { user_id: 'alice' },
    });

    assert.equal(res.statusCode, 404);
  });

  it('releases a held seat and frees it for the next user', async () => {
    const session = (await hold('inception', 'F6', 'alice')).json();

    const released = await app.inject({
      method: 'DELETE',
      url: `/sessions/${session.session_id}`,
      payload: { user_id: 'alice' },
    });
    assert.equal(released.statusCode, 204);

    const retaken = await hold('inception', 'F6', 'bob');
    assert.equal(retaken.statusCode, 201);
  });

  it('refuses to release someone else’s session', async () => {
    const session = (await hold('inception', 'G7', 'alice')).json();

    const res = await app.inject({
      method: 'DELETE',
      url: `/sessions/${session.session_id}`,
      payload: { user_id: 'mallory' },
    });

    assert.equal(res.statusCode, 403);
  });

  it('serves the frontend at /', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
  });
});
