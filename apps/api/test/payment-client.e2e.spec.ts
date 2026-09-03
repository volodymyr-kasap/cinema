import { randomUUID } from 'node:crypto';

import { ConfigService } from '../src/config/config.service';
import {
  PaymentProviderClient,
  ProviderUnavailableError,
} from '../src/payments/payment-provider.client';
import { CircuitOpenError } from '../src/resilience/circuit-breaker';
import { getTestProviderUrl } from './harness';

describe('PaymentProviderClient', () => {
  const build = (overrides: Record<string, string> = {}): PaymentProviderClient => {
    const restore = new Map<string, string | undefined>();
    const env: Record<string, string> = {
      PAYMENT_MODE: 'queue',
      PAYMENT_PROVIDER_URL: getTestProviderUrl(),
      RABBITMQ_URL: 'amqp://localhost',
      PAYMENT_TIMEOUT_MS: '400',
      PAYMENT_BREAKER_FAILURE_THRESHOLD: '2',
      PAYMENT_BREAKER_OPEN_MS: '200',
      ...overrides,
    };
    for (const [key, value] of Object.entries(env)) {
      restore.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      return new PaymentProviderClient(new ConfigService());
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  const command = (scenario: string | null) => ({
    paymentId: randomUUID(),
    reservationId: randomUUID(),
    amountCents: 4_500,
    scenario,
  });

  it('charges and returns the provider reference', async () => {
    const response = await build().charge(command('success'));
    expect(response).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('returns a decline as a value, not an exception', async () => {
    // This is where "a decline is not a failure" is actually enforced. The
    // breaker counts thrown errors; returning DECLINED means a run of refused
    // cards can never open the circuit.
    const client = build();
    for (let i = 0; i < 5; i += 1) {
      const response = await client.charge(command('decline'));
      expect(response).toMatchObject({ status: 'DECLINED' });
    }
    expect(client.breakerState).toBe('CLOSED');
  });

  it('throws ProviderUnavailableError on a 500', async () => {
    await expect(build().charge(command('error'))).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('throws ProviderUnavailableError when the provider hangs past the timeout', async () => {
    const started = Date.now();
    await expect(build().charge(command('timeout'))).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    // Bounded by PAYMENT_TIMEOUT_MS, not by the provider's 60s hang: the caller
    // is a worker with a ladder behind it, not a user watching a spinner.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('throws ProviderUnavailableError when the provider is not there at all', async () => {
    const client = build({ PAYMENT_PROVIDER_URL: 'http://127.0.0.1:1' });
    await expect(client.charge(command('success'))).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('opens the circuit after the configured run of failures and stops calling', async () => {
    const client = build({ PAYMENT_PROVIDER_URL: 'http://127.0.0.1:1' });

    await expect(client.charge(command(null))).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(client.charge(command(null))).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(client.breakerState).toBe('OPEN');

    const started = Date.now();
    await expect(client.charge(command(null))).rejects.toBeInstanceOf(CircuitOpenError);
    // Rejected without a connection attempt: an open breaker that still dials
    // is a logging decorator.
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('sends the payment id as the idempotency key on every attempt', async () => {
    const client = build();
    const one = command('success');

    const first = await client.charge(one);
    const second = await client.charge(one);

    // Same key, same answer, one charge. spec.md section 11, at the client.
    expect(second).toEqual(first);
  });
});
