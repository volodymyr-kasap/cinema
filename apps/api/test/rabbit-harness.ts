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
 * The `cancel` calls below are best-effort and deliberately not awaited: the
 * caller's `afterEach` typically closes the channel immediately after this
 * promise settles, and if that close wins the race against `cancel`'s reply,
 * amqplib rejects the still-pending cancel with "Channel ended, no reply will
 * be forthcoming". A fire-and-forget cleanup call is not something the caller
 * asked to be told about, so its rejection is swallowed here instead of
 * becoming an unhandled rejection attributed to whatever test runs next.
 */
export async function takeOne(
  channel: Channel,
  queue: string,
  timeoutMs: number,
): Promise<ConsumeMessage> {
  return new Promise<ConsumeMessage>((resolve, reject) => {
    let tag: string | undefined;

    const timer = setTimeout(() => {
      if (tag) void channel.cancel(tag).catch(() => {});
      reject(new Error(`no message arrived on ${queue} within ${String(timeoutMs)}ms`));
    }, timeoutMs);

    void channel
      .consume(
        queue,
        (message) => {
          if (!message) return;
          clearTimeout(timer);
          channel.ack(message);
          if (tag) void channel.cancel(tag).catch(() => {});
          resolve(message);
        },
        { noAck: false },
      )
      .then((reply) => {
        tag = reply.consumerTag;
      })
      .catch(reject);
  });
}
