import { Module } from '@nestjs/common';

import { ExpirePublisher } from './expire.publisher';
import { RabbitModule } from './rabbit.module';

@Module({
  imports: [RabbitModule],
  providers: [ExpirePublisher],
  exports: [ExpirePublisher],
})
export class MessagingModule {}
