import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { ConfigService } from '../config/config.service';
import { schema } from './schema';

export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');

export type Database = NodePgDatabase<typeof schema>;

/**
 * Anything that reads or writes accepts one of these. Sub-project 2 passes a
 * transaction here instead of the pool, without touching a single call site.
 */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const pool = new Pool({
          connectionString: configService.config.databaseUrl,
          max: configService.config.databasePoolMax,
        });

        // pg raises this on the pool when an *idle* client's connection dies --
        // a database restart, a failover, a dropped link. Node turns an
        // unhandled 'error' event into a process abort, so without this listener
        // a Postgres restart takes the API down with it. The pool has already
        // discarded the dead client by the time we get here; the next checkout
        // opens a fresh one.
        pool.on('error', (error: Error) => {
          new Logger(DrizzleModule.name).error('idle database client failed', error.stack);
        });

        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DrizzleModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Draining the pool on SIGTERM is what makes a rolling restart quiet. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
