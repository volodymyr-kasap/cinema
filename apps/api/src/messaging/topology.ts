import type { Channel } from 'amqplib';

import {
  COMMANDS_EXCHANGE,
  EXPIRE_DEAD_KEY,
  EXPIRE_DLQ,
  EXPIRE_KEY,
  EXPIRE_QUEUE,
  EXPIRE_WAIT_KEY,
  EXPIRE_WAIT_QUEUE,
  PAYMENT_DEAD_KEY,
  PAYMENT_DLQ,
  PAYMENT_KEY,
  PAYMENT_QUEUE,
  paymentRetryKey,
  paymentRetryQueue,
  retryKey,
  retryQueue,
} from './messages';

export interface TopologyOptions {
  /** The length of a hold. The wait queue's TTL is the same number. */
  reservationTtlSeconds: number;
  /** One queue per entry, each with that fixed TTL. */
  retryDelaysMs: number[];
}

/**
 * The only place in the codebase that declares a queue.
 *
 * Re-asserting a queue with different arguments returns PRECONDITION_FAILED
 * (406) and kills the channel, so both the boot path and the reconnect hook
 * must call this and nothing else, with the same options. The practical
 * consequence, recorded in the spec and in ADR 0024: changing
 * RESERVATION_TTL_SECONDS or the retry ladder on a live stack requires deleting
 * and recreating the affected queues.
 */
export async function assertTopology(channel: Channel, options: TopologyOptions): Promise<void> {
  await channel.assertExchange(COMMANDS_EXCHANGE, 'direct', { durable: true });

  // Nothing ever consumes from this one. The broker moves a message on when its
  // TTL lapses, which is what makes the ten-minute delay a property of the
  // broker rather than a timer in our process -- and is why no scheduler exists
  // anywhere in this codebase (ADR 0011, ADR 0024).
  //
  // A queue expires only its head, so this is correct precisely because every
  // hold shares one TTL and publication order is therefore expiry order. If a
  // later sub-project gives holds different lengths, this queue must be
  // replaced rather than reconfigured.
  await channel.assertQueue(EXPIRE_WAIT_QUEUE, {
    durable: true,
    messageTtl: options.reservationTtlSeconds * 1_000,
    deadLetterExchange: COMMANDS_EXCHANGE,
    deadLetterRoutingKey: EXPIRE_KEY,
  });
  await channel.bindQueue(EXPIRE_WAIT_QUEUE, COMMANDS_EXCHANGE, EXPIRE_WAIT_KEY);

  await channel.assertQueue(EXPIRE_QUEUE, { durable: true });
  await channel.bindQueue(EXPIRE_QUEUE, COMMANDS_EXCHANGE, EXPIRE_KEY);

  // One queue per tier rather than per-message TTL in a single queue: the
  // head-of-line rule above would otherwise be violated by our own retries, with
  // a 5s message waiting behind a 120s one (ADR 0025).
  for (const [index, delay] of options.retryDelaysMs.entries()) {
    const tier = index + 1;
    await channel.assertQueue(retryQueue(tier), {
      durable: true,
      messageTtl: delay,
      deadLetterExchange: COMMANDS_EXCHANGE,
      deadLetterRoutingKey: EXPIRE_KEY,
    });
    await channel.bindQueue(retryQueue(tier), COMMANDS_EXCHANGE, retryKey(tier));
  }

  // Terminal: no TTL and no dead-letter exchange, so a message that reaches it
  // stays until a human looks at it.
  await channel.assertQueue(EXPIRE_DLQ, { durable: true });
  await channel.bindQueue(EXPIRE_DLQ, COMMANDS_EXCHANGE, EXPIRE_DEAD_KEY);

  // The payment side of the exchange. Same ladder shape, and deliberately NO
  // wait queue: expiry needed a delay before it acted, a charge does not.
  await channel.assertQueue(PAYMENT_QUEUE, { durable: true });
  await channel.bindQueue(PAYMENT_QUEUE, COMMANDS_EXCHANGE, PAYMENT_KEY);

  for (const [index, delay] of options.retryDelaysMs.entries()) {
    const tier = index + 1;
    await channel.assertQueue(paymentRetryQueue(tier), {
      durable: true,
      messageTtl: delay,
      deadLetterExchange: COMMANDS_EXCHANGE,
      deadLetterRoutingKey: PAYMENT_KEY,
    });
    await channel.bindQueue(paymentRetryQueue(tier), COMMANDS_EXCHANGE, paymentRetryKey(tier));
  }

  await channel.assertQueue(PAYMENT_DLQ, { durable: true });
  await channel.bindQueue(PAYMENT_DLQ, COMMANDS_EXCHANGE, PAYMENT_DEAD_KEY);
}
