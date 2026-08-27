import { createHash } from 'node:crypto';
import { createClient } from 'redis';

export type RedisClient = ReturnType<typeof createClient>;

/** Connects and verifies the connection with a PING, mirroring the Go adapter. */
export async function connectRedis(url: string): Promise<RedisClient> {
  const client = createClient({ url });
  client.on('error', (err) => console.error('redis client error:', err));

  await client.connect();
  await client.ping();
  console.log(`connected to redis at ${url}`);

  return client;
}

/**
 * A Lua script that is shipped once and then invoked by SHA.
 *
 * Redis executes scripts atomically, which is what lets check-then-act
 * sequences (verify the session owner, then mutate) stay race-free.
 */
export class LuaScript<T> {
  private readonly sha: string;

  constructor(private readonly source: string) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  async run(client: RedisClient, keys: string[], args: string[]): Promise<T> {
    try {
      return (await client.evalSha(this.sha, { keys, arguments: args })) as T;
    } catch (err) {
      // The script is not in the server cache yet (or the server was flushed).
      if (err instanceof Error && err.message.includes('NOSCRIPT')) {
        return (await client.eval(this.source, { keys, arguments: args })) as T;
      }
      throw err;
    }
  }
}
