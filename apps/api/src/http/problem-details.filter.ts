import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { ProblemDetails } from '@cinema/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ConfigService } from '../config/config.service';
import { currentRequestId } from '../observability/request-context';
import { DomainError } from './errors';

const PROBLEM_JSON = 'application/problem+json';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly configService: ConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();

    const problem = this.toProblem(exception, request.url);

    if (problem.status >= 500) {
      this.logger.error(`${problem.status} ${request.method} ${request.url}`, String(exception));
    }

    void reply.status(problem.status).type(PROBLEM_JSON).send(problem);
  }

  private toProblem(exception: unknown, instance: string): ProblemDetails {
    const base = this.configService.config.publicErrorBaseUrl;
    const traceId = currentRequestId();

    if (exception instanceof DomainError) {
      return {
        type: `${base}/${exception.typeSlug}`,
        title: exception.title,
        status: exception.status,
        detail: exception.message,
        instance,
        traceId,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: `${base}/http-${status}`,
        title: exception.name,
        status,
        detail: exception.message,
        instance,
        traceId,
      };
    }

    // Nothing about an unexpected failure is safe to hand to the client.
    return {
      type: `${base}/internal`,
      title: 'Internal server error',
      status: 500,
      detail: 'The request could not be processed',
      instance,
      traceId,
    };
  }
}
