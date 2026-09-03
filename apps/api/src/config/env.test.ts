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
      reservationExpiryMode: 'lazy',
      rabbitmqUrl: undefined,
      rabbitmqPrefetch: 20,
      rabbitmqPublishTimeoutMs: 200,
      rabbitmqRetryDelaysMs: [5_000, 30_000, 120_000],
      paymentMode: 'off',
      paymentProviderUrl: undefined,
      paymentTimeoutMs: 2_000,
      paymentDeadlineSeconds: 300,
      paymentBreakerFailureThreshold: 5,
      paymentBreakerOpenMs: 30_000,
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
    expect(config.reservationExpiryMode).toBe('lazy');
    expect(config.rabbitmqUrl).toBeUndefined();
    expect(config.rabbitmqPrefetch).toBe(20);
    expect(config.rabbitmqPublishTimeoutMs).toBe(200);
    expect(config.rabbitmqRetryDelaysMs).toEqual([5_000, 30_000, 120_000]);
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

  it('accepts queue mode when a broker url is supplied', () => {
    const config = parseEnv({
      ...valid,
      RESERVATION_EXPIRY_MODE: 'queue',
      RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
    });
    expect(config.reservationExpiryMode).toBe('queue');
    expect(config.rabbitmqUrl).toBe('amqp://guest:guest@localhost:5672');
  });

  it('refuses queue mode without a broker url', () => {
    // The same rule as LOCK_STRATEGY/REDIS_URL: a default would make this
    // unreachable, so RABBITMQ_URL deliberately has none (spec §7).
    expect(() => parseEnv({ ...valid, RESERVATION_EXPIRY_MODE: 'queue' })).toThrow(/RABBITMQ_URL/);
  });

  it('rejects a broker url that is not amqp', () => {
    expect(() =>
      parseEnv({
        ...valid,
        RESERVATION_EXPIRY_MODE: 'queue',
        RABBITMQ_URL: 'http://localhost:5672',
      }),
    ).toThrow(/RABBITMQ_URL/);
  });

  it('parses the retry ladder into milliseconds', () => {
    const config = parseEnv({ ...valid, RABBITMQ_RETRY_DELAYS_MS: '100, 200,400' });
    expect(config.rabbitmqRetryDelaysMs).toEqual([100, 200, 400]);
  });

  it('rejects a retry ladder that is not positive integers', () => {
    expect(() => parseEnv({ ...valid, RABBITMQ_RETRY_DELAYS_MS: '100,nope' })).toThrow(
      /RABBITMQ_RETRY_DELAYS_MS/,
    );
  });

  it('rejects an empty retry ladder', () => {
    // Zero tiers would mean the first failure dead-letters, which is a decision
    // nobody made -- it must be spelled, not fallen into.
    expect(() => parseEnv({ ...valid, RABBITMQ_RETRY_DELAYS_MS: '' })).toThrow(
      /RABBITMQ_RETRY_DELAYS_MS/,
    );
  });

  it('defaults PAYMENT_MODE to off and needs no provider url', () => {
    const config = parseEnv({ DATABASE_URL: valid.DATABASE_URL });
    expect(config.paymentMode).toBe('off');
    expect(config.paymentProviderUrl).toBeUndefined();
    expect(config.paymentTimeoutMs).toBe(2_000);
    expect(config.paymentDeadlineSeconds).toBe(300);
    expect(config.paymentBreakerFailureThreshold).toBe(5);
    expect(config.paymentBreakerOpenMs).toBe(30_000);
  });

  it('requires PAYMENT_PROVIDER_URL when PAYMENT_MODE is queue', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: valid.DATABASE_URL,
        PAYMENT_MODE: 'queue',
        RABBITMQ_URL: 'amqp://localhost',
      }),
    ).toThrow(/PAYMENT_PROVIDER_URL/);
  });

  it('requires RABBITMQ_URL when PAYMENT_MODE is queue', () => {
    // Payment travels as a message. A broker-less queue mode would accept
    // confirms it could never settle.
    expect(() =>
      parseEnv({
        DATABASE_URL: valid.DATABASE_URL,
        PAYMENT_MODE: 'queue',
        PAYMENT_PROVIDER_URL: 'http://provider:4000',
      }),
    ).toThrow(/RABBITMQ_URL/);
  });

  it('accepts a fully configured queue mode', () => {
    const config = parseEnv({
      DATABASE_URL: valid.DATABASE_URL,
      PAYMENT_MODE: 'queue',
      PAYMENT_PROVIDER_URL: 'http://provider:4000/',
      RABBITMQ_URL: 'amqp://localhost',
    });
    expect(config.paymentMode).toBe('queue');
    // Trailing slash stripped, like PUBLIC_ERROR_BASE_URL: the client appends
    // '/charge' and '//charge' is a different path on a strict router.
    expect(config.paymentProviderUrl).toBe('http://provider:4000');
  });

  it('rejects a breaker threshold of zero', () => {
    // A threshold of zero opens the breaker before any call has failed, which
    // is a permanently disabled payment path presented as a configuration.
    expect(() =>
      parseEnv({ DATABASE_URL: valid.DATABASE_URL, PAYMENT_BREAKER_FAILURE_THRESHOLD: '0' }),
    ).toThrow();
  });
});
