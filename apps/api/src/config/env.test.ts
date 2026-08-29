import { parseEnv } from './env';

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgres://cinema:cinema@localhost:5432/cinema',
  LOG_LEVEL: 'silent',
  PUBLIC_ERROR_BASE_URL: 'https://cinema.example/errors',
};

describe('parseEnv', () => {
  it('parses a valid environment into typed config', () => {
    expect(parseEnv(valid)).toEqual({
      nodeEnv: 'test',
      port: 3000,
      host: '0.0.0.0',
      databaseUrl: 'postgres://cinema:cinema@localhost:5432/cinema',
      logLevel: 'silent',
      publicErrorBaseUrl: 'https://cinema.example/errors',
      reservationTtlSeconds: 600,
      databasePoolMax: 10,
      lockStrategy: 'db',
      redisUrl: undefined,
      redisCommandTimeoutMs: 200,
    });
  });

  it('applies defaults for everything except DATABASE_URL', () => {
    const config = parseEnv({ DATABASE_URL: valid.DATABASE_URL });
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.logLevel).toBe('info');
    // Ten minutes to pay (spec.md §9), and the pool the contention suite raises.
    expect(config.reservationTtlSeconds).toBe(600);
    expect(config.databasePoolMax).toBe(10);
    expect(config.lockStrategy).toBe('db');
    expect(config.redisUrl).toBeUndefined();
    expect(config.redisCommandTimeoutMs).toBe(200);
  });

  it('throws a readable error when DATABASE_URL is missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('throws when PORT is not a number', () => {
    expect(() => parseEnv({ ...valid, PORT: 'http' })).toThrow(/PORT/);
  });

  it('defaults to database locking, so the new subsystem never switches itself on', () => {
    const config = parseEnv({ DATABASE_URL: valid.DATABASE_URL });
    expect(config.lockStrategy).toBe('db');
    expect(config.redisUrl).toBeUndefined();
    expect(config.redisCommandTimeoutMs).toBe(200);
  });

  it('refuses to start with redis locking and no REDIS_URL', () => {
    // A 500 on every request would be the alternative, discovered in production
    // by a user rather than at boot by the process.
    expect(() => parseEnv({ ...valid, LOCK_STRATEGY: 'redis' })).toThrow(/REDIS_URL/);
  });

  it('accepts redis locking when the URL is present', () => {
    const config = parseEnv({
      ...valid,
      LOCK_STRATEGY: 'redis',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_COMMAND_TIMEOUT_MS: '50',
    });
    expect(config.lockStrategy).toBe('redis');
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.redisCommandTimeoutMs).toBe(50);
  });

  it('rejects a REDIS_URL that is not a redis URL', () => {
    expect(() =>
      parseEnv({ ...valid, LOCK_STRATEGY: 'redis', REDIS_URL: 'http://localhost:6379' }),
    ).toThrow(/REDIS_URL/);
  });

  it('rejects an unknown lock strategy', () => {
    expect(() => parseEnv({ ...valid, LOCK_STRATEGY: 'zookeeper' })).toThrow(/LOCK_STRATEGY/);
  });
});
