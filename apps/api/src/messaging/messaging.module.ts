import { Module } from '@nestjs/common';

import { ExpirePublisher } from './expire.publisher';
import { PaymentPublisher } from './payment.publisher';
import { RabbitModule } from './rabbit.module';

@Module({
  imports: [RabbitModule],
  providers: [ExpirePublisher, PaymentPublisher],
  exports: [ExpirePublisher, PaymentPublisher],
})
export class MessagingModule {}
