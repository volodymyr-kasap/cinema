import { randomUUID } from 'node:crypto';

import type { LoggerService } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import pino, { type Logger } from 'pino';

import type { AppConfig } from '../config/env';
import { currentRequestId, requestContext } from './request-context';

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.logLevel,
    ...(config.nodeEnv === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

/** Generates the correlation id, honouring an upstream `x-request-id`. */
export function generateRequestId(request: { headers: Record<string, unknown> }): string {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 && header.length <= 200
    ? header
    : randomUUID();
}

/**
 * Opens the correlation scope for the whole request and echoes the id back, so a
 * user can quote it from a screenshot and the whole lifecycle can be found by it.
 */
export function registerCorrelation(app: NestFastifyApplication): void {
  const instance = app.getHttpAdapter().getInstance();

  instance.addHook('onRequest', (request: FastifyRequest, reply, done) => {
    void reply.header('x-request-id', request.id);
    requestContext.run({ requestId: String(request.id) }, done);
  });
}

/** Bridges Nest's logger onto the same pino instance, stamping every line with the request id. */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace',
    message: unknown,
    context?: unknown,
  ): void {
    this.logger[level]({ requestId: currentRequestId(), context }, String(message));
  }

  log(message: unknown, context?: unknown): void {
    this.write('info', message, context);
  }

  error(message: unknown, trace?: unknown, context?: unknown): void {
    this.logger.error({ requestId: currentRequestId(), context, trace }, String(message));
  }

  warn(message: unknown, context?: unknown): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: unknown): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: unknown): void {
    this.write('trace', message, context);
  }
}
