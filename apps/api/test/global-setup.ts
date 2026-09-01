import { writeFileSync } from 'node:fs';

import { startTestDatabase, startTestRabbit, startTestRedis } from './harness';

export default async function globalSetup(): Promise<void> {
  // Concurrently: three image pulls in series is minutes of CI for no reason.
  const [postgres, redis, rabbit] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
    startTestRabbit(),
  ]);

  globalThis.__PG_CONTAINER__ = postgres;
  globalThis.__REDIS_CONTAINER__ = redis;
  globalThis.__RABBIT_CONTAINER__ = rabbit;

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
}
