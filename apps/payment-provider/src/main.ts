import { buildProvider } from './provider';

const number = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a non-negative number`);
  return value;
};

async function main(): Promise<void> {
  const app = buildProvider({
    weights: {
      success: number('PROVIDER_SUCCESS_RATE', 0.85),
      decline: number('PROVIDER_DECLINE_RATE', 0.1),
      error: number('PROVIDER_ERROR_RATE', 0.03),
      timeout: number('PROVIDER_TIMEOUT_RATE', 0.02),
    },
    hangMs: number('PROVIDER_HANG_MS', 30_000),
  });

  const port = number('PORT', 4000);
  // 0.0.0.0, not localhost: inside a container the loopback interface is not
  // reachable from the rest of the compose network.
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`payment provider listening on ${String(port)}`);
}

void main();
