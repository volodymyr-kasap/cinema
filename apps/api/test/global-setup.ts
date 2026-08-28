import { writeFileSync } from 'node:fs';

import { startTestDatabase } from './harness';

export default async function globalSetup(): Promise<void> {
  const container = await startTestDatabase();
  globalThis.__PG_CONTAINER__ = container;
  writeFileSync(`${__dirname}/.database-url`, container.getConnectionUri(), 'utf8');
}
