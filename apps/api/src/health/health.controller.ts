import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  /** Liveness: the process is up. Deliberately touches no dependency. */
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
