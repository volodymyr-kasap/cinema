import 'reflect-metadata';

import { VersioningType } from '@nestjs/common';
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

  // Health and readiness stay unversioned — orchestrators probe a fixed path.
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  const { config } = app.get(ConfigService);
  app.enableCors({ origin: true });
  app.enableShutdownHooks();

  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port }, 'api listening');
}

void bootstrap();
