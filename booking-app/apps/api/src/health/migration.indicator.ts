import { readdirSync } from 'node:fs';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

import { PrismaService } from '../prisma/prisma.service.js';

import type { HealthIndicatorResult } from '@nestjs/terminus';

/**
 * The migration directory as it ships.
 *
 * Resolved from this module rather than from the working directory: `dist/health/`
 * and `src/health/` are the same two levels below `apps/api`, and the Dockerfile
 * copies `prisma/` into the runtime image beside `dist/`. A `process.cwd()` lookup
 * would work in development and fail in whichever container was started from a
 * different directory.
 */
const MIGRATIONS_DIR = new URL('../../prisma/migrations/', import.meta.url);

/**
 * What this indicator needs from Prisma, and no more.
 *
 * A narrow port rather than the client itself, so the comparison can be tested
 * against a fixed set of applied migrations without a database.
 */
export interface MigrationTableReader {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

interface MigrationRow {
  migration_name: string;
}

let cached: string[] | null = null;

/**
 * The migrations this build carries, sorted.
 *
 * Read once: the directory is baked into the image and cannot change while the
 * process runs, and a readiness probe runs every few seconds.
 */
export function shippedMigrationNames(): string[] {
  cached ??= readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return cached;
}

/**
 * Shipped migrations the database has not applied.
 *
 * The reverse case — applied but not shipped — is deliberately not reported. That
 * is a database ahead of this build, which is what a rollback deploy looks like
 * halfway through, and refusing traffic for it would turn a rollback into an
 * outage.
 */
export function pendingMigrations(
  shipped: readonly string[],
  applied: readonly string[],
): string[] {
  const done = new Set(applied);
  return shipped.filter((name) => !done.has(name));
}

/**
 * Readiness for the schema, not just the connection.
 *
 * A process that can reach Postgres but is running against a schema older than its
 * code fails in a way no connection check sees: a query naming a column that does
 * not exist yet, at whatever hour the first customer hits that path. Comparing the
 * shipped directory against `_prisma_migrations` catches a deploy whose migration
 * step did not run, before the load balancer sends it traffic.
 */
@Injectable()
export class MigrationIndicator {
  private readonly logger = new Logger('MigrationIndicator');

  constructor(
    @Inject(PrismaService) private readonly prisma: MigrationTableReader,
    private readonly health: HealthIndicatorService,
  ) {}

  async isHealthy(key = 'migrations'): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    const shipped = shippedMigrationNames();

    let applied: string[];

    try {
      applied = await this.appliedMigrationNames();
    } catch (error) {
      // Named in the log, generic in the response: a readiness endpoint is reachable
      // from wherever the probe runs, and a Postgres error message describes the
      // schema to whoever asked.
      this.logger.error(
        `could not read _prisma_migrations: ${error instanceof Error ? error.message : String(error)}`,
      );
      return indicator.down({ message: 'The migration table could not be read.' });
    }

    const pending = pendingMigrations(shipped, applied);

    return pending.length === 0
      ? indicator.up({ applied: applied.length })
      : indicator.down({ pending });
  }

  /**
   * Migrations Postgres considers done.
   *
   * `finished_at IS NOT NULL` excludes one that is still running — a concurrent
   * deploy — and `rolled_back_at IS NULL` excludes one that failed and was marked
   * rolled back. Either way the schema is not the one this build expects.
   */
  private async appliedMigrationNames(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<MigrationRow[]>`
      SELECT migration_name
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;

    return rows.map((row) => row.migration_name);
  }
}
