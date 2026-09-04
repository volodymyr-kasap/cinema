import { Injectable } from '@nestjs/common';

import type { SeatLock } from './seat-lock';

/**
 * Strategy `db`: sub-project 2's behaviour, expressed as an adapter rather than
 * as an `if`. `acquire` losing nothing means every caller proceeds to the
 * transaction and the unique index settles the race, exactly as before.
 *
 * This class is what makes the section 25 comparison honest. If the two
 * strategies were two code paths, the experiment would be measuring the
 * difference between two implementations; because `db` is this class plugged
 * into the same `create()`, it measures the lock.
 */
@Injectable()
export class NoopSeatLock implements SeatLock {
  acquire(): Promise<string[]> {
    return Promise.resolve([]);
  }

  release(): Promise<void> {
    return Promise.resolve();
  }

  retain(): Promise<void> {
    return Promise.resolve();
  }

  retainFor(): Promise<void> {
    return Promise.resolve();
  }
}
