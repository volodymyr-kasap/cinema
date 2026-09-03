import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { parseEnv } from '../config/env';
import { PinoLoggerService, createLogger } from '../observability/logger';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const config = parseEnv(process.env);
  const logger = createLogger(config);

  // The process now serves two queues, so it exits only when BOTH are off.
  // Exiting because expiry is lazy would take the payment worker down with it.
  if (config.reservationExpiryMode !== 'queue' && config.paymentMode !== 'queue') {
    logger.info(
      'both RESERVATION_EXPIRY_MODE and PAYMENT_MODE are off; the worker has nothing to do',
    );
    return;
  }

  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(new PinoLoggerService(logger));
  app.enableShutdownHooks();

  logger.info(
    {
      prefetch: config.rabbitmqPrefetch,
      expiry: config.reservationExpiryMode,
      payment: config.paymentMode,
    },
    'worker started',
  );
}

void bootstrap();
