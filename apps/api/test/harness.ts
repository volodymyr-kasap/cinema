import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

declare global {
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
  var __REDIS_CONTAINER__: StartedTestContainer | undefined;
  var __RABBIT_CONTAINER__: StartedTestContainer | undefined;
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
