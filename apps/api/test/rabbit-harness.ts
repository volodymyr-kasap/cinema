import { randomUUID } from 'node:crypto';

import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';

import {
  COMMANDS_EXCHANGE,
  EXPIRE_DLQ,
  EXPIRE_QUEUE,
  EXPIRE_WAIT_QUEUE,
  retryQueue,
} from '../src/messaging/messages';

/**
 * A plain connection and channel for asserting on what the application wrote.
 *
 * Both get a no-op `error` listener: amqplib's Channel and ChannelModel are
 * plain EventEmitters, and a channel-level protocol error (e.g. `checkQueue`
 * on a queue that does not exist) emits `error` in addition to rejecting the
 * pending call. An EventEmitter's `error` event throws when nothing is
 * listening, which would otherwise crash the test process asynchronously --
 * intermittently blamed on whichever test happened to be running when the
 * event fired, not the one that caused it. This is amqplib's own documented
 * recommendation, not a workaround specific to this harness.
 */
export async function openInspection(
  url: string,
): Promise<{ connection: ChannelModel; channel: Channel }> {
  const connection = await connect(url);
  connection.on('error', () => {});
  const channel = await connection.createChannel();
  channel.on('error', () => {});
  return { connection, channel };
}

/**
 * Queue arguments are part of a queue's identity: re-declaring one with a
 * different `x-message-ttl` is PRECONDITION_FAILED (406) and kills the channel.
 * Suites use different TTLs on purpose -- milliseconds where production uses
 * minutes -- so each one removes the previous suite's queues before declaring
 * its own. In production the same fact is a migration note, not a helper.
 */
export async function deleteTopology(connection: ChannelModel, tiers: number): Promise<void> {
  const queues = [EXPIRE_WAIT_QUEUE, EXPIRE_QUEUE, EXPIRE_DLQ];
  for (let tier = 1; tier <= tiers; tier += 1) queues.push(retryQueue(tier));

  // A disposable channel per deletion. Deleting a queue that is not there can
  // close the channel, and a closed channel would take every following
  // deletion down with it -- which would surface as an unrelated failure in
  // whichever suite happened to run first.
  for (const queue of queues) {
    const channel = await connection.createChannel();
    await channel.deleteQueue(queue).catch(() => {});
    await channel.close().catch(() => {});
  }

  const channel = await connection.createChannel();
  await channel.deleteExchange(COMMANDS_EXCHANGE).catch(() => {});
  await channel.close().catch(() => {});
}

/**
 * `checkQueue`, never `assertQueue`: the wait and retry queues carry an
 * `x-message-ttl` and a dead-letter exchange, so re-declaring them with plain
 * `{ durable: true }` would be PRECONDITION_FAILED (406) and would kill the
 * channel. A passive check reads the depth without touching the declaration.
 */
export async function queueDepth(channel: Channel, queue: string): Promise<number> {
  const { messageCount } = await channel.checkQueue(queue);
  return messageCount;
}

/**
 * Waits for one message on a queue and acks it. Rejects rather than hanging so
 * a failure names the queue that stayed empty instead of timing the suite out.
 *
 * The consumer is named here rather than read out of `consume`'s reply, because
 * the reply is not guaranteed to have been seen by the time the first message
 * is delivered: amqplib registers the consumer synchronously inside its RPC
 * callback, but resolves the promise a microtask later, so a `Deliver` frame
 * that arrives in the same socket read as `ConsumeOk` reaches the handler while
 * the tag variable is still unset. A consumer that cannot be named cannot be
 * cancelled, and one left subscribed to this shared inspection channel silently
 * swallows -- and acks -- the message the NEXT test publishes. Choosing the tag
 * up front makes the cancel unconditional.
 *
 * On the success path `resolve` waits for the cancel to be confirmed: a caller
 * that publishes again and calls `takeOne` again must not race a consumer that
 * is still registered, which would steal that next message. The timeout branch
 * stays fire-and-forget -- it is a failure path, and a caller whose `afterEach`
 * closes the channel right after may otherwise beat `cancel`'s reply, which
 * amqplib turns into "Channel ended, no reply will be forthcoming": a rejection
 * nobody asked to hear about, so it is swallowed there.
 */
export async function takeOne(
  channel: Channel,
  queue: string,
  timeoutMs: number,
): Promise<ConsumeMessage> {
  const tag = `take-one-${randomUUID()}`;

  return new Promise<ConsumeMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      void channel.cancel(tag).catch(() => {});
      reject(new Error(`no message arrived on ${queue} within ${String(timeoutMs)}ms`));
    }, timeoutMs);

    void channel
      .consume(
        queue,
        (message) => {
          if (!message) return;
          clearTimeout(timer);
          channel.ack(message);
          void channel
            .cancel(tag)
            .catch(() => {})
            .then(() => {
              resolve(message);
            });
        },
        { noAck: false, consumerTag: tag },
      )
      .catch(reject);
  });
}
