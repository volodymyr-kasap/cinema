import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

import { buildProvider } from '../../payment-provider/src/provider';

declare global {
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
  var __REDIS_CONTAINER__: StartedTestContainer | undefined;
  var __RABBIT_CONTAINER__: StartedTestContainer | undefined;
  var __PROVIDER__: FastifyInstance | undefined;
}

export async function startTestDatabase(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });

  try {
    await migrate(drizzle(pool), { migrationsFolder: `${__dirname}/../drizzle` });
  } finally {
    await pool.end();
  }

  return container;
}

export function getTestDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; global setup did not run');
  return url;
}

/**
 * `redis:8-alpine`, the image the compose stack runs, so the tests and the
 * experiment exercise the same server. Waiting on the log line rather than on
 * the port avoids the window where the socket is open and the server is not yet
 * answering -- which shows up as one flaky first assertion per run.
 */
export async function startTestRedis(): Promise<StartedTestContainer> {
  return new GenericContainer('redis:8-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
}

export function getTestRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set; global setup did not run');
  return url;
}

/**
 * The management image, matching the compose stack: the plugin costs a little
 * startup time and buys a UI to look at when a test fails in a way the
 * assertions do not explain. Waiting on the log line rather than the port
 * matters more here than for Redis -- the AMQP listener opens well before the
 * broker will accept a channel, and connecting into that window fails.
 */
export async function startTestRabbit(): Promise<StartedTestContainer> {
  return new GenericContainer('rabbitmq:4-management-alpine')
    .withExposedPorts(5672, 15672)
    .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
    .withStartupTimeout(180_000)
    .start();
}

export function getTestRabbitUrl(): string {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL is not set; global setup did not run');
  return url;
}

/**
 * The management API, used to cut connections from the broker's side. Restarting
 * the container would remap its ports and invalidate every URL the suite holds.
 */
export function getTestRabbitManagementUrl(): string {
  const url = process.env.RABBITMQ_MANAGEMENT_URL;
  if (!url) throw new Error('RABBITMQ_MANAGEMENT_URL is not set; global setup did not run');
  return url;
}

/**
 * The provider runs in the Jest process on an ephemeral port, not in a
 * container. It is a real socket and a real HTTP hop -- which is the whole
 * argument of ADR 0040 -- but building an image for eight hundred bytes of
 * Fastify would add a minute to every run for nothing.
 *
 * Every scenario the suites use is named by header, so the weights here only
 * decide what an un-headered request gets, and the suites never send one.
 */
export async function startTestProvider(): Promise<FastifyInstance> {
  const app = buildProvider({
    weights: { success: 1, decline: 0, error: 0, timeout: 0 },
    // Longer than any client timeout in the suite, so `timeout` really hangs.
    hangMs: 60_000,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}

export function getTestProviderUrl(): string {
  const url = process.env.PAYMENT_PROVIDER_URL;
  if (!url) throw new Error('PAYMENT_PROVIDER_URL is not set; global setup did not run');
  return url;
}
