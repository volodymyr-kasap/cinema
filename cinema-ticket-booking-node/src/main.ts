import { connectRedis } from './adapters/redis.js';
import type { BookingStore } from './booking/domain.js';
import { MemoryBookingStore } from './booking/memory-store.js';
import { RedisBookingStore } from './booking/redis-store.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

const store: BookingStore =
  config.store === 'memory'
    ? new MemoryBookingStore(config.holdTtlMs)
    : new RedisBookingStore(await connectRedis(config.redisUrl), config.holdTtlMs);

const app = await buildApp(store, { logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app
      .close()
      .then(() => store.close())
      .then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
