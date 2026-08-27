export interface Config {
  host: string;
  port: number;
  redisUrl: string;
  holdTtlMs: number;
  store: 'redis' | 'memory';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const store = env.STORE ?? 'redis';
  if (store !== 'redis' && store !== 'memory') {
    throw new Error(`STORE must be "redis" or "memory", got "${store}"`);
  }

  return {
    host: env.HOST ?? '0.0.0.0',
    port: numeric(env.PORT, 8080),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    holdTtlMs: numeric(env.HOLD_TTL_SECONDS, 120) * 1000,
    store,
  };
}

function numeric(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`expected a number, got "${value}"`);

  return parsed;
}
