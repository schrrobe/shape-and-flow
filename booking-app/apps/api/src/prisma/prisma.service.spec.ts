import { describe, expect, it } from 'vitest';

import { logLevelsFor, PrismaService } from './prisma.service.js';

/**
 * Regression guard for a bug that opened two connection pools.
 *
 * `$extends` returns a proxy that forwards unknown properties to the base
 * client, so a Nest lifecycle hook defined on PrismaService also appears on the
 * tenant-guarded client. Nest then sees the hook on two providers and calls it
 * once each — two `$connect` calls, two pools, and a duplicated log line as the
 * only symptom.
 *
 * Connect and disconnect therefore belong to PrismaLifecycle. If a hook is ever
 * added back to PrismaService, this fails immediately instead of quietly
 * doubling the application's database connections.
 */
const NEST_LIFECYCLE_HOOKS = [
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
] as const;

describe('PrismaService', () => {
  it('defines no Nest lifecycle hook, because $extends would duplicate it', () => {
    const own = Object.getOwnPropertyNames(PrismaService.prototype);

    for (const hook of NEST_LIFECYCLE_HOOKS) {
      expect(own, `${hook} must live on PrismaLifecycle, not PrismaService`).not.toContain(hook);
    }
  });

  it('never enables query logging outside development', () => {
    expect(logLevelsFor('debug', 'development')).toContain('query');
    expect(logLevelsFor('debug', 'test')).not.toContain('query');
    expect(logLevelsFor('debug', 'production')).not.toContain('query');
    expect(logLevelsFor('info', 'development')).not.toContain('query');
  });
});
