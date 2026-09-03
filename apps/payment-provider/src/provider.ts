import { randomUUID } from 'node:crypto';

import {
  chargeRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  PAYMENT_SCENARIO_HEADER,
  type ChargeResponse,
} from '@cinema/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

import { pickScenario, type ScenarioWeights } from './scenario';
import { IdempotencyStore } from './store';

export interface ProviderOptions {
  weights: ScenarioWeights;
  /** How long the `timeout` scenario withholds its answer. */
  hangMs: number;
  random?: () => number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function buildProvider(options: ProviderOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = new IdempotencyStore();
  const random = options.random ?? Math.random;

  app.get('/health', () => ({ status: 'ok', charges: store.size }));

  app.post('/charge', async (request, reply) => {
    const key = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (typeof key !== 'string' || key.length === 0) {
      // A charge with no key cannot be made safe to retry, so it is refused
      // rather than made once and hoped about.
      return reply.code(400).send({ error: 'idempotency-key is required' });
    }

    const replay = store.get(key);
    if (replay) {
      return reply.code(replay.status).header(IDEMPOTENT_REPLAY_HEADER, 'true').send(replay.body);
    }

    const body = chargeRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid charge request' });
    }

    const scenario = pickScenario(
      request.headers[PAYMENT_SCENARIO_HEADER] as string | undefined,
      options.weights,
      random,
    );

    if (scenario === 'error') {
      // Deliberately NOT stored. A 500 is the absence of an outcome, so a retry
      // must genuinely retry -- storing it would turn one blip into a permanent
      // failure for that key.
      return reply.code(500).send({ error: 'provider unavailable' });
    }

    if (scenario === 'decline') {
      const declined: ChargeResponse = { status: 'DECLINED', declineReason: 'insufficient-funds' };
      store.set(key, { status: 200, body: declined });
      return reply.code(200).send(declined);
    }

    const succeeded: ChargeResponse = {
      status: 'SUCCEEDED',
      providerRef: `ch_${randomUUID()}`,
      amountCents: body.data.amountCents,
    };

    // Stored BEFORE the answer is sent, and before the hang. This is the entire
    // point of the timeout scenario: the money moves when the decision is made,
    // not when the client hears about it. A provider that recorded its answer
    // on the way out would charge twice on every retried timeout, which is the
    // exact failure spec.md section 11 asks us to make impossible.
    store.set(key, { status: 200, body: succeeded });

    if (scenario === 'timeout') await delay(options.hangMs);

    return reply.code(200).send(succeeded);
  });

  return app;
}
