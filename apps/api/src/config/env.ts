import { z } from 'zod';

const envSchema = z.object({
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
});

export type AppConfig = {
  nodeEnv: z.infer<typeof envSchema>['NODE_ENV'];
  port: number;
  host: string;
  databaseUrl: string;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  publicErrorBaseUrl: string;
  reservationTtlSeconds: number;
  databasePoolMax: number;
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
  };
}
