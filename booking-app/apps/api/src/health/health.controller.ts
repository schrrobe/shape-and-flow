import { Controller, Get } from '@nestjs/common';

/**
 * Liveness only.
 *
 * Deliberately has no injected dependencies and touches neither the database
 * nor Redis: a process supervisor uses this to decide whether to restart, and a
 * transient database outage must not turn into a restart loop. Readiness — which
 * does check dependencies — arrives in Task 11.2.
 */
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
