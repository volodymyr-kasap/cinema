import { ATTEMPT_HEADER, type Ladder } from './messages';

export interface NextHop {
  /** Where to republish. */
  routingKey: string;
  /** The value to stamp into `x-attempt` on the republished message. */
  attempt: number;
  /** True when the tiers are exhausted and this hop is the dead-letter queue. */
  dead: boolean;
}

/**
 * `x-attempt` is the number of failed handlings *so far*: the producer publishes
 * 0, and a handler that fails on n republishes with n + 1 into tier n + 1. With
 * three tiers the handler runs at most four times (spec §3).
 *
 * The ladder is a parameter rather than a default, and deliberately has no
 * default value: two messages climb ladders now, and a call site that forgot to
 * say which one would silently dead-letter a payment into the expiry DLQ.
 */
export function nextHop(attempt: number, retryDelaysMs: number[], ladder: Ladder): NextHop {
  const next = attempt + 1;

  if (next > retryDelaysMs.length) {
    return { routingKey: ladder.deadKey, attempt: next, dead: true };
  }
  return { routingKey: ladder.retryKey(next), attempt: next, dead: false };
}

/**
 * Tolerates a message published without the header, or with a nonsense value:
 * such a message starts at the beginning of the ladder rather than crashing the
 * consumer that received it.
 */
export function attemptOf(headers: Record<string, unknown> | undefined): number {
  const raw = headers?.[ATTEMPT_HEADER];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}
