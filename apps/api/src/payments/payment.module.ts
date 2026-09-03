import { Module } from '@nestjs/common';

import { ReservationModule } from '../reservations/reservation.module';
import { PaymentProviderClient } from './payment-provider.client';
import { PaymentService } from './payment.service';

/**
 * Worker-side only. AppModule does NOT import this: the API never calls the
 * provider, so the API image has no reason to hold a client for it. The API's
 * half of payment is the publisher, which lives in MessagingModule.
 */
@Module({
  imports: [ReservationModule],
  providers: [PaymentService, PaymentProviderClient],
  exports: [PaymentService, PaymentProviderClient],
})
export class PaymentModule {}
