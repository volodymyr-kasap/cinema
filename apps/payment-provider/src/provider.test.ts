import { IDEMPOTENT_REPLAY_HEADER } from '@cinema/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildProvider } from './provider';

const weights = { success: 1, decline: 0, error: 0, timeout: 0 };
const reference = '00000000-0000-7000-8000-000000000001';

describe('the fake provider', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  const charge = (key: string, scenario?: string) =>
    app.inject({
      method: 'POST',
      url: '/charge',
      headers: {
        'idempotency-key': key,
        ...(scenario ? { 'x-payment-scenario': scenario } : {}),
      },
      payload: { amountCents: 4_500, reference },
    });

  it('charges and returns a provider reference', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    const response = await charge('key-1', 'success');

    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; providerRef: string };
    expect(body.status).toBe('SUCCEEDED');
    expect(body.providerRef).toMatch(/^ch_/);
  });

  it('declines without erroring', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    const response = await charge('key-2', 'decline');

    // 200, not 402: a decline is an answer, and the client must be able to tell
    // it apart from a downstream that could not answer at all.
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe('DECLINED');
  });

  it('answers 500 for the error scenario', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    expect((await charge('key-3', 'error')).statusCode).toBe(500);
  });

  it('replays a stored answer for a repeated key without charging again', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    const first = await charge('key-4', 'success');
    const second = await charge('key-4', 'decline');

    // The second call names a DIFFERENT scenario and is ignored: once a key has
    // an answer, that answer is what the key means.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
    expect(first.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
  });

  it('stores the answer BEFORE hanging, so a lost response is recoverable', async () => {
    app = buildProvider({ weights, hangMs: 30_000 });

    // Fire the hanging request and do not await it: this is the client whose
    // response goes missing. The charge has happened; only the answer is lost.
    const hanging = charge('key-5', 'timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const retry = await charge('key-5');
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { status: string }).status).toBe('SUCCEEDED');
    expect(retry.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');

    // This assertion is the point of the whole sub-project: the retry replayed
    // rather than charged. A provider that recorded its answer only on the way
    // out would charge twice here and no test would notice (spec.md section 11).
    //
    // The hanging inject is settled here so closing the app in afterEach cannot
    // surface it as an unhandled rejection blamed on a later test.
    hanging.catch(() => undefined);
  });

  it('rejects a charge with no idempotency key', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    const response = await app.inject({
      method: 'POST',
      url: '/charge',
      payload: { amountCents: 4_500, reference },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed body', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    const response = await app.inject({
      method: 'POST',
      url: '/charge',
      headers: { 'idempotency-key': 'key-6' },
      payload: { amountCents: -1, reference: 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers /health', async () => {
    app = buildProvider({ weights, hangMs: 50 });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
