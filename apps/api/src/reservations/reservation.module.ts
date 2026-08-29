import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { LockingModule } from '../locking/locking.module';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';

@Module({
  imports: [CatalogModule, LockingModule],
  controllers: [ReservationController],
  providers: [ReservationService],
})
export class ReservationModule {}
