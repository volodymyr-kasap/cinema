import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { LockingModule } from '../locking/locking.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';

@Module({
  imports: [CatalogModule, LockingModule, MessagingModule],
  controllers: [ReservationController],
  providers: [ReservationService],
  exports: [ReservationService],
})
export class ReservationModule {}
