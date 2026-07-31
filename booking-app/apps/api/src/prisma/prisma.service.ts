import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { ENV } from '../config/env.schema.js';

import { PrismaClient } from './client.js';

import type { AppConfig } from '../config/env.schema.js';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

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
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ENV) config: AppConfig) {
    super({
      adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
      log: logLevelsFor(config.LOG_LEVEL),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }
}
