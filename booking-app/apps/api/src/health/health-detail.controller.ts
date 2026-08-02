import { Controller, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { OfficeRoute, OfficeSessionGuard } from '../auth/office-session.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';

import { OperationsService } from './operations.service.js';

import type { OperationsSnapshot } from './operations.service.js';

/**
 * `/health/detail` — what is wrong with the machinery, for the people who run it.
 *
 * A controller of its own rather than a third route on HealthController, because
 * that class is `@Public()` at class level and handler metadata does not override a
 * class-level `@Public()` — the route would be reachable by anyone, with only the
 * session guard standing between the public and the business's queue depths. Two
 * controllers on the same path is how Nest expresses "same prefix, different
 * access", and it makes the difference visible at the top of the file rather than
 * in the decorators of one method.
 *
 * `OWNER` and `ADMIN` only, per §10.5: these numbers describe the business, not the
 * work of the person on the treatment table.
 */
@Controller('health')
@OfficeRoute()
@SkipThrottle()
@UseGuards(OfficeSessionGuard, RolesGuard)
export class HealthDetailController {
  constructor(private readonly operations: OperationsService) {}

  @Get('detail')
  @Roles('OWNER', 'ADMIN')
  async detail(): Promise<OperationsSnapshot> {
    return await this.operations.snapshot();
  }
}
