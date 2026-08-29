import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ConfigService } from '../config/config.service';
import { NoopSeatLock } from './noop-seat-lock';
import { RedisSeatLock } from './redis-seat-lock';
import { REDIS, RedisModule } from './redis.module';
import { SEAT_LOCK, type SeatLock } from './seat-lock';

@Module({
  imports: [RedisModule],
  providers: [
    {
      provide: SEAT_LOCK,
      inject: [ConfigService, REDIS],
      useFactory: (configService: ConfigService, redis: Redis | null): SeatLock =>
        // `redis &&` is not belt-and-braces: env.ts already refuses to boot with
        // strategy `redis` and no URL, and this keeps the two facts in one place
        // rather than trusting the reader to remember the other.
        configService.config.lockStrategy === 'redis' && redis
          ? new RedisSeatLock(redis, configService)
          : new NoopSeatLock(),
    },
  ],
  exports: [SEAT_LOCK],
})
export class LockingModule {}
