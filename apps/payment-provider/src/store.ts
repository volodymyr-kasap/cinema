export interface StoredCharge {
  status: number;
  body: unknown;
}

/**
 * The whole of the provider's idempotency: a key to the answer it was given.
 *
 * In memory on purpose. Restarting this process is restarting the bank, not
 * losing our reservation, and the tests that prove a replay run against one
 * instance. A real provider's version of this is a database row; the mechanism
 * being demonstrated is identical.
 */
export class IdempotencyStore {
  private readonly answers = new Map<string, StoredCharge>();

  get(key: string): StoredCharge | undefined {
    return this.answers.get(key);
  }

  set(key: string, value: StoredCharge): void {
    this.answers.set(key, value);
  }

  get size(): number {
    return this.answers.size;
  }
}
