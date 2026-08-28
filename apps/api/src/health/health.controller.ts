import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../db/drizzle.module';

// Version-neutral as well as prefix-excluded: setGlobalPrefix's `exclude` only
// strips the /api prefix, so without this enableVersioning would still serve these
// at /v1/health. Orchestrators probe a fixed, unversioned path.
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Liveness: the process is up. Deliberately touches no dependency. */
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: the process can serve traffic, which means PostgreSQL answers. */
  @Get('ready')
  async ready(): Promise<{ status: 'ready' }> {
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      throw new ServiceUnavailableException('database is not reachable');
    }
    return { status: 'ready' };
  }
}
