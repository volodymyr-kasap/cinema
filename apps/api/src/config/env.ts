import { z } from 'zod';

const envObject = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PUBLIC_ERROR_BASE_URL: z.url().default('https://cinema.example/errors'),
  // Section 9 of spec.md gives the user ten minutes to pay. Configurable because
  // the contention tests need it expressed in seconds.
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(600),
  // The contention test must hold more simultaneous transactions than it has
  // clients; at the default of 10 it would measure the connection queue instead
  // of the seat race, and pass for the wrong reason.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  // `db` by default, deliberately: a new subsystem does not switch itself on,
  // and sub-project 2's path must stay the reproducible baseline of the
  // section 25 experiment (ADR 0017).
  LOCK_STRATEGY: z.enum(['db', 'redis']).default('db'),
  // No default. Spec §7 lists one, but a default makes the check below vacuous,
  // and refusing to boot beats answering 500 to every request (ADR 0018).
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
  // The threshold past which a slow Redis is treated as a dead one and the
  // request falls through to the database path.
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(200),
});

const envSchema = envObject.refine(
  (env) => env.LOCK_STRATEGY !== 'redis' || env.REDIS_URL !== undefined,
  {
    path: ['REDIS_URL'],
    error: 'REDIS_URL is required when LOCK_STRATEGY is redis',
  },
);

export type AppConfig = {
  nodeEnv: z.infer<typeof envObject>['NODE_ENV'];
  port: number;
  host: string;
  databaseUrl: string;
  logLevel: z.infer<typeof envObject>['LOG_LEVEL'];
  publicErrorBaseUrl: string;
  reservationTtlSeconds: number;
  databasePoolMax: number;
  lockStrategy: z.infer<typeof envObject>['LOCK_STRATEGY'];
  redisUrl: string | undefined;
  redisCommandTimeoutMs: number;
};

/**
 * Parses the process environment once, at startup. A misconfigured process must
 * fail loudly here rather than answer 500 to every request.
 */
export function parseEnv(source: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }

  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    publicErrorBaseUrl: env.PUBLIC_ERROR_BASE_URL.replace(/\/+$/, ''),
    reservationTtlSeconds: env.RESERVATION_TTL_SECONDS,
    databasePoolMax: env.DATABASE_POOL_MAX,
    lockStrategy: env.LOCK_STRATEGY,
    redisUrl: env.REDIS_URL,
    redisCommandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
  };
}
