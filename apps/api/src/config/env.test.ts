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
  });

  it('throws a readable error when DATABASE_URL is missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('throws when PORT is not a number', () => {
    expect(() => parseEnv({ ...valid, PORT: 'http' })).toThrow(/PORT/);
  });
});
