import { writeFileSync } from 'node:fs';

import { startTestDatabase, startTestProvider, startTestRabbit, startTestRedis } from './harness';

export default async function globalSetup(): Promise<void> {
  // Concurrently: three image pulls in series is minutes of CI for no reason.
  const [postgres, redis, rabbit, provider] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
    startTestRabbit(),
    startTestProvider(),
  ]);

  globalThis.__PG_CONTAINER__ = postgres;
  globalThis.__REDIS_CONTAINER__ = redis;
  globalThis.__RABBIT_CONTAINER__ = rabbit;
  globalThis.__PROVIDER__ = provider;

  writeFileSync(`${__dirname}/.database-url`, postgres.getConnectionUri(), 'utf8');
  writeFileSync(
    `${__dirname}/.redis-url`,
    `redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`,
    'utf8',
  );
  writeFileSync(
    `${__dirname}/.rabbit-url`,
    `amqp://guest:guest@${rabbit.getHost()}:${String(rabbit.getMappedPort(5672))}`,
    'utf8',
  );
  writeFileSync(
    `${__dirname}/.rabbit-management-url`,
    `http://guest:guest@${rabbit.getHost()}:${String(rabbit.getMappedPort(15672))}`,
    'utf8',
  );

  const address = provider.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('provider did not bind');
  writeFileSync(`${__dirname}/.provider-url`, `http://127.0.0.1:${String(address.port)}`, 'utf8');
}
