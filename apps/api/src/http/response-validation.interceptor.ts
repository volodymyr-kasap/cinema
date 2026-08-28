import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { z } from 'zod';

import { ConfigService } from '../config/config.service';
import { RESPONSE_SCHEMA } from './validated.decorator';

/**
 * Parses every response against the schema the handler declared — but only
 * outside production. It catches "the schema says one thing, the repository
 * returns another" at the moment it appears, without burning CPU in prod.
 */
@Injectable()
export class ResponseValidationInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.configService.config.nodeEnv === 'production') return next.handle();

    const schema = this.reflector.get<z.ZodType | undefined>(RESPONSE_SCHEMA, context.getHandler());
    if (!schema) return next.handle();

    return next.handle().pipe(
      map((value) => {
        const result = schema.safeParse(value);
        if (!result.success) {
          throw new Error(
            `Response does not match its declared contract:\n${z.prettifyError(result.error)}`,
          );
        }
        return result.data;
      }),
    );
  }
}
