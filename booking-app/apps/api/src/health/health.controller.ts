import { Controller, Get, HttpStatus, Res, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../common/guards/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { MigrationIndicator } from './migration.indicator.js';
import { QueueHealthIndicator } from './queue.indicator.js';

import type { HealthCheckResult } from '@nestjs/terminus';
import type { Response } from 'express';

/**
 * How long `SELECT 1` may take before the database counts as unreachable.
 *
 * Long enough to survive a slow query queue, short enough that a probe answers
 * before the next one arrives.
 */
export const DATABASE_PING_TIMEOUT_MS = 2_000;

/**
 * Liveness and readiness.
 *
 * The two answer different questions and a deployment gets them wrong in opposite
 * directions if they are merged. Liveness decides whether to restart the process:
 * it touches nothing, because a transient database outage must not turn into a
 * restart loop that guarantees the outage. Readiness decides whether to send it
 * traffic: it checks everything the process needs to serve a request, and names
 * whichever dependency is missing.
 *
 * Public and unthrottled, both deliberately. A supervisor's probe carries no
 * credential, and rate-limiting the thing that decides whether to restart the
 * process would turn a traffic spike into an outage. The operational counters,
 * which do describe the business, live behind a session on HealthDetailController.
 */
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly queue: QueueHealthIndicator,
    private readonly migrations: MigrationIndicator,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * 200 with every indicator up, 503 naming the ones that are not.
   *
   * The migration check is here rather than left to the deployment script because
   * the failure it catches is silent: a process whose migration step did not run
   * connects, answers, and then fails on the first request that touches the column
   * it does not have.
   */
  @Get('ready')
  @HealthCheck()
  async ready(@Res({ passthrough: true }) response: Response): Promise<HealthCheckResult> {
    try {
      return await this.health.check([
        () =>
          this.database.pingCheck('database', this.prisma, { timeout: DATABASE_PING_TIMEOUT_MS }),
        () => this.queue.isHealthy('redis'),
        () => this.migrations.isHealthy('migrations'),
      ]);
    } catch (error) {
      // Terminus signals failure by throwing, and the global filter would turn that
      // into the error envelope — a generic 500 body with the indicator names gone,
      // which is the one thing a readiness response is for. Caught here rather than
      // taught to the filter: the envelope is the contract for API clients, and a
      // supervisor's probe is not one.
      if (error instanceof ServiceUnavailableException) {
        response.status(HttpStatus.SERVICE_UNAVAILABLE);
        return error.getResponse() as HealthCheckResult;
      }

      throw error;
    }
  }
}
