import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../common/guards/public.decorator.js';

/**
 * Liveness only.
 *
 * Deliberately has no injected dependencies and touches neither the database
 * nor Redis: a process supervisor uses this to decide whether to restart, and a
 * transient database outage must not turn into a restart loop. Readiness — which
 * does check dependencies — arrives in Task 11.2.
 *
 * Public and unthrottled, both deliberately. A supervisor's probe carries no
 * credential, and rate-limiting the thing that decides whether to restart the process
 * would turn a traffic spike into an outage.
 */
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
