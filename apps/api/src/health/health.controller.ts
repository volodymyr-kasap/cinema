import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../db/drizzle.module';

@Controller()
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
