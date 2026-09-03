import { Injectable, Logger } from '@nestjs/common';

import {
  chargeResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  PAYMENT_SCENARIO_HEADER,
  type ChargeResponse,
} from '@cinema/contracts';

import { ConfigService } from '../config/config.service';
import { CircuitBreaker, type BreakerState } from '../resilience/circuit-breaker';

/**
 * The downstream could not answer. Distinct from a decline, which is an answer.
 * Everything that reaches the breaker's failure count arrives as one of these.
 */
export class ProviderUnavailableError extends Error {
  constructor(reason: string) {
    super(`payment provider unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}

export interface ChargeCommand {
  /** Doubles as the Idempotency-Key. Stable across every attempt (ADR 0035). */
  paymentId: string;
  reservationId: string;
  amountCents: number;
  scenario: string | null;
}

@Injectable()
export class PaymentProviderClient {
  private readonly logger = new Logger(PaymentProviderClient.name);
  private readonly breaker: CircuitBreaker;

  constructor(private readonly configService: ConfigService) {
    const { paymentBreakerFailureThreshold, paymentBreakerOpenMs } = configService.config;
    this.breaker = new CircuitBreaker({
      failureThreshold: paymentBreakerFailureThreshold,
      openMs: paymentBreakerOpenMs,
    });
  }

  get breakerState(): BreakerState {
    return this.breaker.state;
  }

  /** Calls refused by the open breaker since boot. Section 22 scrapes this. */
  get breakerRejections(): number {
    return this.breaker.rejected;
  }

  /**
   * Resolves with SUCCEEDED or DECLINED; throws ProviderUnavailableError for
   * anything that is not an answer, and CircuitOpenError when the breaker is
   * open. The distinction is load-bearing: only a throw counts as a failure, so
   * a run of declines can never open the circuit (ADR 0038).
   */
  async charge(command: ChargeCommand): Promise<ChargeResponse> {
    return this.breaker.execute(() => this.call(command));
  }

  private async call(command: ChargeCommand): Promise<ChargeResponse> {
    const { paymentProviderUrl, paymentTimeoutMs } = this.configService.config;
    if (!paymentProviderUrl) throw new ProviderUnavailableError('no provider url configured');

    let response: Response;
    try {
      response = await fetch(`${paymentProviderUrl}/charge`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [IDEMPOTENCY_KEY_HEADER]: command.paymentId,
          ...(command.scenario ? { [PAYMENT_SCENARIO_HEADER]: command.scenario } : {}),
        },
        body: JSON.stringify({
          amountCents: command.amountCents,
          reference: command.reservationId,
        }),
        // AbortSignal.timeout rather than a hand-rolled race: it aborts the
        // socket instead of leaving it open behind a resolved promise.
        signal: AbortSignal.timeout(paymentTimeoutMs),
      });
    } catch (error) {
      // Timeout, DNS failure, connection refused -- all the same to us, and all
      // worth retrying.
      throw new ProviderUnavailableError(String(error));
    }

    if (response.status >= 500) {
      throw new ProviderUnavailableError(`status ${String(response.status)}`);
    }
    if (!response.ok) {
      // A 4xx is our fault and will not improve on retry, but the caller is a
      // message handler, and the ladder plus the DLQ is where a permanently
      // broken request belongs -- so it is still a throw, just a louder one.
      this.logger.error(`provider rejected the charge with ${String(response.status)}`);
      throw new ProviderUnavailableError(`status ${String(response.status)}`);
    }

    const parsed = chargeResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      // A 200 we cannot read is not an answer. Treating it as one would mean
      // guessing whether money moved.
      throw new ProviderUnavailableError('unparseable response body');
    }

    if (response.headers.get(IDEMPOTENT_REPLAY_HEADER) === 'true') {
      this.logger.log(`payment ${command.paymentId}: provider replayed a stored answer`);
    }
    return parsed.data;
  }
}
