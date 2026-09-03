import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { ConfigModule } from '../config/config.module';
import { DrizzleModule } from '../db/drizzle.module';
import { LockingModule } from '../locking/locking.module';
import { MessagingModule } from '../messaging/messaging.module';
import { PaymentModule } from '../payments/payment.module';
import { ReservationModule } from '../reservations/reservation.module';
import { ExpireConsumer } from './expire.consumer';

/**
 * The worker's whole graph. No controllers and no HTTP adapter: an application
 * context, not an application. It reuses ReservationService by plain import
 * rather than by extracting a package, which is why this sub-project adds no
 * build and no second Dockerfile (ADR 0028).
 */
@Module({
  imports: [
    ConfigModule,
    DrizzleModule,
    CatalogModule,
    LockingModule,
    MessagingModule,
    ReservationModule,
    PaymentModule,
  ],
  providers: [ExpireConsumer],
})
export class WorkerModule {}
