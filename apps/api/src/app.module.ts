import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { CatalogModule } from './catalog/catalog.module';
import { ConfigModule } from './config/config.module';
import { DrizzleModule } from './db/drizzle.module';
import { HealthModule } from './health/health.module';
import { LockingModule } from './locking/locking.module';
import { MessagingModule } from './messaging/messaging.module';
import { OpenApiModule } from './openapi/openapi.module';
import { ReservationModule } from './reservations/reservation.module';
import { ProblemDetailsFilter } from './http/problem-details.filter';
import { ResponseValidationInterceptor } from './http/response-validation.interceptor';

@Module({
  imports: [
    CatalogModule,
    ConfigModule,
    DrizzleModule,
    HealthModule,
    LockingModule,
    MessagingModule,
    OpenApiModule,
    ReservationModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseValidationInterceptor },
  ],
})
export class AppModule {}
