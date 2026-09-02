import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfirmChannel } from 'amqplib';

import { ConfigService } from '../config/config.service';
import { currentRequestId } from '../observability/request-context';
import { ATTEMPT_HEADER, COMMANDS_EXCHANGE, EXPIRE_WAIT_KEY } from './messages';
import { RABBIT, type RabbitConnection } from './rabbit.module';

@Injectable()
export class ExpirePublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExpirePublisher.name);
  private channel: ConfirmChannel | null = null;
  /**
   * Failed publications since boot. Section 22 will scrape this; today it is
   * what the degradation test asserts on and what a log line quotes, so a reader
   * can tell one bad second from a broker that has been down all afternoon.
   */
  private failures = 0;

  constructor(
    @Inject(RABBIT) private readonly connection: RabbitConnection,
    private readonly configService: ConfigService,
  ) {}

  get failureCount(): number {
    return this.failures;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.connection) return;
    // A channel does not survive its connection, so it is reopened on every
    // successful (re)connection rather than held for the life of the process.
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
      // `mandatory` publishes come back here when nothing was bound to route
      // them. Silence would otherwise be the only symptom of a broken binding.
      channel.on('return', (message) =>
        this.warn(`message returned unroutable: ${String(message.properties.messageId)}`),
      );
      channel.on('error', (error: Error) => this.warn(`publish channel error: ${error.message}`));
      this.channel = channel;
    } catch (error) {
      this.warn(`could not open a publish channel: ${String(error)}`);
    }
  }

  /**
   * Called at the very end of a successful hold, after the commit and after the
   * seat locks settle. Never throws: the seats are already held and the row is
   * already committed, so a broker problem must cost a warning and nothing else.
   * Lazy expiry (ADR 0011) is what makes that affordable -- it, not this
   * message, is what guarantees the seat comes back.
   */
  async publishExpire(reservationId: string): Promise<void> {
    // Lazy mode never opens a connection, so a null channel is the subsystem
    // behaving exactly as configured, not a failure -- it must stay silent, the
    // same way RabbitModule's factory stays silent in lazy mode (ADR 0017).
    // Only in queue mode does a missing channel mean an actual broker problem,
    // and that is precisely what the fail-open counter exists to surface.
    if (this.configService.config.reservationExpiryMode !== 'queue') return;

    const channel = this.channel;
    if (!channel) {
      this.warn(`no publish channel available for reservation.expire ${reservationId}`);
      return;
    }

    const body = Buffer.from(JSON.stringify({ reservationId }), 'utf8');
    const options = {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId: reservationId,
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

        channel.publish(COMMANDS_EXCHANGE, EXPIRE_WAIT_KEY, body, options, (error) => {
          clearTimeout(timer);
          if (error) reject(error instanceof Error ? error : new Error(String(error)));
          else resolve();
        });
      });
    } catch (error) {
      this.warn(`publishing reservation.expire for ${reservationId} failed: ${String(error)}`);
    }
  }

  private warn(message: string): void {
    this.failures += 1;
    this.logger.warn(`${message} (${String(this.failures)} since boot); lazy expiry still applies`);
  }
}
