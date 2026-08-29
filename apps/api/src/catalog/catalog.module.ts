import { Module } from '@nestjs/common';

import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { SeatGeometryCache } from './seat-geometry.cache';

@Module({
  controllers: [CatalogController],
  providers: [CatalogService, SeatGeometryCache],
  exports: [CatalogService, SeatGeometryCache],
})
export class CatalogModule {}
