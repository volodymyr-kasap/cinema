import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfirmChannel } from 'amqplib';

import { ConfigService } from '../config/config.service';
import { PaymentUnavailableError } from '../http/errors';
import { currentRequestId } from '../observability/request-context';
import { ATTEMPT_HEADER, COMMANDS_EXCHANGE, PAYMENT_KEY } from './messages';
import { RABBIT, type RabbitConnection } from './rabbit.module';

/**
 * The sibling of ExpirePublisher, with the opposite failure policy — and the
 * asymmetry is the design, not an oversight.
 *
 * `publishExpire` runs after the commit and swallows everything, because lazy
 * expiry returns the seat whether or not the message ever arrives. This message
 * has no such backstop: a lost `payment.requested` leaves a reservation in
 * PAYMENT_PENDING with no process anywhere that knows about it. So this one is
 * published INSIDE the reservation's transaction and throws, which aborts it.
 *
 * That ordering is safe in exactly one direction, and that inequality is the
 * whole argument (ADR 0037):
 *
 *   published, then rolled back  -> the message names a payments row that does
 *                                   not exist; the consumer's first rule drops
 *                                   it. Cost: one wasted message.
 *   committed, then publish lost -> a hold nobody will ever settle. Cost: seats.
 *
 * The price is a broker round trip (bounded by RABBITMQ_PUBLISH_TIMEOUT_MS)
 * held under one row lock. One row, not a range, and bounded above — which is
 * also precisely the seam a transactional outbox replaces later.
 */
@Injectable()
export class PaymentPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentPublisher.name);
  private channel: ConfirmChannel | null = null;

  constructor(
    @Inject(RABBIT) private readonly connection: RabbitConnection,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.connection) return;
    this.connection.on('connect', () => void this.open());
    await this.open();
  }

  async onApplicationShutdown(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    if (channel) await channel.close().catch(() => {});
  }

  private async open(): Promise<void> {
    if (!this.connection) return;
    try {
      const channel = await this.connection.createConfirmChannel();
      channel.on('return', (message) =>
        this.logger.error(
          `payment message returned unroutable: ${String(message.properties.messageId)}`,
        ),
      );
      channel.on('error', (error: Error) =>
        this.logger.warn(`payment publish channel error: ${error.message}`),
      );
      this.channel = channel;
    } catch (error) {
      this.logger.warn(`could not open a payment publish channel: ${String(error)}`);
    }
  }

  /**
   * Called inside the reservation's transaction. Throws rather than warning:
   * the caller's rollback is what keeps the hold consistent.
   */
  async publishPayment(paymentId: string): Promise<void> {
    const channel = this.channel;
    if (!channel) throw new PaymentUnavailableError(paymentId);

    const body = Buffer.from(JSON.stringify({ paymentId }), 'utf8');
    const options = {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId: paymentId,
      correlationId: currentRequestId(),
      timestamp: Date.now(),
      headers: { [ATTEMPT_HEADER]: 0 },
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('publish confirmation timed out')),
          this.configService.config.rabbitmqPublishTimeoutMs,
        );

        channel.publish(COMMANDS_EXCHANGE, PAYMENT_KEY, body, options, (error) => {
          clearTimeout(timer);
          if (error) reject(error instanceof Error ? error : new Error(String(error)));
          else resolve();
        });
      });
    } catch (error) {
      this.logger.error(`publishing payment.requested for ${paymentId} failed: ${String(error)}`);
      throw new PaymentUnavailableError(paymentId);
    }
  }
}
