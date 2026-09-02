import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { parseEnv } from '../config/env';
import { PinoLoggerService, createLogger } from '../observability/logger';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const config = parseEnv(process.env);
  const logger = createLogger(config);

  if (config.reservationExpiryMode !== 'queue') {
    // Exits cleanly rather than idling. The compose service stays declared so
    // the mode is one environment variable rather than an edit to the stack,
    // but a worker with nothing to consume should not hold a database pool
    // open or make an idle process look like a working one (spec §5).
    logger.info('RESERVATION_EXPIRY_MODE is lazy; the expiry worker has nothing to do');
    return;
  }

  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(new PinoLoggerService(logger));
  app.enableShutdownHooks();

  logger.info({ prefetch: config.rabbitmqPrefetch }, 'expiry worker started');
}

void bootstrap();
