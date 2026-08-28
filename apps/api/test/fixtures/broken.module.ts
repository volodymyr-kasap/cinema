import { Controller, Get, Module } from '@nestjs/common';

import { ResourceNotFoundError } from '../../src/http/errors';

@Controller('__test')
export class BrokenController {
  @Get('not-found')
  notFound(): never {
    throw new ResourceNotFoundError('Movie', '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60');
  }

  @Get('boom')
  boom(): never {
    throw new Error('a secret internal detail');
  }
}

@Module({ controllers: [BrokenController] })
export class BrokenModule {}
