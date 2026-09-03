export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Thrown instead of calling the downstream. It is an ordinary failure as far as
 * the caller is concerned -- in this codebase that means the message climbs to
 * the next retry tier -- which is exactly the intent: the breaker decides
 * whether to call, the ladder decides when to try again. Neither reimplements
 * the other.
 */
export class CircuitOpenError extends Error {
  constructor(remainingMs: number) {
    super(`circuit is open for another ${String(remainingMs)}ms`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long it stays open before admitting one trial call. */
  openMs: number;
  /** Injected so tests move time by hand instead of sleeping. */
  now?: () => number;
}

/**
 * One downstream, one breaker, one process. State is deliberately local: a
 * breaker shared through Redis would put Redis on the payment path and would
 * need an answer to "what if the breaker state is unreadable", whose only
 * honest answer -- fail open -- disables the breaker exactly when it matters
 * (ADR 0038).
 *
 * Only a *thrown* error counts as a failure. A call that resolves has succeeded
 * whatever it resolved to, which is how a declined card is kept from opening
 * the circuit without this class knowing what a card is.
 */
export class CircuitBreaker {
  private state_: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  /** True while the single half-open trial call is in flight. */
  private trialInFlight = false;
  private rejectedCount = 0;

  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions) {
    this.threshold = options.failureThreshold;
    this.openMs = options.openMs;
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    return this.state_;
  }

  /** Consecutive failures right now, not since boot. Zero whenever closed and healthy. */
  get failures(): number {
    return this.consecutiveFailures;
  }

  /** Calls refused without touching the downstream, since boot. */
  get rejected(): number {
    return this.rejectedCount;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state_ === 'OPEN') {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.openMs) {
        this.rejectedCount += 1;
        throw new CircuitOpenError(this.openMs - elapsed);
      }
      this.state_ = 'HALF_OPEN';
      this.trialInFlight = false;
    }

    if (this.state_ === 'HALF_OPEN') {
      // One trial at a time. Without this the whole queued backlog arrives at
      // the downstream the instant openMs lapses.
      if (this.trialInFlight) {
        this.rejectedCount += 1;
        throw new CircuitOpenError(0);
      }
      this.trialInFlight = true;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.state_ = 'CLOSED';
    this.consecutiveFailures = 0;
    this.trialInFlight = false;
  }

  private onFailure(): void {
    this.trialInFlight = false;

    // A failed trial restarts the full quiet period rather than resuming what
    // was left of it: the downstream just told us it is still broken.
    if (this.state_ === 'HALF_OPEN') {
      this.open();
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) this.open();
  }

  private open(): void {
    this.state_ = 'OPEN';
    this.openedAt = this.now();
  }
}
