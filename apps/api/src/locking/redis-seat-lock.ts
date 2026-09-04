import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ConfigService } from '../config/config.service';
import { REDIS } from './redis.module';
import { seatKey, type SeatLock } from './seat-lock';

@Injectable()
export class RedisSeatLock implements SeatLock {
  private readonly logger = new Logger(RedisSeatLock.name);
  /**
   * Fail-open events since boot. Section 22 will scrape this; today it is what
   * the degradation test asserts on, and what a log line quotes so a reader can
   * tell one bad second from a Redis that has been dead all afternoon.
   */
  private failures = 0;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {}

  get failureCount(): number {
    return this.failures;
  }

  async acquire(showtimeId: string, seatIds: string[], reservationId: string): Promise<string[]> {
    if (seatIds.length === 0) return [];

    const ttl = this.configService.config.reservationTtlSeconds;
    // A pipeline, not MULTI: we need a reply per key to know which seats we
    // lost. MULTI would buy an atomicity we do not want -- the partial
    // acquisition is rolled back below, by us, deliberately.
    const pipeline = this.redis.pipeline();
    for (const seatId of seatIds) {
      pipeline.set(seatKey(showtimeId, seatId), reservationId, 'EX', ttl, 'NX');
    }
    // Keys are NOT sorted, and that is not an oversight. In the database the
    // order is mandatory: INSERT *waits* for the competing transaction, so
    // without a common order two requests deadlock (ADR 0010). SET NX does not
    // wait -- it fails immediately -- so no wait cycle exists to break.

    let replies: [Error | null, unknown][] | null;
    try {
      replies = await pipeline.exec();
    } catch (error) {
      this.failOpen('acquire', error);
      return [];
    }
    if (!replies) {
      this.failOpen('acquire', new Error('pipeline returned no replies'));
      return [];
    }

    const lost: string[] = [];
    const held: string[] = [];
    replies.forEach(([error, reply], index) => {
      const seatId = seatIds[index]!;
      if (error) {
        // A per-command failure is the same fail-open case as a dead socket. It
        // must not read as "this seat is taken": that would be Redis inventing
        // a conflict the database knows nothing about.
        this.failOpen('acquire', error);
        held.push(seatId);
        return;
      }
      if (reply === 'OK') held.push(seatId);
      else lost.push(seatId);
    });

    // Two of three is not a hold. Keeping the two we won would block seats
    // nobody is holding for the whole TTL, on behalf of a request that has
    // already failed.
    if (lost.length > 0 && held.length > 0) {
      await this.release(showtimeId, held, reservationId);
    }
    return lost;
  }

  async release(showtimeId: string, seatIds: string[], reservationId: string): Promise<void> {
    if (seatIds.length === 0) return;
    const keys = seatIds.map((seatId) => seatKey(showtimeId, seatId));

    try {
      await this.redis.releaseSeats(keys.length, ...keys, reservationId);
    } catch (error) {
      // Worse than a failed acquire: the key outlives the row and holds a seat
      // that is actually free. Bounded by the TTL, which is exactly why the TTL
      // is the length of a hold and not a day (spec §5).
      this.failOpen('release', error);
    }
  }

  async retain(
    showtimeId: string,
    seatIds: string[],
    reservationId: string,
    until: Date,
  ): Promise<void> {
    // The moment has passed: holds are refused after a showtime starts, so the
    // key has nothing left to defend and may lapse on its own schedule.
    // `retainFor` drops a non-positive window for the same reason.
    return this.retainFor(
      showtimeId,
      seatIds,
      reservationId,
      Math.ceil((until.getTime() - Date.now()) / 1_000),
    );
  }

  async retainFor(
    showtimeId: string,
    seatIds: string[],
    reservationId: string,
    seconds: number,
  ): Promise<void> {
    if (seatIds.length === 0 || seconds <= 0) return;

    const keys = seatIds.map((seatId) => seatKey(showtimeId, seatId));
    try {
      // SET, not EXPIRE: this may SHORTEN the window as well as lengthen it. A
      // hold that becomes a payment stops expiring on the hold's clock and
      // starts expiring on the payment's, and with the shipped defaults the
      // payment's is the shorter of the two.
      await this.redis.retainSeats(keys.length, ...keys, reservationId, seconds);
    } catch (error) {
      this.failOpen('retain', error);
    }
  }

  private failOpen(operation: string, error: unknown): void {
    this.failures += 1;
    this.logger.warn(
      `redis ${operation} failed (${String(this.failures)} since boot), continuing on the database path: ${String(error)}`,
    );
  }
}
