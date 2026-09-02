import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';

import { ConfigService } from '../config/config.service';
import {
  ATTEMPT_HEADER,
  COMMANDS_EXCHANGE,
  EXPIRE_DEAD_KEY,
  EXPIRE_QUEUE,
  expireMessageSchema,
} from '../messaging/messages';
import { RABBIT, type RabbitConnection } from '../messaging/rabbit.module';
import { attemptOf, nextHop } from '../messaging/retry';
import { assertTopology } from '../messaging/topology';
import { ReservationService } from '../reservations/reservation.service';

@Injectable()
export class ExpireConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExpireConsumer.name);
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private inFlight = 0;
  private handled = 0;

  constructor(
    @Inject(RABBIT) private readonly connection: RabbitConnection,
    private readonly reservations: ReservationService,
    private readonly configService: ConfigService,
  ) {}

  /** Messages taken to a conclusion since boot, whatever that conclusion was. */
  get handledCount(): number {
    return this.handled;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.connection) return;
    // A channel dies with its connection, so the subscription is re-established
    // on every successful reconnection, not held for the life of the process.
    this.connection.on('connect', () => void this.subscribe());
    await this.subscribe();
  }

  async subscribe(): Promise<void> {
    if (!this.connection) return;

    const previous = this.channel;
    this.channel = null;
    if (previous) await previous.close().catch(() => {});

    const { reservationTtlSeconds, rabbitmqRetryDelaysMs, rabbitmqPrefetch } =
      this.configService.config;

    try {
      const channel = await this.connection.createChannel();
      // Idempotent, and asserted here as well as in the connection's setup hook:
      // whichever runs first, both see identical arguments (spec §3).
      await assertTopology(channel, {
        reservationTtlSeconds,
        retryDelaysMs: rabbitmqRetryDelaysMs,
      });
      await channel.prefetch(rabbitmqPrefetch);
      channel.on('error', (error: Error) => this.logger.warn(`consumer channel: ${error.message}`));

      const reply = await channel.consume(EXPIRE_QUEUE, (message) => {
        if (message) void this.handle(channel, message);
      });

      this.channel = channel;
      this.consumerTag = reply.consumerTag;
      this.logger.log(`consuming ${EXPIRE_QUEUE} with prefetch ${String(rabbitmqPrefetch)}`);
    } catch (error) {
      // Recovery will fire 'connect' again and bring us back through here.
      this.logger.warn(`could not subscribe: ${String(error)}`);
    }
  }

  private async handle(channel: Channel, message: ConsumeMessage): Promise<void> {
    this.inFlight += 1;
    try {
      const parsed = this.parse(message);
      if (!parsed) {
        // A body that does not parse will not parse in thirty seconds either, so
        // retrying it only delays the diagnosis. Straight to the DLQ, with its
        // original bytes and headers intact for whoever reads it (spec §5).
        this.forward(channel, message, EXPIRE_DEAD_KEY, attemptOf(message.properties.headers));
        channel.ack(message);
        return;
      }

      try {
        const outcome = await this.reservations.settleExpired(parsed);
        this.logger.log(`reservation.expire ${parsed}: ${outcome}`);
        channel.ack(message);
      } catch (error) {
        const attempt = attemptOf(message.properties.headers);
        const hop = nextHop(attempt, this.configService.config.rabbitmqRetryDelaysMs);

        this.logger.warn(
          hop.dead
            ? `reservation.expire ${parsed} failed ${String(hop.attempt)} times, dead-lettering: ${String(error)}`
            : `reservation.expire ${parsed} failed, retrying as attempt ${String(hop.attempt)}: ${String(error)}`,
        );

        // Publish first, ack second. The reverse order loses the message if the
        // process dies between the two; this order can deliver it twice
        // instead, and a duplicate is absorbed by settleExpired's terminal
        // check. Losing is worse than repeating (spec §5).
        this.forward(channel, message, hop.routingKey, hop.attempt);
        channel.ack(message);
      }
    } finally {
      this.handled += 1;
      this.inFlight -= 1;
    }
  }

  private parse(message: ConsumeMessage): string | null {
    try {
      const body: unknown = JSON.parse(message.content.toString('utf8'));
      return expireMessageSchema.parse(body).reservationId;
    } catch (error) {
      this.logger.error(`unparseable reservation.expire message: ${String(error)}`);
      return null;
    }
  }

  /** Republishes the original bytes, carrying `x-death` forward for forensics. */
  private forward(
    channel: Channel,
    message: ConsumeMessage,
    routingKey: string,
    attempt: number,
  ): void {
    channel.publish(COMMANDS_EXCHANGE, routingKey, message.content, {
      persistent: true,
      contentType: message.properties.contentType ?? 'application/json',
      messageId: message.properties.messageId,
      correlationId: message.properties.correlationId,
      headers: { ...message.properties.headers, [ATTEMPT_HEADER]: attempt },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    this.channel = null;

    // Cancelling stops new deliveries; it does not wait for the ones already
    // running. Closing the channel under a running handler would leave its
    // message unacked, which is safe -- the broker redelivers it -- but noisy.
    if (this.consumerTag) await channel.cancel(this.consumerTag).catch(() => {});
    while (this.inFlight > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await channel.close().catch(() => {});
  }
}
