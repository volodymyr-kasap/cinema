import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

declare global {
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
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
