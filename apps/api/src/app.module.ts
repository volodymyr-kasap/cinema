import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { ProblemDetailsFilter } from './http/problem-details.filter';
import { ResponseValidationInterceptor } from './http/response-validation.interceptor';

@Module({
  imports: [ConfigModule, HealthModule],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseValidationInterceptor },
  ],
})
export class AppModule {}
