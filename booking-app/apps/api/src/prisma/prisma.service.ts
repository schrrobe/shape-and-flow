import { Inject, Injectable } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { ENV } from '../config/env.schema.js';

import { PrismaClient } from './client.js';

import type { AppConfig } from '../config/env.schema.js';

/** Prisma log levels enabled per application log level. */
function logLevelsFor(level: AppConfig['LOG_LEVEL']): ('query' | 'info' | 'warn' | 'error')[] {
  switch (level) {
    case 'trace':
    case 'debug':
      return ['query', 'info', 'warn', 'error'];
    case 'info':
      return ['info', 'warn', 'error'];
    case 'warn':
      return ['warn', 'error'];
    default:
      return ['error'];
  }
}

/**
 * The application's Prisma client.
 *
 * Prisma 7 takes its connection through a driver adapter rather than a URL in
 * the schema, so the pool is constructed here from validated configuration.
 * Owning the `pg` pool explicitly also means the pool size is ours to tune,
 * which matters because the integration suite runs one client per test worker.
 *
 * Deliberately carries NO Nest lifecycle hooks. `$extends` returns a proxy that
 * forwards unknown properties to this instance, so a method named
 * `onModuleInit` here would also appear on the tenant-guarded client — and Nest,
 * seeing the hook on both providers, would call it twice and open two pools.
 * Connect and disconnect therefore live in PrismaLifecycle, which is a plain
 * provider nothing proxies.
 */
@Injectable()
export class PrismaService extends PrismaClient {
  constructor(@Inject(ENV) config: AppConfig) {
    super({
      adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
      log: logLevelsFor(config.LOG_LEVEL),
    });
  }
}
