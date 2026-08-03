import { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it } from 'vitest';

import {
  MigrationIndicator,
  pendingMigrations,
  shippedMigrationNames,
} from './migration.indicator.js';

import type { MigrationTableReader } from './migration.indicator.js';

/** A reader that answers with a fixed set of applied migration names. */
function readerWith(applied: string[]): MigrationTableReader {
  return {
    $queryRaw: () => Promise.resolve(applied.map((migration_name) => ({ migration_name }))),
  } as unknown as MigrationTableReader;
}

function indicatorFor(applied: string[]): MigrationIndicator {
  return new MigrationIndicator(readerWith(applied), new HealthIndicatorService());
}

describe('pendingMigrations', () => {
  it('names every shipped migration the database has not applied', () => {
    expect(pendingMigrations(['a_init', 'b_constraints', 'c_payload'], ['a_init'])).toEqual([
      'b_constraints',
      'c_payload',
    ]);
  });

  it('is empty when the database has applied everything shipped', () => {
    expect(pendingMigrations(['a_init', 'b_constraints'], ['b_constraints', 'a_init'])).toEqual([]);
  });

  it('ignores an applied migration that is not shipped', () => {
    // The database is ahead of this build — a rollback deploy, mid-rollout. That is not
    // this process failing to be ready; it is a different process being newer.
    expect(pendingMigrations(['a_init'], ['a_init', 'z_from_the_next_release'])).toEqual([]);
  });
});

describe('shippedMigrationNames', () => {
  it('reads the migration directory that ships with the application', () => {
    const shipped = shippedMigrationNames();

    // Named rather than counted: a count would have to change with every migration.
    expect(shipped).toContain('20260731210221_init');
    expect(shipped).toContain('20260731210500_calendar_constraints');
  });

  it('is sorted, so a diagnosis reads in the order the migrations ran', () => {
    const shipped = shippedMigrationNames();

    expect(shipped).toEqual([...shipped].sort());
  });

  it('excludes migration_lock.toml, which is a file rather than a migration', () => {
    expect(shippedMigrationNames()).not.toContain('migration_lock.toml');
  });
});

describe('MigrationIndicator', () => {
  it('is up when every shipped migration is applied', async () => {
    const result = await indicatorFor(shippedMigrationNames()).isHealthy('migrations');

    expect(result).toEqual({
      migrations: { status: 'up', applied: shippedMigrationNames().length },
    });
  });

  it('is down, naming the migration, when one is missing', async () => {
    const applied = shippedMigrationNames().filter(
      (name) => !name.endsWith('_calendar_constraints'),
    );

    const result = await indicatorFor(applied).isHealthy('migrations');

    expect(result).toEqual({
      migrations: { status: 'down', pending: ['20260731210500_calendar_constraints'] },
    });
  });

  it('is down rather than throwing when the migration table cannot be read', async () => {
    const broken = {
      $queryRaw: () => Promise.reject(new Error('relation "_prisma_migrations" does not exist')),
    } as unknown as MigrationTableReader;

    const result = await new MigrationIndicator(broken, new HealthIndicatorService()).isHealthy(
      'migrations',
    );

    // A readiness probe that throws is a 500 with a stack trace instead of an answer.
    expect(result).toEqual({
      migrations: { status: 'down', message: 'The migration table could not be read.' },
    });
  });
});
