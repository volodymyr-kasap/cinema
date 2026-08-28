import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { parseEnv } from './config/env';
import { ConfigService } from './config/config.service';
import {
  PinoLoggerService,
  createLogger,
  generateRequestId,
  registerCorrelation,
} from './observability/logger';

async function bootstrap(): Promise<void> {
  // Parsed twice on purpose: the logger must exist before the DI container does.
  const logger = createLogger(parseEnv(process.env));

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ loggerInstance: logger, genReqId: generateRequestId }),
    { bufferLogs: true },
  );

  app.useLogger(new PinoLoggerService(logger));
  registerCorrelation(app);

  const { config } = app.get(ConfigService);
  app.enableCors({ origin: true });
  app.enableShutdownHooks();

  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port }, 'api listening');
}

void bootstrap();
