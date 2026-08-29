import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis, type Result } from 'ioredis';

import { ConfigService } from '../config/config.service';

export const REDIS = Symbol('REDIS');

/**
 * `defineCommand` installs these on the client at runtime; TypeScript learns
 * about them here. Both take the key count first because the number of seats
 * varies per request, so `numberOfKeys` cannot be fixed in the definition.
 */
declare module 'ioredis' {
  interface RedisCommander<Context> {
    releaseSeats(numKeys: number, ...args: (string | number)[]): Result<number, Context>;
    retainSeats(numKeys: number, ...args: (string | number)[]): Result<number, Context>;
  }
}

/**
 * Read, compare, delete -- as one server-side step. Three client commands would
 * be the same check-then-act race the database path exists to avoid: between the
 * GET and the DEL the key can lapse and be re-taken, and we would delete a lock
 * belonging to someone else.
 */
const RELEASE_LUA = `
local removed = 0
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then
    removed = removed + redis.call('DEL', KEYS[i])
  end
end
return removed
`;

/** The same ownership check, extending instead of deleting. */
const RETAIN_LUA = `
local kept = 0
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then
    redis.call('SET', KEYS[i], ARGV[1], 'EX', ARGV[2])
    kept = kept + 1
  end
end
return kept
`;

export function createRedisClient(
  url: string,
  commandTimeoutMs: number,
  onError: (error: Error) => void,
): Redis {
  const client = new Redis(url, {
    commandTimeout: commandTimeoutMs,
    // Fail open needs a fast, definite failure. The defaults queue commands
    // while the link is down and retry them twenty times, which turns an
    // unreachable Redis into a hung request rather than a degraded one.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // Nothing connects until connect() is called, so the error listener below
    // is guaranteed to be attached before the first connection attempt.
    lazyConnect: true,
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  });

  // ioredis emits 'error' on every failed reconnection attempt, and an
  // EventEmitter 'error' with no listener aborts the process -- the same trap
  // the pg pool has in DrizzleModule. A dead Redis must degrade, not crash.
  client.on('error', onError);

  client.defineCommand('releaseSeats', { lua: RELEASE_LUA });
  client.defineCommand('retainSeats', { lua: RETAIN_LUA });

  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis | null => {
        const { lockStrategy, redisUrl, redisCommandTimeoutMs } = configService.config;
        // Strategy `db` opens no connection at all. A client nobody uses would
        // still reconnect, still log, and still make the baseline run of the
        // experiment different from sub-project 2's.
        if (lockStrategy !== 'redis' || !redisUrl) return null;

        const logger = new Logger(RedisModule.name);
        return createRedisClient(redisUrl, redisCommandTimeoutMs, (error) => {
          logger.warn(`redis connection error: ${error.message}`);
        });
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  /**
   * Connecting here rather than lazily on the first command removes a startup
   * race: the first request would otherwise fail open while the socket is still
   * opening. A Redis that is down at boot must not stop the process -- the
   * database path is still fully correct without it.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.connect();
    } catch (error) {
      this.logger.warn(`redis unreachable at startup, running fail-open: ${String(error)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.redis) return;
    // quit() drains in-flight commands; if the link is already gone it rejects,
    // and there is nothing left to drain.
    await this.redis.quit().catch(() => this.redis?.disconnect());
  }
}
