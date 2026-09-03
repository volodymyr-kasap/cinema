import { Injectable, Logger } from '@nestjs/common';

import { ReservationService, type PaymentSettlement } from '../reservations/reservation.service';
import type { BreakerState } from '../resilience/circuit-breaker';
import { PaymentProviderClient } from './payment-provider.client';

/**
 * The worker's orchestrator: claim an attempt, ask the provider, record what it
 * said. It calls ReservationService and ReservationService never calls back —
 * the reservation lifecycle and seat release stay where they already live, so
 * the dependency runs one way and no forwardRef is needed anywhere.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly reservations: ReservationService,
    private readonly provider: PaymentProviderClient,
  ) {}

  /** For the consumer's log line and, later, for Prometheus. */
  get breakerState(): BreakerState {
    return this.provider.breakerState;
  }

  /**
   * Resolves with what happened. Throws only when the provider could not
   * answer — which is the consumer's signal to climb the retry ladder, and the
   * reason a decline (an answer) is a resolution rather than a throw.
   */
  async settle(paymentId: string): Promise<PaymentSettlement> {
    const claim = await this.reservations.claimPayment(paymentId);
    if (claim.kind !== 'charge') return claim.kind;

    // Throws ProviderUnavailableError or CircuitOpenError. Deliberately not
    // caught here: nothing is written, the payment stays PENDING, and the
    // message goes back on the ladder with the attempt already counted.
    const response = await this.provider.charge({
      paymentId: claim.paymentId,
      reservationId: claim.reservationId,
      amountCents: claim.amountCents,
      scenario: claim.scenario,
    });

    if (response.status === 'SUCCEEDED') {
      return this.reservations.settlePayment(paymentId, {
        status: 'SUCCEEDED',
        providerRef: response.providerRef,
      });
    }

    this.logger.log(`payment ${paymentId} declined: ${response.declineReason}`);
    return this.reservations.settlePayment(paymentId, {
      status: 'DECLINED',
      reason: response.declineReason,
    });
  }

  /**
   * The end of the ladder. Marks the payment FAILED — ours, not the provider's
   * opinion — and gives the seats back at once rather than holding them until
   * somebody reads the dead-letter queue.
   */
  async abandon(paymentId: string, reason: string): Promise<PaymentSettlement> {
    this.logger.error(`payment ${paymentId} abandoned: ${reason}`);
    return this.reservations.settlePayment(paymentId, { status: 'FAILED', reason });
  }
}
