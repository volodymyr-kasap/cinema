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
  PAYMENT_DEAD_KEY,
  PAYMENT_LADDER,
  PAYMENT_QUEUE,
  paymentMessageSchema,
} from '../messaging/messages';
import { RABBIT, type RabbitConnection } from '../messaging/rabbit.module';
import { attemptOf, nextHop } from '../messaging/retry';
import { assertTopology } from '../messaging/topology';
import { PaymentService } from '../payments/payment.service';
import type { PaymentSettlement } from '../reservations/reservation.service';

/** How many extra local attempts `settleWithGrace` makes beyond the first. */
const PAYMENT_GRACE_ATTEMPTS = 9;
/** Spacing between those attempts. 9 * 20ms = 180ms, well over the ~2ms race measured. */
const PAYMENT_GRACE_DELAY_MS = 20;

/**
 * Thrown by `settleWithGrace` when the grace window runs out and the payment
 * row is still not visible. Its own type (and its own message) rather than a
 * generic Error, so the tier-1 log line reads as "the row was not there yet"
 * rather than as an indistinguishable provider failure.
 */
class PaymentRowNotVisibleError extends Error {
  constructor(paymentId: string, graceMs: number) {
    super(
      `payment ${paymentId} row not visible after ${String(graceMs)}ms of grace; ` +
        'retrying via the ladder rather than assuming the transaction rolled back',
    );
    this.name = 'PaymentRowNotVisibleError';
  }
}

/**
 * The expiry consumer's twin, on its own channel with its own prefetch, in the
 * same process (ADR 0028). Waiting on the provider is asynchronous, so one
 * event loop serves both queues without either starving the other.
 */
@Injectable()
export class PaymentConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentConsumer.name);
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private inFlight = 0;
  private handled = 0;

  constructor(
    @Inject(RABBIT) private readonly connection: RabbitConnection,
    private readonly payments: PaymentService,
    private readonly configService: ConfigService,
  ) {}

  /** Messages taken to a conclusion since boot, whatever that conclusion was. */
  get handledCount(): number {
    return this.handled;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.connection) return;
    if (this.configService.config.paymentMode !== 'queue') return;
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
      await assertTopology(channel, {
        reservationTtlSeconds,
        retryDelaysMs: rabbitmqRetryDelaysMs,
      });
      await channel.prefetch(rabbitmqPrefetch);
      channel.on('error', (error: Error) => this.logger.warn(`payment channel: ${error.message}`));

      const reply = await channel.consume(PAYMENT_QUEUE, (message) => {
        if (message) void this.handle(channel, message);
      });

      this.channel = channel;
      this.consumerTag = reply.consumerTag;
      this.logger.log(`consuming ${PAYMENT_QUEUE} with prefetch ${String(rabbitmqPrefetch)}`);
    } catch (error) {
      this.logger.warn(`could not subscribe to ${PAYMENT_QUEUE}: ${String(error)}`);
    }
  }

  /** Stops new deliveries without closing the channel. Used by tests. */
  async unsubscribe(): Promise<void> {
    if (this.channel && this.consumerTag) {
      await this.channel.cancel(this.consumerTag).catch(() => {});
      this.consumerTag = null;
    }
  }

  private async handle(channel: Channel, message: ConsumeMessage): Promise<void> {
    this.inFlight += 1;
    try {
      const paymentId = this.parse(message);
      if (!paymentId) {
        this.forward(channel, message, PAYMENT_DEAD_KEY, attemptOf(message.properties.headers));
        channel.ack(message);
        return;
      }

      try {
        const outcome = await this.settleWithGrace(paymentId);
        this.logger.log(`payment.requested ${paymentId}: ${outcome}`);
        channel.ack(message);
      } catch (error) {
        const attempt = attemptOf(message.properties.headers);
        const hop = nextHop(
          attempt,
          this.configService.config.rabbitmqRetryDelaysMs,
          PAYMENT_LADDER,
        );

        if (hop.dead) {
          // The seats come back now, not when someone reads the DLQ. The
          // message still goes there, because a human needs to know a charge
          // was given up on.
          this.logger.error(
            `payment ${paymentId} failed ${String(hop.attempt)} times, giving up: ${String(error)}`,
          );
          await this.payments
            .abandon(paymentId, String(error))
            .catch((failure: unknown) =>
              this.logger.error(`could not abandon payment ${paymentId}: ${String(failure)}`),
            );
        } else {
          this.logger.warn(
            `payment ${paymentId} failed, retrying as attempt ${String(hop.attempt)}: ${String(error)}`,
          );
        }

        // Publish first, ack second — the same rule as the expiry consumer. The
        // reverse order loses the message if the process dies between the two;
        // this order can deliver it twice instead, and a duplicate is absorbed
        // by claimPayment's terminal check. Losing is worse than repeating.
        this.forward(channel, message, hop.routingKey, hop.attempt);
        channel.ack(message);
      }
    } finally {
      this.handled += 1;
      this.inFlight -= 1;
    }
  }

  /**
   * `payment.requested` is published INSIDE the reservation's transaction,
   * before commit (ADR 0037) — deliberately, so a lost message cannot strand a
   * hold. That ordering opens a narrow window the other way: on a broker and
   * database both local and both fast, this consumer can be handed the
   * delivery and run `claimPayment`'s first SELECT before the producer's own
   * COMMIT lands, which looks identical to a payment whose transaction really
   * did roll back — `claimPayment` cannot tell the two apart from the row
   * alone. Measured directly (not assumed): claimPayment reporting `not-found`
   * about 2ms before the producing transaction committed, on a co-located
   * broker and database, i.e. close to the deployment topology this worker
   * actually runs in (ADR 0028).
   *
   * A short local wait buys the common case (a fast commit) its answer
   * without ever touching the ladder. But under real load a commit can
   * legitimately take longer than any local budget this consumer could
   * justify holding a channel open for -- and a booking system that silently
   * drops a payment because the database was briefly busy is worse than one
   * that retries it. So once the grace window is spent, "not-found" is no
   * longer treated as the answer: it is thrown, and the caller's normal
   * failure handling climbs the ladder exactly as it would for a provider
   * error. Three outcomes result, all correct:
   *
   *   - race, fast commit  -> resolved inside the grace window, no ladder.
   *   - race, slow commit  -> one hop to tier 1, ~5s later the row is surely
   *                           there, and it settles normally.
   *   - genuine rollback   -> the row is never going to appear, so every hop
   *                           on the ladder repeats "not-found" until it
   *                           dead-letters. That trades a stranded hold for a
   *                           DLQ entry a human can see, which is the
   *                           opposite of silent. It is also the rare side of
   *                           this trade: publishPayment is the last
   *                           statement before Task 6's transaction returns,
   *                           so a rollback arriving after it (rather than a
   *                           timeout or a broker error before it, both
   *                           already handled elsewhere) is close to
   *                           unreachable in practice.
   *
   * The real fix is a transactional outbox, which is exactly the seam
   * PaymentPublisher's own comment already names for later.
   */
  private async settleWithGrace(paymentId: string): Promise<PaymentSettlement> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.payments.settle(paymentId);
      if (outcome !== 'not-found') return outcome;
      if (attempt >= PAYMENT_GRACE_ATTEMPTS) {
        throw new PaymentRowNotVisibleError(
          paymentId,
          PAYMENT_GRACE_ATTEMPTS * PAYMENT_GRACE_DELAY_MS,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, PAYMENT_GRACE_DELAY_MS));
    }
  }

  private parse(message: ConsumeMessage): string | null {
    try {
      const body: unknown = JSON.parse(message.content.toString('utf8'));
      return paymentMessageSchema.parse(body).paymentId;
    } catch (error) {
      this.logger.error(`unparseable payment.requested message: ${String(error)}`);
      return null;
    }
  }

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

    await this.unsubscribe();
    while (this.inFlight > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await channel.close().catch(() => {});
  }
}
