import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { connect, type ChannelModel, type RecoveringChannelModel } from 'amqplib';

import { ConfigService } from '../config/config.service';
import { assertTopology, type TopologyOptions } from './topology';

export const RABBIT = Symbol('RABBIT');

/** `null` whenever RESERVATION_EXPIRY_MODE is `lazy`. Every consumer checks. */
export type RabbitConnection = RecoveringChannelModel | null;

/**
 * Recovery is a library feature as of amqplib 1.1.0, which is why this project
 * does not carry `amqp-connection-manager`. The `setup` hook runs after every
 * successful connection, including the first, and is the one place topology is
 * asserted -- with identical options each time, because different arguments
 * would be PRECONDITION_FAILED (ADR 0031).
 */
export async function createRabbitConnection(
  url: string,
  options: TopologyOptions,
  onEvent: (message: string) => void,
): Promise<RecoveringChannelModel> {
  // A plain connect first, purely as a reachability probe.
  //
  // This is not belt-and-braces. Verified against amqplib 2.0.1: `connect()`
  // WITH a recovery block never rejects on an unreachable broker -- it retries
  // for as long as `maxRetries` allows, and that defaults to Infinity, so
  // awaiting it would hang boot forever against a dead broker. Without recovery
  // it rejects in about two milliseconds. `maxRetries` does bound the initial
  // attempt (0 rejects at 2ms, 2 at 154ms), but any budget small enough to keep
  // boot fast is far too small to survive a real broker restart at runtime, and
  // one option set governs both. So: probe without recovery to decide whether
  // the broker is there, then open the connection that actually gets used with
  // an unbounded recovery budget.
  const probe = await connect(url);
  // close() is not instantaneous -- it sends ConnectionClose and awaits
  // ConnectionCloseOk from the broker, a real network round trip. If the
  // socket errors during that window, amqplib emits 'error' on this object,
  // and an EventEmitter 'error' with no listener aborts the process. A probe
  // failure is exactly the kind of broker flakiness this module exists to
  // survive, so it gets the same listener the real connection gets below.
  probe.on('error', (error: Error) => onEvent(`probe error: ${error.message}`));

  // The probe asserts the topology too, rather than only proving the socket
  // opens. A reachable broker holding INCOMPATIBLE queues -- the config-drift
  // case ADR 0024 warns about, such as a redeploy with a changed
  // RESERVATION_TTL_SECONDS against queues that already exist -- fails `setup`
  // with a 406. Recovery catches that, emits connect-failed and reschedules for
  // ever, so the `connect` below would neither resolve nor reject and boot
  // would hang for good: the same failure the probe exists to prevent, reached
  // by a different route. Asserting here turns it into a rejection, which the
  // caller fails open on exactly as it does for a broker that is not there.
  try {
    const channel = await probe.createChannel();
    // A 406 closes the channel from the broker's side and emits 'error' here;
    // unlistened, that aborts the process before the rejection can be handled.
    channel.on('error', (error: Error) => onEvent(`probe channel error: ${error.message}`));
    await assertTopology(channel, options);
    await channel.close();
  } finally {
    await probe.close().catch(() => {});
  }

  const connection = await connect(url, {
    // `heartbeat` is deliberately not passed. In amqplib 2.0.0 a zero disables
    // heartbeats outright rather than deferring to the server, so the way to
    // take the server's value is to omit the option.
    recovery: {
      initialDelay: 100,
      maxDelay: 5_000,
      factor: 2,
      jitter: 0.2,
      setup: async (model: ChannelModel) => {
        const channel = await model.createChannel();
        await assertTopology(channel, options);
        await channel.close();
      },
    },
  });

  connection.on('disconnect', (error: Error) => onEvent(`broker disconnected: ${error.message}`));
  connection.on('reconnect-scheduled', (info: { attempt: number; delay: number }) =>
    onEvent(`reconnect attempt ${String(info.attempt)} in ${String(info.delay)}ms`),
  );
  connection.on('connect-failed', (error: Error) => onEvent(`reconnect failed: ${error.message}`));
  // An EventEmitter 'error' with no listener aborts the process -- the same trap
  // the pg pool and the ioredis client each have. A broker we can live without
  // must never take the process down.
  connection.on('error', (error: Error) => onEvent(`broker error: ${error.message}`));

  return connection;
}

@Global()
@Module({
  providers: [
    {
      provide: RABBIT,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService): Promise<RabbitConnection> => {
        const {
          reservationExpiryMode,
          paymentMode,
          rabbitmqUrl,
          reservationTtlSeconds,
          rabbitmqRetryDelaysMs,
        } = configService.config;
        // Opens for EITHER subsystem: the expiry consumer and the payment
        // consumer/publisher all inject this one connection and each checks its
        // own mode before using it (see ExpireConsumer, PaymentConsumer,
        // PaymentPublisher). Both `lazy`/`off` together open no connection at
        // all, declare no queue and log nothing. A client nobody uses would
        // still reconnect and still log, and would make phase 3's baseline run
        // differ from phase 3 (ADR 0017).
        if ((reservationExpiryMode !== 'queue' && paymentMode !== 'queue') || !rabbitmqUrl)
          return null;

        const logger = new Logger(RabbitModule.name);
        try {
          return await createRabbitConnection(
            rabbitmqUrl,
            { reservationTtlSeconds, retryDelaysMs: rabbitmqRetryDelaysMs },
            (message) => logger.warn(message),
          );
        } catch (error) {
          // No usable broker at boot -- unreachable, or reachable but holding a
          // topology we cannot assert -- must not stop the process: holds are
          // fully correct without it, and lazy expiry still settles them. Loud
          // rather than silent, because the alternative reading of this line is
          // a working system.
          logger.warn(`no usable broker at startup, running without it: ${String(error)}`);
          return null;
        }
      },
    },
  ],
  exports: [RABBIT],
})
export class RabbitModule implements OnApplicationShutdown {
  constructor(@Inject(RABBIT) private readonly connection: RabbitConnection) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.connection) return;
    // close() also stops the recovery loop; without it a shutting-down process
    // keeps trying to reconnect to a broker it no longer needs.
    await this.connection.close().catch(() => {});
  }
}
