import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { parseEnv } from '../config/env';

/** Run as its own step (a compose service, a CI job), never from the app bootstrap. */
async function main(): Promise<void> {
  const { databaseUrl } = parseEnv(process.env);
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await migrate(drizzle(pool), { migrationsFolder: `${__dirname}/../../drizzle` });
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
