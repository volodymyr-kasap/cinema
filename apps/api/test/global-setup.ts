import { writeFileSync } from 'node:fs';

import { startTestDatabase, startTestRedis } from './harness';

export default async function globalSetup(): Promise<void> {
  // Concurrently: two image pulls in series is a minute of CI for no reason.
  const [postgres, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

  globalThis.__PG_CONTAINER__ = postgres;
  globalThis.__REDIS_CONTAINER__ = redis;

  writeFileSync(`${__dirname}/.database-url`, postgres.getConnectionUri(), 'utf8');
  writeFileSync(
    `${__dirname}/.redis-url`,
    `redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`,
    'utf8',
  );
}
